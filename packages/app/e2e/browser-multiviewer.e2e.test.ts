// "Tarayıcının içinde yakınlaştırmama rağmen sonradan uzaklaştırıyor!" end-to-end: TWO built apps (the user's
// MacBook app "A" and a second app "B" left open on the engine machine, each with its own userData) against one
// real engine with a real (headless, test-only) Chrome and a local test page. A has an old stored zoom of its own
// (%100); B has none (it would show the default %67) and a window of another size.
// Before the fix every app kept its own zoom and pushed it — and its panel's size — whenever its panel started,
// reconnected, was shown or focused: B kept zooming A's page back out and resizing it.
// Now the zoom is the project's (engine-owned: A's old copy is handed over once, B just shows it) and the page's
// size follows the panel whose user last used it; the other app fits the frames it gets and still clicks exactly.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultUiConfig } from "../src/renderer/ui/config.ts";
import { clickMenu, ENGINE_DIR, engineRequest, git, launchApp, SCREENSHOT_DIR, sleep, startEngine, stopEngine, type EngineHandle } from "./harness.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
const UI_STATE_FILE = "ui-state.json";
const engineDefaults = JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as {
  browser: { projectName: string; defaultZoom: number; viewportHealIntervalMs: number };
};
/** The texts moved to the catalogs (i18n); these tests run the app in Turkish. */
const trCatalog = (area: string) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/tr/${area}.json`, import.meta.url), "utf8"));
const MENU = (trCatalog("main") as { menu: Record<string, string> }).menu;
const FIRST = engineDefaults.browser.projectName;
/** A second project, to leave the first one's panel and come back. */
const REPO_PROJECT = "Depo";
/** The click target of the test page: [left, top, width, height] in page CSS px — small, so a miss shows. */
const TARGET = [220, 130, 60, 30] as const;
/** Slack for whole-pixel rounding (CSS px). */
const PX = 1.5;
const LEVELS = defaultUiConfig.browserZoomLevels;
/** What the user had chosen on the MacBook (stored by the old app in its own UI state). */
const USER_ZOOM = 1;
const nextLevel = (from: number): number => LEVELS[LEVELS.indexOf(from) + 1]!;
/** After this long without input a window counts as unattended (plus slack). */
const UNATTENDED_MS = defaultUiConfig.browserInteractionMs + 500;
/** How long "nothing happens" is watched: several self-heal intervals of the engine. */
const IDLE_MS = 6 * engineDefaults.browser.viewportHealIntervalMs;

interface Inst {
  name: "A" | "B";
  userDataDir: string;
  window: { width: number; height: number };
  app?: ElectronApplication;
  page?: Page;
}

let root: string;
let configPath: string;
let engine: EngineHandle | undefined;
let server: http.Server;
let port: number;
let projectId: string;
const A: Inst = { name: "A", userDataDir: "", window: { width: 1400, height: 900 } };
const B: Inst = { name: "B", userDataDir: "", window: { width: 1100, height: 700 } };

const pg = (i: Inst): Page => i.page!;
const rail = (i: Inst) => pg(i).getByRole("navigation", { name: "Kokpit" });
const projectTab = (i: Inst, name: string) => pg(i).getByRole("toolbar", { name: "Proje sekmeleri" }).getByRole("button", { name, exact: true });
const browser = (i: Inst) => pg(i).locator("section.kp-browser");
const frames = async (i: Inst): Promise<number> => Number((await browser(i).locator("canvas").getAttribute("data-frames").catch(() => null)) ?? "0");
const viewAttr = (i: Inst, name: string) => pg(i).locator(".kp-browser__view").getAttribute(name);
const shownZoom = async (i: Inst): Promise<number> => Number(await viewAttr(i, "data-zoom"));
const drives = async (i: Inst): Promise<boolean> => (await viewAttr(i, "data-viewport-owner")) === "true";
const shot = (i: Inst, name: string) => pg(i).screenshot({ path: join(SCREENSHOT_DIR, `browser-multiviewer-${name}-${i.name}.png`) });

interface PageInfo {
  width: number;
  height: number;
  path: string;
  clicks: number;
  resizes: number;
}
/** What the page itself reports in its title: its layout viewport, its path, clicks on the target, resize events. */
async function pageInfo(): Promise<PageInfo | null> {
  const { browser: s } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as {
    browser: { activeTabId?: string; tabs: { id: string; title: string }[] };
  };
  const m = /^(\d+)x(\d+) (\S+) c(\d+) r(\d+)$/.exec(s.tabs.find((t) => t.id === s.activeTabId)?.title ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]), path: m[3]!, clicks: Number(m[4]), resizes: Number(m[5]) } : null;
}
const engineZoom = async (): Promise<number | undefined> =>
  ((await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as { browser: { zoom?: number } }).browser.zoom;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Measure {
  dock: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number };
  view: Rect;
  canvas: Rect;
  zoom: number;
  /** The middle pixel of the picture is not black (a frame is really drawn). */
  lit: boolean;
}
const measure = (i: Inst): Promise<Measure | null> =>
  pg(i).evaluate(() => {
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
      view: rect(view),
      canvas: rect(canvas),
      zoom: Number(view.getAttribute("data-zoom")),
      lit: px !== undefined && px[0]! + px[1]! + px[2]! > 150,
    };
  });

const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - PX && inner.y >= outer.y - PX && inner.x + inner.width <= outer.x + outer.width + PX && inner.y + inner.height <= outer.y + outer.height + PX;

/**
 * Everything that is wrong with `i`'s picture ([] = fine). Always: the picture lies inside its panel, nothing
 * scrolls, a frame is drawn. `driving`: the page is laid out for THIS panel (area ÷ zoom) and the picture fills
 * it. Not driving: the page is laid out for the other app's panel and this one shows all of it (letterboxed).
 */
async function problems(i: Inst, driving: boolean): Promise<string[]> {
  const m = await measure(i);
  const p = await pageInfo();
  if (!m) return [`${i.name}: no canvas`];
  if (!p) return ["the page reports no size"];
  const out: string[] = [];
  const { dock, view, canvas, zoom } = m;
  const r = Math.round;
  const where = `${i.name}: area ${r(view.width)}x${r(view.height)}, canvas ${r(canvas.width)}x${r(canvas.height)}, page ${p.width}x${p.height}, zoom ${zoom}`;
  if (dock.scrollHeight > dock.clientHeight || dock.scrollWidth > dock.clientWidth) out.push("the panel scrolls");
  if (!inside(canvas, view)) out.push("the picture leaves its area");
  if (!m.lit) out.push("the picture is black");
  if ((await drives(i)) !== driving) out.push(driving ? "the panel does not drive the page" : "the panel drives the page");
  const mine = Math.abs(p.width - view.width / zoom) <= PX && Math.abs(p.height - view.height / zoom) <= PX;
  if (driving && !mine) out.push("the page viewport is not this panel ÷ zoom");
  if (driving && (view.width - canvas.width > 2 * PX || view.height - canvas.height > 2 * PX)) out.push("the picture does not fill its area");
  // The whole page is shown in its own shape, as large as the area allows.
  if (Math.abs(canvas.width / canvas.height - p.width / p.height) > 0.02) out.push("the picture does not have the page's shape");
  if (view.width - canvas.width > 2 * PX && view.height - canvas.height > 2 * PX) out.push("the picture is smaller than its area in both directions");
  return out.map((o) => `${o} — ${where}`);
}

async function expectPicture(i: Inst, driving: boolean, label: string): Promise<void> {
  await expect.poll(() => problems(i, driving), { timeout: UI_TIMEOUT_MS, message: `${i.name}: ${label}` }).toEqual([]);
  // Still true a moment later (nothing is about to undo it).
  await sleep(400);
  expect(await problems(i, driving), `${i.name}: ${label} (settled)`).toEqual([]);
}

/** Clicks the page's target through `i`'s picture: page px → canvas px, as a user aiming at it would. */
async function clickTarget(i: Inst): Promise<void> {
  const m = (await measure(i))!;
  const p = (await pageInfo())!;
  const x = m.canvas.x + ((TARGET[0] + TARGET[2] / 2) * m.canvas.width) / p.width;
  const y = m.canvas.y + ((TARGET[1] + TARGET[3] / 2) * m.canvas.height) / p.height;
  await pg(i).mouse.click(x, y);
  await expect.poll(async () => (await pageInfo())?.clicks, { timeout: UI_TIMEOUT_MS, message: `${i.name} clicks at ${Math.round(x)},${Math.round(y)}` }).toBe(p.clicks + 1);
}

async function navigate(i: Inst, path: string): Promise<void> {
  const address = browser(i).getByLabel("Adres");
  await address.fill(`http://127.0.0.1:${port}${path}`);
  await address.press("Enter");
  await expect.poll(async () => (await pageInfo())?.path, { timeout: UI_TIMEOUT_MS }).toBe(path);
}

const uiState = (i: Inst): { panels?: Record<string, Record<string, Record<string, unknown>>> } => {
  try {
    return JSON.parse(readFileSync(join(i.userDataDir, UI_STATE_FILE), "utf8"));
  } catch {
    return {};
  }
};
const storedZoom = (i: Inst): unknown => uiState(i).panels?.browser?.[`project:${projectId}`]?.zoom;

async function launch(i: Inst): Promise<void> {
  i.app = await launchApp({ KOKPIT_USER_DATA_DIR: i.userDataDir });
  i.page = await i.app.firstWindow();
  await i.page.waitForLoadState("domcontentloaded");
  await i.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setSize(s.width, s.height), i.window);
  // (Runs in beforeAll, where expect.poll is not available.)
  const deadline = Date.now() + UI_TIMEOUT_MS;
  while ((await pg(i).evaluate(() => innerWidth)) !== i.window.width) {
    if (Date.now() > deadline) throw new Error(`${i.name}: the window did not become ${i.window.width} px wide`);
    await sleep(50);
  }
}

/** Connects, selects the browser project and waits for its Tarayıcı panel. */
async function connect(i: Inst): Promise<void> {
  await pg(i).getByLabel("Motor adresi").fill(engine!.url);
  await pg(i).getByLabel("Anahtar").fill(KEY);
  await pg(i).getByRole("button", { name: "Bağlan" }).click();
  await expect.poll(() => rail(i).getByRole("button", { name: FIRST, exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
  await rail(i).getByRole("button", { name: FIRST, exact: true }).click();
}

/**
 * Nobody is at `i`: its last input is long ago and its window is not the one in front. Which window macOS keeps
 * in front cannot be arranged on a shared desktop (two apps, other tests running), so the window is told so.
 */
async function unattended(i: Inst): Promise<void> {
  await sleep(UNATTENDED_MS);
  await pg(i).evaluate(() => {
    document.hasFocus = () => false;
  });
}

function processes(needle: string): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-multiviewer-")));
  const repo = join(root, "depo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "ilk");
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/[^A-Za-z0-9/_-]/g, "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // The title carries the layout viewport (live), the path, the clicks on the target and the resize events.
    res.end(`<!doctype html><meta charset="utf-8"><title>…</title>
<body style="margin:0;height:100vh;box-sizing:border-box;border:6px solid #c00;background:linear-gradient(135deg,#fde68a,#86efac);font:32px sans-serif">
<h1 style="margin:16px">Kokpit ${path}</h1>
<button id="t" style="position:absolute;left:${TARGET[0]}px;top:${TARGET[1]}px;width:${TARGET[2]}px;height:${TARGET[3]}px;border:0;padding:0;background:#1d4ed8"></button>
<script>let c=0,r=0;const t=()=>{document.title=innerWidth+"x"+innerHeight+" "+location.pathname+" c"+c+" r"+r};t();addEventListener("resize",()=>{r++;t()});
document.getElementById("t").addEventListener("click",()=>{c++;t()});</script></body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;

  configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(root, "data"),
      // A fixed port: both apps must find the engine again after it restarts.
      port: await freePort(),
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      // Test-only: no window and no keychain dialog on the desktop (headless + mock keychain).
      browser: { headless: true, testMode: true },
      projects: [{ name: REPO_PROJECT, repoPath: repo, id: "depo" }],
    }),
  );
  engine = await startEngine(configPath, KEY);
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const { projects } = (await engineRequest(engine.url, KEY, "projects.list", {})) as { projects: { id: string; name: string }[] };
  projectId = projects.find((p) => p.name === FIRST)!.id;
  for (const i of [A, B]) {
    i.userDataDir = join(root, `user-data-${i.name}`);
    mkdirSync(i.userDataDir, { recursive: true });
  }
  // A: what the app before the fix had stored for this project — the user's zoom. B: nothing (the default).
  writeFileSync(
    join(A.userDataDir, UI_STATE_FILE),
    JSON.stringify({ version: 1, layouts: {}, panels: { browser: { [`project:${projectId}`]: { zoom: USER_ZOOM } } }, selection: null }),
  );
  await launch(A);
  await launch(B);
}, 180_000);

afterAll(async () => {
  await A.app?.close().catch(() => {});
  await B.app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (root) {
    for (const pid of processes(root)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("İki uygulama, tek tarayıcı: yakınlaştırma geri dönmez", () => {
  it("0. A (the MacBook) opens the browser: its old stored zoom becomes the project's, the page follows A's panel", async () => {
    expect(USER_ZOOM).not.toBe(engineDefaults.browser.defaultZoom);
    await connect(A);
    await browser(A).getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(() => frames(A), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await navigate(A, "/a");
    await expect.poll(() => shownZoom(A), { timeout: UI_TIMEOUT_MS }).toBe(USER_ZOOM);
    await expectPicture(A, true, "after opening");
    // Handed over once: the engine has it, the app's own copy is gone.
    expect(await engineZoom()).toBe(USER_ZOOM);
    await expect.poll(() => storedZoom(A), { timeout: UI_TIMEOUT_MS }).toBeUndefined();
    await shot(A, "00-open");
  });

  it("1. B shows the same project: the same zoom (not its default); once its user is gone it does not drive the page", async () => {
    await connect(B);
    await expect.poll(() => frames(B), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await expect.poll(() => shownZoom(B), { timeout: UI_TIMEOUT_MS }).toBe(USER_ZOOM);
    expect(await engineZoom()).toBe(USER_ZOOM);
    // Whoever used B to select the project leaves; the user works on the MacBook: its panel drives.
    await unattended(B);
    await clickTarget(A);
    await expectPicture(A, true, "A in use");
    await expectPicture(B, false, "B watching");
    expect(await shownZoom(B)).toBe(USER_ZOOM);
    await shot(B, "01-watching");
  });

  it("2. B re-asserts by itself — focus, visibility, a window resize, its panel closed and reopened: A's page and zoom stay", async () => {
    const before = (await pageInfo())!;
    await pg(B).evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(300);
    // macOS (a display change) resizes the window nobody is working in.
    await B.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 640));
    await expect.poll(() => pg(B).evaluate(() => innerWidth), { timeout: UI_TIMEOUT_MS }).toBe(960);
    await sleep(defaultUiConfig.resizeDebounceMs + 400);
    // Görünüm › Tarayıcı off and on again (the native menu: no input in B's window): the panel starts anew.
    await clickMenu(B.app!, [MENU.view!, "Tarayıcı"]);
    await expect.poll(() => pg(B).locator(".kp-browser__canvas").count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    await clickMenu(B.app!, [MENU.view!, "Tarayıcı"]);
    await expect.poll(() => frames(B), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    // …and Görünüm › Varsayılan düzen puts it back where it was (it starts once more, at its usual size).
    await clickMenu(B.app!, [MENU.view!, MENU.resetLayout!]);
    await expect.poll(async () => (await measure(B))?.view.width ?? 0, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(TARGET[0] + TARGET[2]);
    await expect.poll(() => frames(B), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await sleep(IDLE_MS);
    const after = (await pageInfo())!;
    expect([after.width, after.height, after.resizes]).toEqual([before.width, before.height, before.resizes]);
    expect(await engineZoom()).toBe(USER_ZOOM);
    expect([await shownZoom(A), await shownZoom(B)]).toEqual([USER_ZOOM, USER_ZOOM]);
    await expectPicture(A, true, "after B re-asserted");
    await expectPicture(B, false, "B still watching");
  });

  it("3. A zooms in: it sticks, B follows without keeping a copy; with both idle the page is never resized", async () => {
    await clickMenu(A.app!, [MENU.view!, MENU.browserZoomIn!]);
    const zoomed = nextLevel(USER_ZOOM);
    await expect.poll(() => shownZoom(A), { timeout: UI_TIMEOUT_MS }).toBe(zoomed);
    await expectPicture(A, true, "A zoomed in");
    await expect.poll(() => shownZoom(B), { timeout: UI_TIMEOUT_MS }).toBe(zoomed);
    await expectPicture(B, false, "B shows A's zoomed page");
    const before = (await pageInfo())!;
    await sleep(IDLE_MS + UNATTENDED_MS);
    const after = (await pageInfo())!;
    expect([after.width, after.height, after.resizes]).toEqual([before.width, before.height, before.resizes]);
    expect([await shownZoom(A), await shownZoom(B), await engineZoom()]).toEqual([zoomed, zoomed, zoomed]);
    expect([storedZoom(A), storedZoom(B)]).toEqual([undefined, undefined]);
    await shot(A, "03-zoomed");
  });

  it("4. B's user clicks the page through B's letterboxed picture: the click lands, then the page follows B; A takes it back by clicking", async () => {
    await clickTarget(B);
    await expectPicture(B, true, "B in use");
    await expectPicture(A, false, "A watching");
    await shot(A, "04-watching");
    await clickTarget(A);
    await expectPicture(A, true, "A in use again");
    await expectPicture(B, false, "B watching again");
    expect(await engineZoom()).toBe(nextLevel(USER_ZOOM));
  });

  it("5. the engine restarts: the zoom is still the user's in both apps, and the page follows the app that is in use", async () => {
    const zoomed = nextLevel(USER_ZOOM);
    await unattended(B);
    await stopEngine(engine);
    engine = await startEngine(configPath, KEY);
    // Both apps reconnect by themselves; the browser went down with the engine. The user opens it on the MacBook.
    const open = browser(A).getByRole("button", { name: "Tarayıcıyı aç" });
    await expect.poll(() => open.isVisible(), { timeout: 2 * UI_TIMEOUT_MS }).toBe(true);
    await open.click();
    await expect.poll(() => frames(A), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await navigate(A, "/b");
    await expect.poll(() => frames(B), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await sleep(IDLE_MS);
    expect([await shownZoom(A), await shownZoom(B), await engineZoom()]).toEqual([zoomed, zoomed, zoomed]);
    await expectPicture(A, true, "A after the engine restart");
    await expectPicture(B, false, "B after the engine restart");
    await clickTarget(A);
    await shot(A, "05-after-restart");
  });

  it("6. one app alone (B quits): the zoom sticks through a second browser tab, another project and back, a resize and a relaunch", async () => {
    await B.app!.close();
    B.app = undefined;
    await clickMenu(A.app!, [MENU.view!, MENU.browserZoomIn!]);
    const zoomed = nextLevel(nextLevel(USER_ZOOM));
    await expect.poll(() => shownZoom(A), { timeout: UI_TIMEOUT_MS }).toBe(zoomed);
    await expectPicture(A, true, "zoomed in again");
    // Another browser tab and back to the first one.
    const tabs = browser(A).getByRole("group", { name: "Sekmeler" });
    await tabs.getByRole("button", { name: "Yeni sekme" }).click();
    await expect.poll(() => tabs.locator(".kp-browser__tab").count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    await sleep(500);
    expect(await shownZoom(A)).toBe(zoomed);
    await tabs.locator(".kp-browser__tab-select").first().click();
    await expectPicture(A, true, "back on the first browser tab");
    expect(await shownZoom(A)).toBe(zoomed);
    // Another project (its own, closed browser) and back: the panel starts anew and reads the zoom.
    await rail(A).getByRole("button", { name: REPO_PROJECT, exact: true }).click();
    await expect.poll(() => pg(A).locator(".kp-browser__canvas").count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    await projectTab(A, FIRST).click();
    await expect.poll(() => frames(A), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await expectPicture(A, true, "back in the project");
    expect(await shownZoom(A)).toBe(zoomed);
    await A.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1250, 820));
    await expect.poll(() => pg(A).evaluate(() => innerWidth), { timeout: UI_TIMEOUT_MS }).toBe(1250);
    await expectPicture(A, true, "after a resize");
    expect([await shownZoom(A), await engineZoom()]).toEqual([zoomed, zoomed]);
    // Relaunch: the app kept no copy, the engine did.
    await A.app!.close();
    expect(storedZoom(A)).toBeUndefined();
    A.app = await launchApp({ KOKPIT_USER_DATA_DIR: A.userDataDir });
    A.page = await A.app.firstWindow();
    await A.page.waitForLoadState("domcontentloaded");
    await expect.poll(() => frames(A), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    await expect.poll(() => shownZoom(A), { timeout: UI_TIMEOUT_MS }).toBe(zoomed);
    await expectPicture(A, true, "after a relaunch");
  });
});
