// "Tarayıcı HER ZAMAN panele sığsın" end-to-end: the built app against a real engine with a real (headless,
// test-only) Chrome and a local test page. At every step the picture must lie inside its panel (no scrollbars, no
// clipping), the page's layout viewport must be the panel's picture area ÷ zoom, and a click must land exactly.
// Before the fix the picture was as wide as the panel and as tall as Chrome's window made it: 934×520 in a
// 934×271 panel at a 1900×600 window, 945×526 in a 945×482 panel at 1920×1080.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultUiConfig } from "../src/renderer/ui/config.ts";
import { clickMenu, ENGINE_DIR, engineRequest, git, launchApp, SCREENSHOT_DIR, sleep, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures, FAILURE_DIR } from "./diagnostics.ts";
import { chromeProbe, startBrowserTrace, watchBrowserPage } from "./browser-trace.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
const engineDefaults = JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as {
  browser: { projectName: string; profilesDirName: string; windowWidth: number; windowHeight: number };
};
/** The texts moved to the catalogs (i18n); these tests run the app in Turkish. */
const trCatalog = (area: string) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/tr/${area}.json`, import.meta.url), "utf8"));
const MENU = (trCatalog("main") as { menu: Record<string, string> }).menu;
/** A command of the native Görünüm menu, by its key in menu.defaults.json. */
const viewMenu = (key: string): Promise<void> => clickMenu(app!, [MENU.view!, MENU[key]!]);
/** Görünüm's check item of a panel (opens / closes it). */
const togglePanel = (title: string): Promise<void> => clickMenu(app!, [MENU.view!, title]);
const FIRST = engineDefaults.browser.projectName;
const REPO_PROJECT = "Depo";
const REPO_ID = "depo";
const CARD = "sigma-karti";
/** The click target of the test page: [left, top, width, height] in page CSS px — small, so a miss shows. */
const TARGET = [220, 130, 60, 30] as const;
/** Slack for whole-pixel rounding (CSS px). */
const PX = 1.5;

/** The configured default zoom and its neighbours in the configured levels (`n` steps up or down, clamped). */
const ZOOM = defaultUiConfig.browserZoom;
const zoomStep = (from: number, n: number): number => {
  const levels = defaultUiConfig.browserZoomLevels;
  return levels[Math.min(levels.length - 1, Math.max(0, levels.indexOf(from) + n))]!;
};

let root: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

let trace: ReturnType<typeof startBrowserTrace> | undefined;
/** Engine log lines about the browser (the report's log tail is mostly connection noise from the polls). */
const ENGINE_BROWSER_LINES = 200;
const REPORT_NAME_CHARS = 100;
const REPORT_TIMEOUT_MS = 60_000;
const SERVED_LINES = 50;
const SERVER_PROBE_MS = 2_000;
/** Requests the test page server received (time, path): for a failure report. */
const served: string[] = [];
diagnoseFailures("browser-fit", () => ({ app, page, engine }));
/**
 * Beside the standard report: the app's browser.* requests and answers, the page's visibility, the engine's
 * browser log lines and a probe of each project's Chrome over its own DevTools port. A file of its own, outside
 * the standard report's time budget: under load the probe and the page take longer than that.
 */
afterEach(async (ctx) => {
  if (ctx.task.result?.state !== "fail") return;
  const report = {
    at: new Date().toISOString(),
    browserTrace: (await trace?.read())?.map((e) => `${e.at} ${e.dir} ${e.text}`),
    engineBrowserLog: engine
      ?.log()
      .split("\n")
      .filter((l) => /browser|cdp|screencast|viewport|zoom/i.test(l))
      .slice(-ENGINE_BROWSER_LINES),
    served: served.slice(-SERVED_LINES),
    serverAnswers: await fetch(`http://127.0.0.1:${port}/probe`, { signal: AbortSignal.timeout(SERVER_PROBE_MS) }).then((r) => r.status, (e: unknown) => String(e)),
    chrome: root
      ? Object.fromEntries(await Promise.all([firstId, REPO_ID].map(async (id) => [id, devtoolsPort(id) ? await chromeProbe(devtoolsPort(id)!, `http://127.0.0.1:${port}/fresh-tab`) : "(not running)"] as const)))
      : undefined,
  };
  mkdirSync(FAILURE_DIR, { recursive: true });
  const name = `browser-fit-${ctx.task.name}`.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, REPORT_NAME_CHARS);
  writeFileSync(join(FAILURE_DIR, `${name}.browser.json`), `${JSON.stringify(report, null, 2)}\n`);
}, REPORT_TIMEOUT_MS);
beforeEach((ctx) => trace?.note(`step: ${ctx.task.name}`));
let server: http.Server;
let port: number;
let firstId: string;

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const projectTab = (name: string): Locator => page.getByRole("toolbar", { name: "Proje sekmeleri" }).getByRole("button", { name, exact: true });
const browser = (): Locator => page.locator("section.kp-browser");
const frames = async (): Promise<number> => Number((await browser().locator("canvas").getAttribute("data-frames")) ?? "0");

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `browser-fit-${name}.png`) });
}

interface PageInfo {
  width: number;
  height: number;
  path: string;
  clicks: number;
}
/** What the page itself reports in its title: its layout viewport, its path and how often the target was clicked. */
async function pageInfo(projectId: string): Promise<PageInfo | null> {
  const { browser: s } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as {
    browser: { activeTabId?: string; tabs: { id: string; title: string }[] };
  };
  const m = /^(\d+)x(\d+) (\S+) c(\d+)$/.exec(s.tabs.find((t) => t.id === s.activeTabId)?.title ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]), path: m[3]!, clicks: Number(m[4]) } : null;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Measure {
  /** The dock panel: what it can show and what it would have to scroll. */
  dock: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number };
  dockRect: Rect;
  view: Rect;
  canvas: Rect;
  /** Pixel size of the drawn frame. */
  frame: { width: number; height: number };
  zoom: number;
  /** The middle pixel of the picture is not black (a frame is really drawn). */
  lit: boolean;
}
const measure = (): Promise<Measure | null> =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".kp-browser__canvas");
    const dock = canvas?.closest<HTMLElement>(".kp-dock-panel");
    if (!canvas || !dock) return null;
    const view = canvas.parentElement!;
    const rect = (e: Element) => {
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const px = canvas.getContext("2d")?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return {
      dock: { clientWidth: dock.clientWidth, clientHeight: dock.clientHeight, scrollWidth: dock.scrollWidth, scrollHeight: dock.scrollHeight },
      dockRect: rect(dock),
      view: rect(view),
      canvas: rect(canvas),
      frame: { width: canvas.width, height: canvas.height },
      zoom: Number(view.getAttribute("data-zoom")),
      lit: px !== undefined && px[0]! + px[1]! + px[2]! > 150,
    };
  });

const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - PX && inner.y >= outer.y - PX && inner.x + inner.width <= outer.x + outer.width + PX && inner.y + inner.height <= outer.y + outer.height + PX;

/** Everything that is wrong with the picture right now ([] = it fits and the page has the panel's size). */
async function problems(projectId: string): Promise<string[]> {
  const m = await measure();
  const p = await pageInfo(projectId);
  if (!m) return ["no canvas"];
  if (!p) return ["the page reports no size"];
  const out: string[] = [];
  const { dock, view, canvas, frame, zoom } = m;
  const r = Math.round;
  const where = `panel ${dock.clientWidth}x${dock.clientHeight}, area ${r(view.width)}x${r(view.height)}, canvas ${r(canvas.width)}x${r(canvas.height)}, frame ${frame.width}x${frame.height}, page ${p.width}x${p.height}, zoom ${zoom}`;
  if (dock.scrollHeight > dock.clientHeight || dock.scrollWidth > dock.clientWidth) out.push(`the panel scrolls (${dock.scrollWidth}x${dock.scrollHeight})`);
  if (!inside(view, m.dockRect)) out.push("the picture area leaves the panel");
  if (!inside(canvas, view)) out.push("the picture leaves its area");
  // The page is laid out for the picture area ÷ zoom…
  if (Math.abs(p.width - view.width / zoom) > PX || Math.abs(p.height - view.height / zoom) > PX) out.push("the page viewport is not the panel ÷ zoom");
  // …so the picture fills the area (no letterbox once settled).
  if (view.width - canvas.width > 2 * PX || view.height - canvas.height > 2 * PX) out.push("the picture does not fill its area");
  if (!m.lit) out.push("the picture is black");
  return out.map((o) => `${o} — ${where}`);
}

async function expectFits(projectId: string, label: string): Promise<Measure> {
  await expect.poll(() => problems(projectId), { timeout: UI_TIMEOUT_MS, message: label }).toEqual([]);
  // Still true a moment later (nothing is about to undo it).
  await sleep(400);
  expect(await problems(projectId), `${label} (settled)`).toEqual([]);
  return (await measure())!;
}

const setWindow = async (width: number, height: number): Promise<void> => {
  await app!.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setSize(s.width, s.height), { width, height });
  await expect.poll(() => page.evaluate(() => innerWidth), { timeout: UI_TIMEOUT_MS }).toBe(width);
};

async function navigate(path: string): Promise<void> {
  const address = browser().getByLabel("Adres");
  await address.fill(`http://127.0.0.1:${port}${path}`);
  await address.press("Enter");
}

/** Clicks the page's target through the picture: page px → canvas px, as a user aiming at it would. */
async function clickTarget(projectId: string): Promise<void> {
  const m = (await measure())!;
  const p = (await pageInfo(projectId))!;
  const x = m.canvas.x + ((TARGET[0] + TARGET[2] / 2) * m.canvas.width) / p.width;
  const y = m.canvas.y + ((TARGET[1] + TARGET[3] / 2) * m.canvas.height) / p.height;
  await page.mouse.click(x, y);
  await expect.poll(async () => (await pageInfo(projectId))?.clicks, { timeout: UI_TIMEOUT_MS, message: `click at ${Math.round(x)},${Math.round(y)}` }).toBe(p.clicks + 1);
}

function processes(needle: string): { pid: number; command: string }[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), command: l }))
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.pid !== process.pid);
}

/** The DevTools port of the project's Chrome (from its command line), if it runs. */
function devtoolsPort(projectId: string): number | undefined {
  const profile = join(root, "data", engineDefaults.browser.profilesDirName, projectId);
  const main = processes(`--user-data-dir=${profile}`).find((p) => !p.command.includes("--type="));
  const port = Number(/--remote-debugging-port=(\d+)/.exec(main?.command ?? "")?.[1]);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/** Resizes the project's Chrome window behind Kokpit's back (as the user or macOS would), over its DevTools port. */
async function resizeChromeWindow(projectId: string, width: number, height: number): Promise<void> {
  const base = `http://127.0.0.1:${devtoolsPort(projectId)}`;
  const version = (await (await fetch(`${base}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const targets = (await (await fetch(`${base}/json/list`)).json()) as { id: string; type: string }[];
  const targetId = targets.find((t) => t.type === "page")!.id;
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("devtools socket failed")));
  });
  let seq = 0;
  const call = <T,>(method: string, params: Record<string, unknown>): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const onMessage = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as { id?: number; result?: T; error?: { message: string } };
        if (msg.id !== id) return;
        ws.removeEventListener("message", onMessage);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result as T);
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    const { windowId } = await call<{ windowId: number }>("Browser.getWindowForTarget", { targetId });
    await call("Browser.setWindowBounds", { windowId, bounds: { width, height } });
  } finally {
    ws.close();
  }
}

async function openApp(): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  trace = startBrowserTrace(page);
  await page.waitForLoadState("domcontentloaded");
  await watchBrowserPage(page);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-fit-")));
  const repo = join(root, "depo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "ilk");
  server = http.createServer((req, res) => {
    served.push(`${new Date().toISOString()} ${req.url ?? ""}`);
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/[^A-Za-z0-9/_-]/g, "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // The title carries the layout viewport (live), the path and the number of clicks on the target.
    res.end(`<!doctype html><meta charset="utf-8"><title>…</title>
<body style="margin:0;height:100vh;box-sizing:border-box;border:6px solid #c00;background:linear-gradient(135deg,#fde68a,#86efac);font:32px sans-serif">
<h1 style="margin:16px">Kokpit ${path}</h1>
<button id="t" style="position:absolute;left:${TARGET[0]}px;top:${TARGET[1]}px;width:${TARGET[2]}px;height:${TARGET[3]}px;border:0;padding:0;background:#1d4ed8"></button>
<script>let c=0;const t=()=>{document.title=innerWidth+"x"+innerHeight+" "+location.pathname+" c"+c};t();addEventListener("resize",t);
document.getElementById("t").addEventListener("click",()=>{c++;t()});</script></body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;

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
      // Test-only: no window and no keychain dialog on the desktop (headless + mock keychain).
      browser: { headless: true, testMode: true },
      projects: [{ name: REPO_PROJECT, repoPath: repo, id: REPO_ID }],
    }),
  );
  engine = await startEngine(configPath, KEY);
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const { projects } = (await engineRequest(engine.url, KEY, "projects.list", {})) as { projects: { id: string; name: string }[] };
  firstId = projects.find((p) => p.name === FIRST)!.id;
  userDataDir = join(root, "user-data");
  mkdirSync(userDataDir, { recursive: true });
  await openApp();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (root) {
    for (const { pid } of processes(root)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Tarayıcı her zaman panele sığar", () => {
  it("0. opening the browser: the picture fills its panel and the page is laid out for it (panel ÷ the default zoom)", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await expect.poll(() => rail().getByRole("button", { name: FIRST, exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await rail().getByRole("button", { name: FIRST, exact: true }).click();
    await browser().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await navigate("/a");
    const m = await expectFits(firstId, "after opening");
    expect(m.zoom).toBe(ZOOM);
    // Not Chrome's window size any more.
    expect((await pageInfo(firstId))!.width).not.toBe(Math.round(engineDefaults.browser.windowWidth / ZOOM));
    await shot("00-open");
  });

  it("1. a click on the scaled picture lands exactly on a small target", async () => {
    await clickTarget(firstId);
  });

  for (const [width, height] of [
    [1920, 1080],
    [1900, 600],
    [1000, 1000],
    [1440, 900],
  ] as const) {
    it(`2. window ${width}x${height}: the picture still fits (no scrollbars, nothing cut off) and clicks stay exact`, async () => {
      await setWindow(width, height);
      await expectFits(firstId, `window ${width}x${height}`);
      await clickTarget(firstId);
      await shot(`02-window-${width}x${height}`);
    });
  }

  it("3. quick resizes back and forth settle on the last size", async () => {
    for (const [w, h] of [
      [1500, 700],
      [1100, 950],
      [1800, 640],
      [1250, 820],
      [1440, 900],
    ] as const) {
      await app!.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setSize(s.width, s.height), { width: w, height: h });
      await sleep(40);
    }
    await expectFits(firstId, "after quick resizes");
  });

  it("4. Chrome's own window is resized behind Kokpit's back: the page keeps the panel's size", async () => {
    const before = (await pageInfo(firstId))!;
    await resizeChromeWindow(firstId, engineDefaults.browser.windowWidth + 500, engineDefaults.browser.windowHeight + 300);
    await sleep(600);
    const after = (await pageInfo(firstId))!;
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    await expectFits(firstId, "after Chrome's window changed");
    await clickTarget(firstId);
  });

  it("5. while the panel is a background dock tab nothing is pushed; shown again it fits the new size", async () => {
    await togglePanel("Harita");
    await expect.poll(() => page.locator(".kp-browser__canvas").count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    const hiddenAt = (await pageInfo(firstId))!;
    await setWindow(1700, 1000);
    await sleep(800);
    // The page an agent may be driving did not change size while nobody looked at it.
    const still = (await pageInfo(firstId))!;
    expect([still.width, still.height]).toEqual([hiddenAt.width, hiddenAt.height]);
    await page.getByRole("tab", { name: "Tarayıcı", exact: true }).click();
    await expectFits(firstId, "shown again after a resize while hidden");
    expect((await pageInfo(firstId))!.width).not.toBe(hiddenAt.width);
    await clickTarget(firstId);
    await togglePanel("Harita");
    await setWindow(1440, 900);
    await expectFits(firstId, "back at 1440x900");
  });

  it("6. two quick zoom steps end on the last one: page and state agree, then back to the default", async () => {
    await viewMenu("browserZoomIn");
    await viewMenu("browserZoomIn");
    const m = await expectFits(firstId, "after two quick zoom steps");
    expect(m.zoom).toBe(zoomStep(ZOOM, 2));
    expect(await browser().getByRole("alert").count()).toBe(0);
    await clickTarget(firstId);
    await shot("06-zoom-two-steps");
    await viewMenu("browserZoomOut");
    await viewMenu("browserZoomOut");
    await viewMenu("browserZoomOut");
    await viewMenu("browserZoomIn");
    expect((await expectFits(firstId, "after more quick zoom steps")).zoom).toBe(zoomStep(zoomStep(zoomStep(ZOOM, 2), -3), 1));
    expect(await browser().getByRole("alert").count()).toBe(0);
    await clickTarget(firstId);
  });

  it("7. a second project with another layout: each project's page follows its own panel, also when switching fast", async () => {
    await rail().getByRole("button", { name: REPO_PROJECT, exact: true }).click();
    await browser().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await navigate("/depo");
    // Its own layout (Ajanlar closed): its Tarayıcı panel has another size than the first project's.
    await togglePanel("Ajanlar");
    const wide = await expectFits(REPO_ID, "second project");
    await projectTab(FIRST).click();
    const narrow = await expectFits(firstId, "back in the first project");
    // The two panels really differ in size.
    expect(Math.abs(wide.view.width - narrow.view.width)).toBeGreaterThan(50);
    for (let i = 0; i < 3; i++) {
      await projectTab(REPO_PROJECT).click();
      await projectTab(FIRST).click();
    }
    await expectFits(firstId, "first project after fast switching");
    await projectTab(REPO_PROJECT).click();
    await expectFits(REPO_ID, "second project after fast switching");
    await clickTarget(REPO_ID);
    await shot("07-second-project");
  });

  it("8. selecting a card: the picture comes back by itself (not black) and fits", async () => {
    await rail().getByRole("button", { name: `Yeni kart: ${REPO_PROJECT}` }).click();
    await rail().getByLabel("Kart adı").fill(CARD);
    await rail().getByRole("button", { name: "Oluştur" }).click();
    await expect.poll(() => page.locator(".kp-cardbar").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expectFits(REPO_ID, "after selecting a card");
    await clickTarget(REPO_ID);
    await shot("08-card");
  });

  it("9. after a relaunch at another window size the picture fits again without touching anything", async () => {
    await app!.close();
    app = undefined;
    await openApp();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await expectFits(REPO_ID, "after relaunch");
    await setWindow(1300, 760);
    await expectFits(REPO_ID, "after relaunch, resized");
    await clickTarget(REPO_ID);
    await shot("09-relaunched");
  });
});
