// Adım 7 İş B end-to-end: the built app against a real engine with a real (headless, test-only) Chrome.
// The Tarayıcı panel's tab strip: 10 tabs opened with "+", switching moves the screencast and the address bar,
// "×" closes a tab, closing the last one leaves a blank tab. Every Chrome lives under a temp dir.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_DIR, engineRequest, launchApp, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";
import { startTabTrace, stripTabs, TabTrace, type TabTraceEntry } from "./tab-trace.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
const TAB_COUNT = 10;
/** What a tab opened with "+" shows (the engine opens it there). */
const NEW_TAB_URL = "about:blank";
/** Must match the main process (src/main/index.ts). */
const UI_STATE_FILE = "ui-state.json";
const engineDefaults = JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as {
  browser: { projectName: string; cdpTimeoutMs: number; tabStepTimeoutMs: number; zoomPaintWaitMs: number };
};
/** A page that runs no script (the engine's expired-preview answer): it once held every switch for cdpTimeoutMs. */
const GONE_PATH = "/gone";
/**
 * How long a tab switch may take to show in the strip and the picture: a few bounded engine steps, plus the app's
 * round trip — well below the 15 s CDP timeout the bug waited for.
 */
const SWITCH_BOUND_MS = 6 * Math.max(engineDefaults.browser.tabStepTimeoutMs, engineDefaults.browser.zoomPaintWaitMs);

let root: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

/** What the strip, the test and the engine did, by time; a failed step's report carries it. */
const trace = new TabTrace();
const traceEntries = (): Promise<TabTraceEntry[]> => trace.entries(page, engine?.log() ?? "");
diagnoseFailures("browser-tabs", () => ({ app, page, engine, extra: traceEntries }));
/** Set to a folder to keep the trace of a run that passed too (for studying timing); unset: nothing is written. */
const TRACE_DIR = process.env.KOKPIT_E2E_TAB_TRACE_DIR;
let server: http.Server;
let siteUrl: string;

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panel = (): Locator => page.locator("section.kp-browser");
const strip = (): Locator => panel().getByRole("group", { name: "Sekmeler" });
const frames = async (): Promise<number> => Number((await panel().locator("canvas").getAttribute("data-frames")) ?? "0");
/** Titles of the tabs in the strip, in order (select buttons only). */
const tabTitles = async (): Promise<string[]> => strip().locator(".kp-browser__tab-select").allTextContents();
const activeTitle = async (): Promise<string | null> => strip().locator('.kp-browser__tab-select[aria-pressed="true"]').textContent();
const titleOf = (n: number) => `Sekme ${n}`;

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `browser-tabs-${name}.png`) });
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-browser-tabs-")));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === GONE_PATH) {
      // Like the engine's answer for an expired file preview: plain text, CSP sandbox — the page runs no script.
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "content-security-policy": "default-src 'none'; sandbox" });
      res.end("Önizleme adresi geçersiz ya da süresi doldu.\n");
      return;
    }
    const n = Number(url.searchParams.get("n") ?? "0") || 0;
    // `c`: the page counts clicks in its title (and on the page), so a click that lands is visible in the strip.
    const counts = url.searchParams.has("c");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // Each tab a different color: the screencast visibly changes when the tab does.
    res.end(`<!doctype html><meta charset="utf-8"><title>${titleOf(n)}</title>
<body style="margin:0;height:100vh;background:hsl(${(n * 37) % 360},70%,55%);font:64px sans-serif"><p id="k">${n}</p>${
      counts
        ? `<script>let k = 0; addEventListener("mousedown", () => { document.title = "${titleOf(n)} tık " + ++k; document.getElementById("k").textContent = "${n}/" + k; });</script>`
        : ""
    }</body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  siteUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

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
  userDataDir = join(root, "user-data");
  await openApp();
}, 120_000);

async function openApp(): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir, KOKPIT_CHROME_HEADLESS: "1" });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

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

describe("Adım 7 İş B: Tarayıcı sekmeleri", () => {
  it("0. connects and opens the built-in browser project's Chrome", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    const name = engineDefaults.browser.projectName;
    await expect.poll(() => rail().getByRole("button", { name, exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await rail().getByRole("button", { name, exact: true }).click();
    await panel().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
  });

  it(`1. "+" opens ${TAB_COUNT} tabs; each navigates and shows its title in the strip`, async () => {
    const address = panel().getByLabel("Adres");
    // The first (existing) tab becomes Sekme 1, then "+" for the rest.
    await address.fill(`${siteUrl}?n=1`);
    await address.press("Enter");
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(titleOf(1));
    for (let n = 2; n <= TAB_COUNT; n++) {
      const before = (await tabTitles()).length;
      await panel().getByRole("button", { name: "Yeni sekme", exact: true }).click();
      await expect.poll(async () => (await tabTitles()).length, { timeout: UI_TIMEOUT_MS }).toBe(before + 1);
      // The new tab is listed as soon as Chrome has it, but it is in front — and the address bar its — only a
      // moment later. Typing before that raced the field's switch to the new tab: fill() selects the old text,
      // the field became "about:blank", and the address was inserted after it ("about:blankhttp://…").
      await expect.poll(async () => (await stripTabs(page)).at(-1)?.active, { timeout: UI_TIMEOUT_MS }).toBe(true);
      await expect.poll(() => address.inputValue(), { timeout: UI_TIMEOUT_MS }).toBe(NEW_TAB_URL);
      await address.fill(`${siteUrl}?n=${n}`);
      await address.press("Enter");
      await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(titleOf(n));
    }
    await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).toEqual(Array.from({ length: TAB_COUNT }, (_, i) => titleOf(i + 1)));
    // The strip stays one row and scrolls instead of pushing the page wider.
    const stripBox = await strip().boundingBox();
    const tabBox = await strip().locator(".kp-browser__tab").first().boundingBox();
    expect(stripBox!.height).toBeLessThan(tabBox!.height * 2);
    await shot("01-ten-tabs");
  });

  it("2. clicking a tab switches: highlighted, address bar follows, new frames arrive", async () => {
    for (const n of [3, 8, 1, 10, 5]) {
      const before = await frames();
      await strip().getByRole("button", { name: titleOf(n), exact: true }).click();
      await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(titleOf(n));
      await expect.poll(() => panel().getByLabel("Adres").inputValue(), { timeout: UI_TIMEOUT_MS }).toBe(`${siteUrl}?n=${n}`);
      await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before);
    }
    await shot("02-switched");
  });

  it("3. × closes a tab (the active one hands over to a neighbour)", async () => {
    await strip().getByRole("button", { name: `Sekmeyi kapat: ${titleOf(5)}`, exact: true }).click();
    await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).not.toContain(titleOf(5));
    expect(await tabTitles()).toHaveLength(TAB_COUNT - 1);
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(titleOf(6));
    await strip().getByRole("button", { name: `Sekmeyi kapat: ${titleOf(2)}`, exact: true }).click();
    await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).not.toContain(titleOf(2));
    expect(await activeTitle()).toBe(titleOf(6));
    await shot("03-closed");
  });

  it("4. the active tab is restored after an app relaunch (same userData), even if Chrome's changed meanwhile", async () => {
    const remembered = await activeTitle();
    expect(remembered).toBe(titleOf(6));
    const titles = await tabTitles();
    // Let the debounced save of the panel state land.
    const file = join(userDataDir, UI_STATE_FILE);
    await expect
      .poll(() => (existsSync(file) ? readFileSync(file, "utf8") : ""), { timeout: UI_TIMEOUT_MS })
      .toContain(`?n=6`);
    await app!.close();
    app = undefined;

    // While the app is closed, another tab becomes Chrome's active one (the engine and its Chrome keep running).
    const projects = (await engineRequest(engine!.url, KEY, "projects.list", {})) as { projects: { id: string; name: string }[] };
    const projectId = projects.projects.find((p) => p.name === engineDefaults.browser.projectName)!.id;
    const { browser } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as {
      browser: { activeTabId?: string; tabs: { id: string; title: string }[] };
    };
    const other = browser.tabs.find((t) => t.title === titleOf(1))!;
    await engineRequest(engine!.url, KEY, "browser.selectTab", { projectId, tabId: other.id });

    await openApp();
    await expect.poll(async () => (await tabTitles()).length, { timeout: UI_TIMEOUT_MS }).toBe(titles.length);
    expect(await tabTitles()).toEqual(titles);
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(titleOf(6));
    await expect.poll(() => panel().getByLabel("Adres").inputValue(), { timeout: UI_TIMEOUT_MS }).toBe(`${siteUrl}?n=6`);
    await shot("04-relaunched-active-tab");
  });

  it("5. closing every tab leaves one blank tab and the browser keeps running", async () => {
    await startTabTrace(page);
    const projects = (await engineRequest(engine!.url, KEY, "projects.list", {})) as { projects: { id: string; name: string }[] };
    const projectId = projects.projects.find((p) => p.name === engineDefaults.browser.projectName)!.id;
    const engineIds = async (): Promise<string[]> => {
      const { browser } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as { browser: { tabs: { id: string }[] } };
      return browser.tabs.map((t) => t.id);
    };
    const stripIds = async (): Promise<string[]> => (await stripTabs(page)).map((t) => t.id);
    // Tabs are closed by their id, in the order they stood at the start — never by a title read a moment ago.
    // While the engine closes the ACTIVE tab, the strip passes through states that are not "one tab fewer": the
    // closing tab is still listed until its neighbour is in front, and the last tab stands NEXT TO its blank
    // replacement for a moment (Chrome must never be without a page, so the blank one is opened first). A loop
    // that took any change of the list for a finished close read "Sekme 10, about:blank" there and clicked the
    // "×" of a tab that was already on its way out (the trace of that run: one click, one close per tab).
    const original = await stripIds();
    expect(original).toHaveLength(TAB_COUNT - 2);
    expect(await engineIds()).toEqual(original);
    try {
      for (const [at, id] of original.entries()) {
        const rest = original.slice(at + 1);
        trace.note("clicking ×", { id, rest });
        await strip().locator(`.kp-browser__tab[data-tab-id="${id}"] .kp-browser__tab-close`).click();
        trace.note("clicked ×", { id });
        await expect.poll(stripIds, { timeout: UI_TIMEOUT_MS }).not.toContain(id);
        if (rest.length === 0) break;
        // Exactly that one tab went — in the strip and in Chrome — and no blank tab appeared: others remain.
        expect(await stripIds()).toEqual(rest);
        expect(await engineIds()).toEqual(rest);
      }
      // The last one is replaced by ONE new tab.
      const left = await stripIds();
      trace.note("after the last close", left);
      expect(left).toHaveLength(1);
      expect(original).not.toContain(left[0]);
      expect(await engineIds()).toEqual(left);
    } finally {
      if (TRACE_DIR) {
        mkdirSync(TRACE_DIR, { recursive: true });
        writeFileSync(join(TRACE_DIR, `browser-tabs-${Date.now()}.json`), `${JSON.stringify(await traceEntries(), null, 2)}\n`);
      }
    }
    const titles = await tabTitles();
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatch(/about:blank|Yeni sekme/);
    expect(await panel().getByRole("button", { name: "Tarayıcıyı kapat" }).isVisible()).toBe(true);
    await shot("05-last-tab-blank");
  });

  it("6. after closing an active tab that runs no script, clicking other tabs changes the picture at once and clicks land", async () => {
    expect(SWITCH_BOUND_MS * 2).toBeLessThan(engineDefaults.browser.cdpTimeoutMs);
    const address = panel().getByLabel("Adres");
    const open = async (url: string, fresh: boolean) => {
      if (fresh) {
        const before = (await tabTitles()).length;
        await panel().getByRole("button", { name: "Yeni sekme", exact: true }).click();
        await expect.poll(async () => (await tabTitles()).length, { timeout: UI_TIMEOUT_MS }).toBe(before + 1);
        await expect.poll(async () => (await stripTabs(page)).at(-1)?.active, { timeout: UI_TIMEOUT_MS }).toBe(true);
        await expect.poll(() => address.inputValue(), { timeout: UI_TIMEOUT_MS }).toBe(NEW_TAB_URL);
      }
      await address.fill(url);
      await address.press("Enter");
      await expect.poll(() => address.inputValue(), { timeout: UI_TIMEOUT_MS }).toBe(url);
    };
    // The blank tab left by step 5 becomes Sekme 1; then the page without scripts, Sekme 3 and Sekme 4.
    await open(`${siteUrl}?n=1&c=1`, false);
    await open(`${siteUrl}${GONE_PATH.slice(1)}`, true);
    const gone = (await stripTabs(page)).at(-1)!.id;
    await open(`${siteUrl}?n=3&c=1`, true);
    await open(`${siteUrl}?n=4&c=1`, true);
    const tab = (id: string) => strip().locator(`.kp-browser__tab[data-tab-id="${id}"]`);
    const byTitle = (n: number) => strip().getByRole("button", { name: new RegExp(`^${titleOf(n)}( tık \\d+)?$`) });

    // The page without scripts in front, then closed with its "×".
    await tab(gone).locator(".kp-browser__tab-select").click();
    await expect.poll(async () => (await stripTabs(page)).find((t) => t.active)?.id, { timeout: SWITCH_BOUND_MS }).toBe(gone);
    await tab(gone).locator(".kp-browser__tab-close").click();
    await expect.poll(async () => (await stripTabs(page)).map((t) => t.id), { timeout: SWITCH_BOUND_MS }).not.toContain(gone);

    // Every click on a tab shows it within the bound: highlighted, new frames, and a click in the page lands there.
    for (const n of [1, 4, 3, 1]) {
      const before = await frames();
      await byTitle(n).click();
      await expect.poll(activeTitle, { timeout: SWITCH_BOUND_MS }).toMatch(new RegExp(`^${titleOf(n)}`));
      await expect.poll(frames, { timeout: SWITCH_BOUND_MS }).toBeGreaterThan(before);
      const clicked = Number(/tık (\d+)$/.exec((await activeTitle()) ?? "")?.[1] ?? 0);
      await panel().locator("canvas").click({ position: { x: 40, y: 40 } });
      await expect.poll(activeTitle, { timeout: SWITCH_BOUND_MS }).toBe(`${titleOf(n)} tık ${clicked + 1}`);
    }
    // No request of the panel hit a CDP session the engine had already let go of.
    expect(engine!.log()).not.toMatch(/Session with given id not found|No target with given id found/);
    await shot("06-after-closing-scriptless-tab");
  });
});
