// Tam ekran ve yanıp sönme. Report: "Tam ekran yapınca yanıp sönme var". The built app against a real engine with a
// real (headless, test-only) Chrome showing a page that keeps painting, a terminal that keeps printing, the Web
// panel (local https page, native view) and the optional streamed panels, in two project tabs. The window enters
// real macOS full screen (always left again in `finally`), is maximized and resized; meanwhile everything the app
// does is counted: requests to the engine (browser.viewport.set / screencast.start, terminal resize), native view
// moves (WebContentsView.setBounds), frames drawn and blank canvas samples, and the engine's self-heals.
//
// Measured (1920×1080 display at 2×): nothing oscillates — in full screen with nothing changing the app sends no
// size and moves no view; each transition sends one size per visible panel. What did flicker:
// - the window's own background was Electron's white (#FFFFFF): macOS shows it in the strip the page has not painted
//   yet when the window grows (16–20 ms between the window's resize and the page's first frame at the new size) —
//   a white flash on a dark UI at every entry and exit;
// - the engine "healed" the browser once per transition: a frame painted before the new size took effect was taken
//   for "Chrome lost the size", and the size was applied and the stream restarted once more by itself.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import windowDefaults from "../src/main/window.defaults.json" with { type: "json" };
import { defaultUiConfig } from "../src/renderer/ui/config.ts";
import { diagnoseFailures } from "./diagnostics.ts";
import { clickMenu, engineRequest, git, launchApp, launchTerminal, SCREENSHOT_DIR, sleep, startEngine, stopEngine, type EngineHandle } from "./harness.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
/** macOS animates into and out of full screen; the window reports the state when the animation is over. */
const FULL_SCREEN_TIMEOUT_MS = 15_000;
const engineDefaults = JSON.parse(readFileSync(new URL("../../engine/config.defaults.json", import.meta.url), "utf8")) as {
  browser: { viewportHealIntervalMs: number; viewportHealMaxTries: number };
};
/** After a size change: the app's resize debounce, then every self-heal try the engine could make. */
const SETTLE_MS = defaultUiConfig.resizeDebounceMs + (engineDefaults.browser.viewportHealMaxTries + 1) * engineDefaults.browser.viewportHealIntervalMs;
/** How long the window sits still while everything is counted. */
const STILL_MS = 5_000;
/** The engine's log line for a self-heal (packages/engine/src/browser.ts). */
const HEAL_LOG = "browser frame is not the panel's size; applying it again";
/** A live picture draws at least this many frames a second (the page animates; the fake helper streams). */
const MIN_FPS = 5;
const PROJECTS = [
  { id: "bir", name: "Bir" },
  { id: "iki", name: "Iki" },
] as const;
/** Prints a line four times a second, forever: the terminal keeps changing while the window sits still. */
const TERMINAL_COMMAND = "seq 1 300; i=0; while :; do i=$((i+1)); echo tick $i; sleep 0.25; done";

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let server: http.Server | undefined;
let tls: https.Server | undefined;
let pageUrl: string;

diagnoseFailures("fullscreen-flicker", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const tab = (name: string): Locator => page.getByRole("tab", { name, exact: true });

function processes(needle: string): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid);
}

function onWindow(method: "setFullScreen" | "maximize" | "unmaximize" | "setContentSize", ...args: (number | boolean)[]): Promise<void> {
  return app!.evaluate(
    ({ BrowserWindow }, [m, a]) => {
      const win = BrowserWindow.getAllWindows()[0] as unknown as Record<string, (...x: unknown[]) => void>;
      win[m]!(...a);
    },
    [method, args] as const,
  );
}
const isFullScreen = (): Promise<boolean> => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen());

/** Enters macOS full screen; false when this machine does not let the window in (then nothing is left to undo). */
async function enterFullScreen(): Promise<boolean> {
  await onWindow("setFullScreen", true);
  try {
    await expect.poll(isFullScreen, { timeout: FULL_SCREEN_TIMEOUT_MS }).toBe(true);
    return true;
  } catch {
    return false;
  }
}
async function leaveFullScreen(): Promise<void> {
  await onWindow("setFullScreen", false);
  await expect.poll(isFullScreen, { timeout: FULL_SCREEN_TIMEOUT_MS }).toBe(false);
}

/** Counters in the page (installed before the panels mount) and in main. */
async function installCounters(): Promise<void> {
  await page.evaluate(() => {
    const c = { sends: [] as { k: string; d: string }[], draws: {} as Record<string, number>, blank: {} as Record<string, number> };
    (window as unknown as { __counts: typeof c }).__counts = c;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const m = JSON.parse(String(data)) as { type: string; method?: string; params?: Record<string, unknown>; terminalId?: string; cols?: number; rows?: number };
        const p = m.params ?? {};
        if (m.type === "req" && (m.method === "browser.viewport.set" || m.method === "browser.screencast.start")) c.sends.push({ k: m.method, d: String(p.projectId) });
        if (m.type === "resize") c.sends.push({ k: "terminal.resize", d: String(m.terminalId) });
      } catch {
        /* not JSON */
      }
      return send.call(this, data);
    };
    const kind = (canvas: HTMLCanvasElement) => (canvas.classList.contains("kp-browser__canvas") ? "browser" : canvas.closest(".kp-screen") ? "screen" : "other");
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...a: unknown[]) {
      const k = kind(this.canvas);
      c.draws[k] = (c.draws[k] ?? 0) + 1;
      return (draw as (...x: unknown[]) => void).apply(this, a);
    } as typeof draw;
    // Every frame of the window: is a visible picture blank (cleared, nothing drawn)?
    const tick = () => {
      for (const canvas of document.querySelectorAll("canvas")) {
        const k = kind(canvas);
        if (k === "other" || canvas.width < 2 || canvas.getBoundingClientRect().width < 2) continue;
        const px = canvas.getContext("2d")?.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
        if (px && px[3] === 0) c.blank[k] = (c.blank[k] ?? 0) + 1;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await app!.evaluate(({ WebContentsView }) => {
    const g = globalThis as unknown as { __bounds: string[] };
    g.__bounds = [];
    const proto = WebContentsView.prototype as unknown as { setBounds(b: Electron.Rectangle): void };
    const setBounds = proto.setBounds;
    proto.setBounds = function (b) {
      g.__bounds.push(`${b.x},${b.y},${b.width}x${b.height}`);
      return setBounds.call(this, b);
    };
  });
}

interface Counts {
  /** Requests per kind and per project / terminal. */
  sends: Record<string, number>;
  draws: Record<string, number>;
  blank: Record<string, number>;
  bounds: string[];
}
async function resetCounts(): Promise<void> {
  await page.evaluate(() => {
    const c = (window as unknown as { __counts: { sends: unknown[]; draws: object; blank: object } }).__counts;
    c.sends = [];
    c.draws = {};
    c.blank = {};
  });
  await app!.evaluate(() => void ((globalThis as unknown as { __bounds: string[] }).__bounds = []));
}
async function readCounts(): Promise<Counts> {
  const r = await page.evaluate(() => (window as unknown as { __counts: { sends: { k: string; d: string }[]; draws: Record<string, number>; blank: Record<string, number> } }).__counts);
  const sends: Record<string, number> = {};
  for (const s of r.sends) sends[`${s.k} ${s.d}`] = (sends[`${s.k} ${s.d}`] ?? 0) + 1;
  return { sends, draws: r.draws, blank: r.blank, bounds: await app!.evaluate(() => (globalThis as unknown as { __bounds: string[] }).__bounds) };
}

const heals = (): number => (engine?.log().match(new RegExp(HEAL_LOG, "g")) ?? []).length;

/**
 * The window sits still for STILL_MS: every panel reports its size at most once (0 when it already did), no native
 * view moves more than once, the live pictures keep drawing and are never blank.
 */
async function expectStill(label: string, live: readonly ("browser" | "screen")[]): Promise<void> {
  await resetCounts();
  await sleep(STILL_MS);
  const c = await readCounts();
  for (const [what, n] of Object.entries(c.sends)) expect(n, `${label}: ${what} while nothing changes`).toBeLessThanOrEqual(1);
  expect(c.bounds.length, `${label}: native view moves ${JSON.stringify(c.bounds)}`).toBeLessThanOrEqual(1);
  for (const k of live) expect(c.draws[k] ?? 0, `${label}: ${k} frames drawn`).toBeGreaterThanOrEqual((MIN_FPS * STILL_MS) / 1000);
  expect(c.blank, `${label}: blank picture samples`).toEqual({});
}

/** Size changes (enter/leave, maximize, resize): one report per panel per change, and the engine never heals. */
async function expectOneReportEach(label: string, change: () => Promise<void>): Promise<void> {
  const before = heals();
  await resetCounts();
  await change();
  await sleep(SETTLE_MS);
  const c = await readCounts();
  for (const [what, n] of Object.entries(c.sends)) expect(n, `${label}: ${what}`).toBeLessThanOrEqual(1);
  expect(heals() - before, `${label}: engine self-heals`).toBe(0);
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `fullscreen-flicker-${name}.png`) });
}

/** Full screen entered, held still, left — each step measured. Skipped where the machine refuses full screen. */
async function fullScreenRound(label: string, live: readonly ("browser" | "screen")[], skip: (why: string) => void): Promise<void> {
  let entered = false;
  try {
    await expectOneReportEach(`${label}: entering full screen`, async () => {
      entered = await enterFullScreen();
    });
    if (!entered) return skip("this machine did not let the window into macOS full screen");
    // The window's background (what macOS shows before the page paints) is the theme's, not white.
    expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor())).toBe(windowDefaults.backgroundColor.toUpperCase());
    await expectStill(`${label}: in full screen`, live);
    await shot(`${label}-tam-ekran`);
  } finally {
    if (entered || (await isFullScreen().catch(() => false))) {
      await expectOneReportEach(`${label}: leaving full screen`, leaveFullScreen);
    }
  }
  await expectStill(`${label}: after full screen`, live);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-flicker-")));
  const home = join(root, "home");
  mkdirSync(home);
  for (const p of PROJECTS) {
    const repo = join(root, p.id);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "ilk");
  }
  // A page that never stops painting: the browser's screencast keeps sending frames.
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>canli</title><body style="margin:0;height:100vh;background:linear-gradient(135deg,#fde68a,#86efac)">' +
        '<div style="width:80px;height:80px;background:#1d4ed8;animation:s 1s linear infinite alternate"></div><style>@keyframes s{to{transform:translateX(300px)}}</style></body>',
    );
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  // The Web panel's local https page (self-signed, trusted only through the test-only flag).
  const [keyPath, certPath] = [join(root, "key.pem"), join(root, "cert.pem")];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  tls = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><body style="margin:0;background:#246;color:#fff">Web sayfası</body></html>');
  });
  await new Promise<void>((r) => tls!.listen(0, "127.0.0.1", () => r()));
  const siteUrl = `https://127.0.0.1:${(tls.address() as AddressInfo).port}/`;
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      // Test-only: no window and no keychain dialog on the desktop (headless + mock keychain); only the fake helper.
      browser: { headless: true, testMode: true },
      projects: PROJECTS.map((p) => ({ name: p.name, repoPath: join(root, p.id), id: p.id })),
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: home });
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  app = await launchApp({
    KOKPIT_USER_DATA_DIR: join(root, "user-data"),
    KOKPIT_TEST_WEB_TRUST_HOST: "127.0.0.1",
    KOKPIT_TEST_WEB_SITES: JSON.stringify([{ id: "home", title: "Ana sayfa", url: siteUrl }]),
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await installCounters();
}, 120_000);

afterAll(async () => {
  try {
    // Never leave a window in full screen, whatever a step did.
    if (app && (await isFullScreen().catch(() => false))) await leaveFullScreen().catch(() => {});
  } finally {
    await app?.close().catch(() => {});
    await stopEngine(engine);
    for (const pid of root ? processes(root) : []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await new Promise<void>((r) => (tls ? tls.close(() => r()) : r()));
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("tam ekran: nothing blinks — no size ping-pong, no white flash, no self-heal fight", () => {
  it("1. two projects, each with Dosyalar, a live Tarayıcı, Ajanlar and a printing Terminal; the window is dark from the start", async () => {
    expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor())).toBe(windowDefaults.backgroundColor.toUpperCase());
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await rail().waitFor({ timeout: UI_TIMEOUT_MS });
    for (const p of [...PROJECTS].reverse()) {
      await rail().getByRole("button", { name: p.name, exact: true }).click();
      await expect.poll(() => page.locator(".kp-ptab--active").textContent(), { timeout: UI_TIMEOUT_MS }).toContain(p.name);
      await tab("Tarayıcı").click();
      const browser = page.locator("section.kp-browser");
      await browser.getByRole("button", { name: "Tarayıcıyı aç" }).click();
      await expect.poll(async () => Number((await browser.locator("canvas").getAttribute("data-frames")) ?? "0"), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
      const address = browser.getByLabel("Adres");
      await address.fill(pageUrl);
      await address.press("Enter");
      await launchTerminal(page, TERMINAL_COMMAND);
      await expect.poll(() => page.getByRole("region", { name: `Terminal: ${TERMINAL_COMMAND}` }).textContent(), { timeout: UI_TIMEOUT_MS }).toContain("tick");
    }
    await sleep(SETTLE_MS);
    await expectStill("window, Tarayıcı", ["browser"]);
  });

  it("2. full screen with Tarayıcı in front: one size per panel to enter and to leave, then silence; frames keep coming", async (ctx) => {
    await fullScreenRound("tarayici", ["browser"], (why) => ctx.skip(why));
  });

  it("3. the Web panel (native view) in front: it moves once per change, never while the window sits still", async (ctx) => {
    await clickMenu(app!, ["Görünüm", "Web"]);
    await tab("Web").click();
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.filter((v) => (v as unknown as { getVisible(): boolean }).getVisible()).length), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await sleep(SETTLE_MS);
    await expectStill("window, Web", []);
    await fullScreenRound("web", [], (why) => ctx.skip(why));
  });


  it("5. the second project's tab, Tarayıcı in front: the same in full screen", async (ctx) => {
    await page.getByRole("toolbar", { name: "Proje sekmeleri" }).getByRole("button", { name: PROJECTS[1].name, exact: true }).click();
    await tab("Tarayıcı").click();
    await sleep(SETTLE_MS);
    await expectStill("window, second project", ["browser"]);
    await fullScreenRound("ikinci-proje", ["browser"], (why) => ctx.skip(why));
  });

  it("6. maximized, then 1920×1080-ish, then back: one size per panel per change, then silence", async () => {
    await expectOneReportEach("maximize", () => onWindow("maximize"));
    await expectStill("maximized", ["browser"]);
    await expectOneReportEach("unmaximize", () => onWindow("unmaximize"));
    const display = await app!.evaluate(({ BrowserWindow, screen }) => screen.getDisplayMatching(BrowserWindow.getAllWindows()[0]!.getBounds()).workArea);
    await expectOneReportEach("large window", () => onWindow("setContentSize", Math.min(1920, display.width), Math.min(1080, display.height) - 40));
    await expectStill("large window", ["browser"]);
    await shot("buyuk-pencere");
  });
});
