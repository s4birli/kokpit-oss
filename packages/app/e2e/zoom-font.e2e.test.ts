// İş Z end-to-end: the built app against a real engine with a real (headless, test-only) Chrome.
// Terminal font size and browser page zoom have no controls in the panels' bars (room for the screens): they are
// changed from the native Görünüm menu and with Cmd+=/−/0 while the panel has focus. The page itself is laid out
// at the panel's picture area / zoom,
// the address bar (localhost:<port>/x navigates, a word searches) — and both settings survive a relaunch.
// The search engine is pointed at a local page through the UI state file, so no test ever reaches Google.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultUiConfig } from "../src/renderer/ui/config.ts";
import { clickMenu, ENGINE_DIR, engineRequest, launchApp, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
/** Must match the main process (src/main/index.ts). */
const UI_STATE_FILE = "ui-state.json";
const engineDefaults = JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as {
  browser: { projectName: string };
};
/** The texts moved to the catalogs (i18n); these tests run the app in Turkish. */
const trCatalog = (area: string) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/tr/${area}.json`, import.meta.url), "utf8"));
const MENU = (trCatalog("main") as { menu: Record<string, string> }).menu;
/** A command of the native Görünüm menu, by its key in menu.defaults.json. */
const viewMenu = (key: string): Promise<void> => clickMenu(app!, [MENU.view!, MENU[key]!]);

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

diagnoseFailures("zoom-font", () => ({ app, page, engine }));
let server: http.Server;
let port: number;
let projectId: string;

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const browser = (): Locator => page.locator("section.kp-browser");
const terminals = (): Locator => page.getByRole("region", { name: "Terminaller", exact: true });
const frames = async (): Promise<number> => Number((await browser().locator("canvas").getAttribute("data-frames")) ?? "0");
/** The zoom / font size in effect, as the panels carry them (their bars have no readout). */
const zoomValue = async (): Promise<number> => Number(await browser().locator(".kp-browser__view").getAttribute("data-zoom"));
/** The page's title at `zoom`: its CSS width is the panel's picture area ÷ zoom (the page viewport follows the panel). */
async function titleAt(zoom: number, path: string): Promise<string> {
  const width = await browser().locator(".kp-browser__view").evaluate((el) => el.clientWidth);
  return `w=${Math.round(width / zoom)} ${path}`;
}
const fontValue = async (): Promise<number> => Number(await terminals().getAttribute("data-font-size"));
/** The font size xterm really renders with. */
const xtermFontPx = (): Promise<number> =>
  terminals()
    .locator(".kp-tabs__pane--a .xterm-rows")
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));

async function activeTab(): Promise<{ title: string; url: string } | undefined> {
  const { browser: s } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as {
    browser: { activeTabId?: string; tabs: { id: string; title: string; url: string }[] };
  };
  return s.tabs.find((t) => t.id === s.activeTabId);
}
const activeTitle = async (): Promise<string> => (await activeTab())?.title ?? "";

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `zoom-font-${name}.png`) });
}

async function openApp(): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

function pidsWith(needle: string): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-zoom-font-")));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/ara") {
      // The test's search engine: shows what it was asked.
      const q = url.searchParams.get("q") ?? "";
      res.end(`<!doctype html><meta charset="utf-8"><title>ara:${q.replace(/[<>&]/g, "")}</title><body>${q.replace(/[<>&]/g, "")}</body>`);
      return;
    }
    // Shows the page's CSS width in its title, live (a viewport override fires resize).
    res.end(`<!doctype html><meta charset="utf-8"><title>…</title>
<body style="margin:0;font:48px sans-serif"><h1>Kokpit ${url.pathname}</h1>
<script>const t=()=>{document.title="w="+innerWidth+" "+location.pathname};t();addEventListener("resize",t);</script></body>`);
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
    }),
  );
  engine = await startEngine(configPath, KEY);
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const { projects } = (await engineRequest(engine.url, KEY, "projects.list", {})) as { projects: { id: string; name: string }[] };
  projectId = projects.find((p) => p.name === engineDefaults.browser.projectName)!.id;
  await engineRequest(engine.url, KEY, "terminal.open", { projectId, cols: 80, rows: 24, command: "echo YAZI_$((6*7))" });

  userDataDir = join(root, "user-data");
  mkdirSync(userDataDir, { recursive: true });
  // The user's search engine (UI state, browser panel, global scope): a local page instead of Google.
  writeFileSync(
    join(userDataDir, UI_STATE_FILE),
    JSON.stringify({ version: 1, layouts: {}, panels: { browser: { global: { searchUrl: `http://127.0.0.1:${port}/ara?q=%s` } } }, selection: null }),
  );
  await openApp();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (root) {
    for (const pid of pidsWith(root)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("İş Z: yazı boyutu, yakınlaştırma, adres çubuğu", () => {
  it("0. connects; the terminal starts at the smaller default font (12px)", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    const name = engineDefaults.browser.projectName;
    await expect.poll(() => rail().getByRole("button", { name, exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await rail().getByRole("button", { name, exact: true }).click();
    await expect.poll(() => terminals().locator(".kp-tabs__pane--a .xterm-rows").count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await expect.poll(xtermFontPx, { timeout: UI_TIMEOUT_MS }).toBe(12);
    expect(await fontValue()).toBe(12);
    // The bar has no font-size controls.
    expect(await terminals().getByRole("group", { name: "Yazı boyutu" }).count()).toBe(0);
  });

  it("1. Görünüm › Terminal yazısını büyüt/küçült/sıfırla and Cmd+=/Cmd+−/Cmd+0 change the rendered size", async () => {
    await viewMenu("terminalLarger");
    await viewMenu("terminalLarger");
    await viewMenu("terminalLarger");
    await expect.poll(xtermFontPx, { timeout: UI_TIMEOUT_MS }).toBe(15);
    await viewMenu("terminalSmaller");
    await expect.poll(xtermFontPx, { timeout: UI_TIMEOUT_MS }).toBe(14);
    await viewMenu("terminalReset");
    await expect.poll(xtermFontPx, { timeout: UI_TIMEOUT_MS }).toBe(12);
    // Keyboard, with focus in the terminal.
    await terminals().locator(".kp-tabs__pane--a .xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+Equal");
    await page.keyboard.press("Meta+Equal");
    await page.keyboard.press("Meta+Equal");
    await expect.poll(xtermFontPx, { timeout: UI_TIMEOUT_MS }).toBe(15);
    await page.keyboard.press("Meta+0");
    await expect.poll(xtermFontPx, { timeout: UI_TIMEOUT_MS }).toBe(12);
    await page.keyboard.press("Meta+Equal");
    await page.keyboard.press("Meta+Equal");
    await page.keyboard.press("Meta+Equal");
    await page.keyboard.press("Meta+Minus");
    await expect.poll(xtermFontPx, { timeout: UI_TIMEOUT_MS }).toBe(14);
    expect(await fontValue()).toBe(14);
    await shot("01-font-14");
  });

  it("2. the browser shows the page zoomed out by default (config: the page is panel / zoom CSS px wide)", async () => {
    await browser().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    expect(await zoomValue()).toBe(ZOOM);
    // The toolbar has no zoom controls and no profile text.
    expect(await browser().getByRole("group", { name: "Yakınlaştırma" }).count()).toBe(0);
    expect(await browser().getByText(/Profil:/).count()).toBe(0);
    const address = browser().getByLabel("Adres");
    await address.fill(`http://127.0.0.1:${port}/genislik`);
    await address.press("Enter");
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(await titleAt(ZOOM, "/genislik"));
  });

  it("3. Görünüm › Tarayıcıyı yakınlaştır/uzaklaştır/sıfırla and Cmd+=/Cmd+−/Cmd+0 on the page step the zoom; the page relays out", async () => {
    // One step at a time, as a person does: each is on the page before the next.
    await viewMenu("browserZoomIn");
    await expect.poll(zoomValue, { timeout: UI_TIMEOUT_MS }).toBe(zoomStep(ZOOM, 1));
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(await titleAt(zoomStep(ZOOM, 1), "/genislik"));
    await viewMenu("browserZoomIn");
    await expect.poll(zoomValue, { timeout: UI_TIMEOUT_MS }).toBe(zoomStep(ZOOM, 2));
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(await titleAt(zoomStep(ZOOM, 2), "/genislik"));
    await viewMenu("browserZoomOut");
    await expect.poll(zoomValue, { timeout: UI_TIMEOUT_MS }).toBe(zoomStep(ZOOM, 1));
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(await titleAt(zoomStep(ZOOM, 1), "/genislik"));
    await viewMenu("browserZoomReset");
    await expect.poll(zoomValue, { timeout: UI_TIMEOUT_MS }).toBe(ZOOM);
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(await titleAt(ZOOM, "/genislik"));
    // Keyboard, with focus on the page view: the keys zoom and do not reach the page.
    await browser().locator("canvas").focus();
    await page.keyboard.press("Meta+Minus");
    await expect.poll(zoomValue, { timeout: UI_TIMEOUT_MS }).toBe(zoomStep(ZOOM, -1));
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(await titleAt(zoomStep(ZOOM, -1), "/genislik"));
    await page.keyboard.press("Meta+0");
    await expect.poll(zoomValue, { timeout: UI_TIMEOUT_MS }).toBe(ZOOM);
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(await titleAt(ZOOM, "/genislik"));
    await page.keyboard.press("Meta+Equal");
    await expect.poll(zoomValue, { timeout: UI_TIMEOUT_MS }).toBe(zoomStep(ZOOM, 1));
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(await titleAt(zoomStep(ZOOM, 1), "/genislik"));
    await shot("03-zoom-stepped");
  });

  it('4. typing "localhost:<port>/x" navigates to http://localhost:<port>/x', async () => {
    const address = browser().getByLabel("Adres");
    await address.fill(`localhost:${port}/x`);
    await address.press("Enter");
    await expect.poll(async () => (await activeTab())?.url, { timeout: UI_TIMEOUT_MS }).toBe(`http://localhost:${port}/x`);
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toMatch(/ \/x$/);
  });

  it("5. typing words searches with the configured search engine (URL-encoded)", async () => {
    const address = browser().getByLabel("Adres");
    await address.fill("türkçe arama");
    await address.press("Enter");
    await expect
      .poll(async () => (await activeTab())?.url, { timeout: UI_TIMEOUT_MS })
      .toBe(`http://127.0.0.1:${port}/ara?q=t%C3%BCrk%C3%A7e%20arama`);
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe("ara:türkçe arama");
    await shot("05-search");
  });

  it("6. after a relaunch: the font size and the project's zoom are kept", async () => {
    await expect
      .poll(
        () => {
          try {
            return JSON.parse(readFileSync(join(userDataDir, UI_STATE_FILE), "utf8")) as { panels?: Record<string, Record<string, Record<string, unknown>>> };
          } catch {
            return {};
          }
        },
        { timeout: UI_TIMEOUT_MS },
      )
      .toMatchObject({ panels: { terminals: { global: { fontSize: 14 } } } });
    // The zoom is not this app's to keep: the engine has it for the project (every app shows the same one).
    const ui = JSON.parse(readFileSync(join(userDataDir, UI_STATE_FILE), "utf8")) as { panels?: Record<string, Record<string, Record<string, unknown>>> };
    expect(ui.panels?.browser?.[`project:${projectId}`]?.zoom).toBeUndefined();
    const { browser: inEngine } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as { browser: { zoom?: number } };
    expect(inEngine.zoom).toBe(zoomStep(ZOOM, 1));
    await app!.close();
    app = undefined;
    await openApp();
    await expect.poll(() => terminals().locator(".kp-tabs__pane--a .xterm-rows").count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await expect.poll(xtermFontPx, { timeout: UI_TIMEOUT_MS }).toBe(14);
    await expect.poll(zoomValue, { timeout: UI_TIMEOUT_MS }).toBe(zoomStep(ZOOM, 1));
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    // The relaunched app read the project's zoom from the engine (the page is laid out at panel / zoom).
    const address = browser().getByLabel("Adres");
    await address.fill(`http://127.0.0.1:${port}/yeniden`);
    await address.press("Enter");
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(await titleAt(zoomStep(ZOOM, 1), "/yeniden"));
    await shot("06-relaunched");
  });
});
