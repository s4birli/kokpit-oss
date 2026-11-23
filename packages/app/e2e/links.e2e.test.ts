// Bağlantılar end-to-end: the built app (Electron, Playwright `_electron`) against a real engine and REAL headless
// Chrome (temp profiles, mock keychain) and a local test page server.
// "Claude oturumunda çıkan bir URL'ye tıklayınca oturumun tarayıcısında açılmalı": a fake program
// (fixtures/fake-link-tui.mjs — never the real `claude`) prints plain addresses and OSC 8 hyperlinks, with mouse
// tracking on as Claude Code has it. A ⌘ click must open the link in the PROJECT's Chrome on the engine machine —
// started if need be, in a new tab, the Tarayıcı panel brought up — and never reach the program.
// Nothing leaves the machine: "the default browser" is recorded in the main process, never opened (harness.ts),
// native menus are recorded instead of shown, and every address is the local test server's.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickMenu, engineRequest, externalOpens, launchApp, launchTerminal, pauseEngine, SCREENSHOT_DIR, sleep, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
/** Long enough for a link to have opened if it were (wrongly) going to. */
const REFUSAL_WAIT_MS = 1_500;
const FAKE_TUI = fileURLToPath(new URL("./fixtures/fake-link-tui.mjs", import.meta.url));
/** The texts moved to the catalogs (i18n); these tests run the app in Turkish. */
const trCatalog = (area: string) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/tr/${area}.json`, import.meta.url), "utf8"));
const linkDefaults = JSON.parse(readFileSync(new URL("../src/renderer/engine/links.defaults.json", import.meta.url), "utf8")) as {
  labels: { openBrowser: string; openExternal: string; copyLink: string };
  text: Record<string, string>;
  rate: { minIntervalMs: number };
  tooltipDelayMs: number;
};
Object.assign(linkDefaults, { labels: trCatalog("links").labels, text: trCatalog("links").text });
const browserDefaults = JSON.parse(readFileSync(new URL("../src/main/browser.defaults.json", import.meta.url), "utf8")) as { profilesDirName: string };
const PROJECT_A = "Bağlantı A";
const PROJECT_B = "Bağlantı B";
const PROJECT_CLIENT = "Bağlantı İstemci";
/** Path characters of the fake program's long address (its env default). */
const LONG_PATH_CHARS = 260;
/** Marks clipboard texts of this file, so the user's own clipboard is only put back over ours. */
const OURS = /127\.0\.0\.1:\d+\/|KOKPIT_LINK_NOBETCI/;
const SENTINEL = `KOKPIT_LINK_NOBETCI_${randomBytes(4).toString("hex")}`;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let server: http.Server;
let base: string;
let port: number;
let userDataDir: string;
/** `host path` of every request the test page server got. */
const hits: string[] = [];
/** Native dialogs the page raised (xterm's own OSC 8 handling used to raise a confirm()). */
const dialogs: string[] = [];
let previousClipboard: string | undefined;
const projectIds: Record<string, string> = {};
let trackLog: string;
let plainLog: string;

diagnoseFailures("links", () => ({ app, page, engine, extra: () => ({ hits: hits.slice(-30), dialogs }) }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const terminals = (): Locator => page.getByRole("region", { name: "Terminaller", exact: true });
const activePane = (): Locator => terminals().locator(".kp-tabs__pane--a");
const browserPanel = (): Locator => page.locator("section.kp-browser");
const tip = (): Locator => activePane().locator(".kp-term__linktip");
const confirmBar = (): Locator => activePane().locator(".kp-term__linkconfirm");

const readClipboard = (): Promise<string> => app!.evaluate(({ clipboard }) => clipboard.readText());
const writeClipboard = (text: string): Promise<void> => app!.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
const stdinOf = (log: string): string => (existsSync(log) ? readFileSync(log, "latin1") : "");
/** SGR mouse reports (press/drag/release) the program received. */
const mouseReports = (log: string): number => (stdinOf(log).match(/\x1b\[<\d+;\d+;\d+[Mm]/g) ?? []).length;

interface Tabs {
  running: boolean;
  urls: string[];
  active: string | undefined;
}
async function tabsOf(project: string): Promise<Tabs> {
  const { browser } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId: projectIds[project]! })) as {
    browser: { running: boolean; activeTabId?: string; tabs: { id: string; url: string }[] };
  };
  return { running: browser.running, urls: browser.tabs.map((t) => t.url), active: browser.tabs.find((t) => t.id === browser.activeTabId)?.url };
}
/** Waits until the project's Chrome has `url` in front; returns its tabs. */
async function activeIs(project: string, url: string): Promise<Tabs> {
  let last: Tabs | undefined;
  await expect.poll(async () => (last = await tabsOf(project)).active, { timeout: UI_TIMEOUT_MS, message: `${project}: active tab ${url}` }).toBe(url);
  return last!;
}
/** Waits until the project's Chrome has one tab more than `before` and that new tab — showing `url` — is in front. */
async function openedNewTab(project: string, before: Tabs, url: string): Promise<Tabs> {
  let last: Tabs | undefined;
  await expect
    .poll(async () => ((last = await tabsOf(project)), { count: last.urls.length, newest: last.urls.at(-1), active: last.active }), { timeout: UI_TIMEOUT_MS, message: `${project}: new tab ${url}` })
    .toEqual({ count: before.urls.length + 1, newest: url, active: url });
  return last!;
}
const loaded = (host: string, path: string): Promise<void> => expect.poll(() => hits.includes(`${host} ${path}`), { timeout: UI_TIMEOUT_MS, message: `${host} ${path} requested` }).toBe(true);

interface PopupItem {
  label: string;
  enabled: boolean;
}
type PopupStore = { __popups: Electron.Menu[]; __popupClick: string | null };
/** Native context menus are recorded in main instead of shown; `__popupClick` names the item to choose. */
async function recordPopups(): Promise<void> {
  await app!.evaluate(({ Menu }) => {
    const g = globalThis as unknown as PopupStore;
    g.__popups = [];
    g.__popupClick = null;
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.__popups.push(this);
      if (g.__popupClick !== null) this.items.find((i) => i.label === g.__popupClick)?.click();
    };
  });
}
async function takePopups(): Promise<PopupItem[][]> {
  return app!.evaluate(() => {
    const g = globalThis as unknown as PopupStore;
    return g.__popups.splice(0).map((m) => m.items.filter((i) => i.type !== "separator").map((i) => ({ label: i.label, enabled: i.enabled })));
  });
}

/** The middle of the character cell showing the middle of `text`, in the active terminal (page coordinates). */
async function pointOf(text: string): Promise<{ x: number; y: number }> {
  const p = await activePane().evaluate((el, needle) => {
    for (const row of el.querySelectorAll(".xterm-rows > div")) {
      const at = (row.textContent ?? "").indexOf(needle);
      if (at < 0) continue;
      const want = at + Math.floor(needle.length / 2);
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = (n.textContent ?? "").length;
        if (want < seen + len) {
          const r = document.createRange();
          r.setStart(n, want - seen);
          r.setEnd(n, want - seen + 1);
          const b = r.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }
        seen += len;
      }
    }
    return null;
  }, text);
  if (!p) throw new Error(`"${text}" is not on screen`);
  return p;
}
/** Moves the pointer onto `text` (in two steps, as a hand does: xterm looks for links on pointer moves). */
async function hover(text: string): Promise<{ x: number; y: number }> {
  const p = await pointOf(text);
  await page.mouse.move(p.x - 4, p.y);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  return p;
}
/** A click on `text` with the modifier keys held from before the pointer arrives. */
async function clickOn(text: string, modifiers: readonly string[] = [], button: "left" | "right" = "left"): Promise<void> {
  // Two opens closer together than the app's own limit are one gesture to it.
  await sleep(linkDefaults.rate.minIntervalMs);
  for (const m of modifiers) await page.keyboard.down(m);
  try {
    await hover(text);
    await page.mouse.down({ button });
    await page.mouse.up({ button });
  } finally {
    for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
  }
}
const CMD = ["Meta"] as const;
const OPT_CMD = ["Alt", "Meta"] as const;
/** Right-clicks `text` and returns the one menu that opened; `choose` clicks an item of it by label. */
async function menuOn(text: string, choose: string | null = null): Promise<PopupItem[]> {
  await takePopups();
  await app!.evaluate((_electron, label) => {
    (globalThis as unknown as PopupStore).__popupClick = label;
  }, choose);
  await clickOn(text, [], "right");
  let menus: PopupItem[][] = [];
  await expect.poll(async () => (menus = menus.concat(await takePopups())).length, { timeout: UI_TIMEOUT_MS }).toBe(1);
  return menus[0]!;
}
/** The pointer cursor xterm shows over a link a click would open. */
const pointerShown = (): Promise<boolean> => activePane().locator(".xterm-screen").evaluate((el) => el.classList.contains("xterm-cursor-pointer"));

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `baglanti-${name}.png`) });
}
async function selectProject(name: string): Promise<void> {
  await rail().getByRole("button", { name, exact: true }).click();
  await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(name);
}
/** Starts the fake program in a new terminal of the selected project and waits until it printed everything. */
async function startTui(log: string, mode: "track" | "plain"): Promise<void> {
  await launchTerminal(page, `'${process.execPath}' '${FAKE_TUI}' '${log}' '${base}' ${mode}`);
  await expect.poll(() => existsSync(log), { timeout: UI_TIMEOUT_MS }).toBe(true);
  // The new terminal's tab is the one in front (its title is its command), and the program has printed its last line.
  const mine = activePane().locator(`[aria-label*="${basename(log)}"]`);
  await expect.poll(async () => (await mine.count()) === 1 && (await xtermText(activePane())).includes("LINK_TUI_HAZIR"), { timeout: UI_TIMEOUT_MS }).toBe(true);
}
function pidsWith(needle: string): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}
const chromeCommands = (needle: string): string[] =>
  execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(needle) && l.includes("--user-data-dir=") && !l.includes("--type="));

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-links-")));
  for (const dir of ["a", "b", "istemci", "home"]) mkdirSync(join(root, dir));
  server = http.createServer((req, res) => {
    hits.push(`${req.headers.host ?? ""} ${req.url ?? ""}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>LINK ${(req.url ?? "").slice(0, 40)}</title><body style="margin:0;background:#bbf7d0;font:32px sans-serif"><p>${(req.url ?? "").slice(0, 40).replace(/[<>&]/g, "")}</p></body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  trackLog = join(root, "stdin-track.log");
  plainLog = join(root, "stdin-plain.log");

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
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home") });
  // Never start the seeded global default tool (claude).
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const create = async (name: string, dir: string, extra: Record<string, unknown> = {}): Promise<void> => {
    const { project } = (await engineRequest(engine!.url, KEY, "projects.create", { name, location: { kind: "local", path: join(root, dir) }, ...extra })) as { project: { id: string } };
    projectIds[name] = project.id;
  };
  await create(PROJECT_A, "a");
  await create(PROJECT_B, "b");
  await create(PROJECT_CLIENT, "istemci", { browser: { runOn: "client" } });

  userDataDir = join(root, "user-data");
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir, KOKPIT_CHROME_HEADLESS: "1" });
  previousClipboard = await readClipboard();
  await recordPopups();
  page = await app.firstWindow();
  page.on("dialog", (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`);
    void d.dismiss();
  });
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  // Its header is waited for in the first step (expect.poll belongs inside a test).
  await rail().getByRole("button", { name: PROJECT_A, exact: true }).click();
}, 120_000);

afterAll(async () => {
  // The tests run on the user's Mac: give the clipboard its text back (unless they copied something meanwhile).
  if (app && previousClipboard !== undefined && OURS.test(await readClipboard().catch(() => ""))) await writeClipboard(previousClipboard).catch(() => {});
  await app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (root) {
    // The engine's Chromes and the local profile Chrome of the client-run project.
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

describe("Bağlantılar end-to-end", () => {
  it("1. in a program that tracks the mouse a link is underlined only while ⌘ is held; the tooltip shows the target and where it opens", async () => {
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT_A);
    await startTui(trackLog, "track");
    expect((await tabsOf(PROJECT_A)).running).toBe(false);
    await hover("/duz?x=1");
    await sleep(linkDefaults.tooltipDelayMs);
    expect(await pointerShown()).toBe(false);
    await page.keyboard.down("Meta");
    try {
      await expect.poll(pointerShown, { timeout: UI_TIMEOUT_MS }).toBe(true);
      await expect.poll(async () => (await tip().count()) === 1, { timeout: UI_TIMEOUT_MS }).toBe(true);
      const lines = await tip().locator("span").allTextContents();
      expect(lines[0]).toBe(`${base}/duz?x=1`);
      expect(lines[1]).toBe("⌘ tıkla: Mac mini'deki tarayıcıda açılır");
      await shot("01-ipucu");
    } finally {
      await page.keyboard.up("Meta");
    }
    await expect.poll(pointerShown, { timeout: UI_TIMEOUT_MS }).toBe(false);
  });

  it("2. a plain click there is the program's: it gets the mouse report and nothing opens", async () => {
    const before = mouseReports(trackLog);
    await clickOn("/duz?x=1");
    await expect.poll(() => mouseReports(trackLog), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before);
    await sleep(REFUSAL_WAIT_MS);
    expect((await tabsOf(PROJECT_A)).running).toBe(false);
    expect(await externalOpens(app!)).toEqual([]);
    expect(hits).toEqual([]);
  });

  it("3. ⌘ click: the project's Chrome starts, the link is its only tab, the Tarayıcı panel comes up — and the program never sees the click", async () => {
    // The user had closed the panel in this project's layout.
    await clickMenu(app!, ["Görünüm", "Tarayıcı"]);
    await expect.poll(() => browserPanel().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    const before = mouseReports(trackLog);

    await clickOn("/duz?x=1", CMD);
    await activeIs(PROJECT_A, `${base}/duz?x=1`);
    // The blank tab of the Chrome this click started is not left behind (it is closed right after the link's tab
    // came to the front).
    await expect.poll(async () => (await tabsOf(PROJECT_A)).urls, { timeout: UI_TIMEOUT_MS }).toEqual([`${base}/duz?x=1`]);
    await loaded(`127.0.0.1:${port}`, "/duz?x=1");
    await expect.poll(() => browserPanel().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => browserPanel().locator('.kp-browser__tab-select[aria-pressed="true"]').getAttribute("title"), { timeout: UI_TIMEOUT_MS }).toBe(`${base}/duz?x=1`);
    await expect.poll(() => browserPanel().locator("canvas").count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    expect(mouseReports(trackLog)).toBe(before);
    expect(await externalOpens(app!)).toEqual([]);
    expect((await tabsOf(PROJECT_B)).running).toBe(false);
    await shot("02-cmd-tikla");
  });

  it("4. an OSC 8 hyperlink opens its target in a NEW tab — what was open stays — with no dialog", async () => {
    const before = mouseReports(trackLog);
    await clickOn("Belgeler_Baglantisi", CMD);
    const tabs = await activeIs(PROJECT_A, `${base}/osc8`);
    expect(tabs.urls).toEqual([`${base}/duz?x=1`, `${base}/osc8`]);
    await loaded(`127.0.0.1:${port}`, "/osc8");
    expect(dialogs).toEqual([]);
    expect(mouseReports(trackLog)).toBe(before);
  });

  it("5. a bare localhost:PORT, an address in parentheses and one wrapped over several rows open exactly as written", async () => {
    await clickOn("/yerel", CMD);
    await activeIs(PROJECT_A, `http://localhost:${port}/yerel`);

    await clickOn("/parantez", CMD);
    await activeIs(PROJECT_A, `${base}/parantez`);

    const long = `${base}/uzun/${"u".repeat(LONG_PATH_CHARS)}/SON`;
    // Its last row: the click is rows away from where the address starts.
    await clickOn("/SON", CMD);
    const tabs = await activeIs(PROJECT_A, long);
    expect(tabs.urls).toEqual([`${base}/duz?x=1`, `${base}/osc8`, `http://localhost:${port}/yerel`, `${base}/parantez`, long]);
  });

  it("6. javascript:, a custom scheme, file: and vscode: do nothing on any click; the tooltip says why", async () => {
    const before = await tabsOf(PROJECT_A);
    const hitsBefore = hits.length;
    for (const text of ["JS_TIKLA", "OZEL_TIKLA", "file:///tmp/kokpit-link-test", "vscode://file/tmp"]) {
      await clickOn(text, CMD);
      await clickOn(text, OPT_CMD);
      await clickOn(text);
    }
    await hover("JS_TIKLA");
    await expect.poll(async () => (await tip().locator("span").allTextContents()).at(-1), { timeout: UI_TIMEOUT_MS }).toBe(`Bu tür bağlantı açılmaz (javascript:) · ${linkDefaults.text.refusedCopy}`);
    // From a link further up, not from the row right above (see §19: xterm may miss the first hover there).
    await hover("/duz?x=1");
    await expect.poll(async () => (await tip().locator("span").allTextContents())[0], { timeout: UI_TIMEOUT_MS }).toBe(`${base}/duz?x=1`);
    await hover("OZEL_TIKLA");
    await expect.poll(async () => (await tip().locator("span").allTextContents()).at(-1), { timeout: UI_TIMEOUT_MS }).toBe(`Bu tür bağlantı açılmaz (kokpit-test-scheme:) · ${linkDefaults.text.refusedCopy}`);
    await sleep(REFUSAL_WAIT_MS);
    expect(await tabsOf(PROJECT_A)).toEqual(before);
    expect(await externalOpens(app!)).toEqual([]);
    expect(hits.slice(hitsBefore).filter((h) => !h.endsWith(" /favicon.ico"))).toEqual([]);
    expect(dialogs).toEqual([]);
    // The javascript: link's code would have retitled the app's own page.
    expect(await page.title()).not.toContain("JS_CALISTI");
    expect(await confirmBar().count()).toBe(0);
  });

  it("7. ⌥⌘ click sends the link to the default browser (recorded here, never opened) and leaves the project's Chrome alone", async () => {
    const before = await tabsOf(PROJECT_A);
    await clickOn("/duz?x=1", OPT_CMD);
    await expect.poll(() => externalOpens(app!), { timeout: UI_TIMEOUT_MS }).toEqual([`${base}/duz?x=1`]);
    await sleep(REFUSAL_WAIT_MS);
    expect(await tabsOf(PROJECT_A)).toEqual(before);
  });

  it("8. right click on a link: the real target, Tarayıcıda aç, Varsayılan tarayıcıda aç, Bağlantıyı kopyala", async () => {
    const reportsBefore = mouseReports(trackLog);
    await writeClipboard(SENTINEL);
    const menu = await menuOn("Belgeler_Baglantisi", linkDefaults.labels.copyLink);
    expect(menu).toEqual([
      { label: `${base}/osc8`, enabled: false },
      { label: linkDefaults.labels.openBrowser, enabled: true },
      { label: linkDefaults.labels.openExternal, enabled: true },
      { label: linkDefaults.labels.copyLink, enabled: true },
    ]);
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe(`${base}/osc8`);

    await menuOn("/parantez", linkDefaults.labels.openExternal);
    await expect.poll(() => externalOpens(app!), { timeout: UI_TIMEOUT_MS }).toEqual([`${base}/parantez`]);

    const before = await tabsOf(PROJECT_A);
    await menuOn("/duz?x=1", linkDefaults.labels.openBrowser);
    await openedNewTab(PROJECT_A, before, `${base}/duz?x=1`);

    // A link that is never opened can still be copied — and only that.
    await writeClipboard(SENTINEL);
    const refused = await menuOn("OZEL_TIKLA", linkDefaults.labels.copyLink);
    expect(refused.map((i) => i.label)).toEqual(["kokpit-test-scheme://calistir", linkDefaults.labels.copyLink]);
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe("kokpit-test-scheme://calistir");
    // None of these right clicks was reported to the program.
    expect(mouseReports(trackLog)).toBe(reportsBefore);
  });

  it("9. an OSC 8 link whose text reads like another site's address asks first, showing both; “Yine de aç” opens the real target", async () => {
    const before = await tabsOf(PROJECT_A);
    await clickOn("ornek.invalid/sahte", CMD);
    await expect.poll(() => confirmBar().count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    expect(await confirmBar().locator('[data-kind="shown"]').textContent()).toBe(`${linkDefaults.text.confirmShown}: https://ornek.invalid/sahte`);
    expect(await confirmBar().locator('[data-kind="target"]').textContent()).toBe(`${linkDefaults.text.confirmTarget}: ${base}/gercek`);
    await shot("03-sahte-baglanti");
    await sleep(REFUSAL_WAIT_MS);
    expect(await tabsOf(PROJECT_A)).toEqual(before);

    await confirmBar().getByRole("button", { name: linkDefaults.text.confirmCancel }).click();
    expect(await confirmBar().count()).toBe(0);
    await sleep(REFUSAL_WAIT_MS);
    expect(await tabsOf(PROJECT_A)).toEqual(before);

    await clickOn("ornek.invalid/sahte", CMD);
    await confirmBar().getByRole("button", { name: linkDefaults.text.confirmOpen }).click();
    await activeIs(PROJECT_A, `${base}/gercek`);
    expect(hits.some((h) => h.includes("ornek.invalid"))).toBe(false);
  });

  it("10. in a program that does not track the mouse a plain click opens the link, and hovering underlines it", async () => {
    await startTui(plainLog, "plain");
    await hover("/duz?x=1");
    await expect.poll(pointerShown, { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(async () => (await tip().locator("span").allTextContents())[1], { timeout: UI_TIMEOUT_MS }).toBe("Tıkla ya da ⌘ tıkla: Mac mini'deki tarayıcıda açılır");
    const before = await tabsOf(PROJECT_A);
    await clickOn("/parantez");
    await openedNewTab(PROJECT_A, before, `${base}/parantez`);
  });

  it("11. the terminal's own project decides: a link of A asked while the engine is slow opens in A's Chrome after the user moved to B, and B's layout stays as it was", async () => {
    // B: the user closed its Tarayıcı panel.
    await selectProject(PROJECT_B);
    await clickMenu(app!, ["Görünüm", "Tarayıcı"]);
    await expect.poll(() => browserPanel().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    await selectProject(PROJECT_A);
    await expect.poll(async () => (await xtermText(activePane())).includes("LINK_TUI_HAZIR"), { timeout: UI_TIMEOUT_MS }).toBe(true);
    const before = await tabsOf(PROJECT_A);

    // The engine does not answer for a moment: the link is asked for in A, then B is put on screen.
    const resume = pauseEngine(engine!);
    try {
      await clickOn("/yerel", CMD);
      await rail().getByRole("button", { name: PROJECT_B, exact: true }).click();
      await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT_B);
    } finally {
      resume();
    }
    await openedNewTab(PROJECT_A, before, `http://localhost:${port}/yerel`);
    await sleep(REFUSAL_WAIT_MS);
    // B: no browser was started for it, and its panel was not brought up for A's link.
    expect((await tabsOf(PROJECT_B)).running).toBe(false);
    expect(await page.locator(".kp-header__title").textContent()).toBe(PROJECT_B);
    expect(await browserPanel().count()).toBe(0);
    await shot("04-b-secili");
  });

  it("12. a project whose browser runs on this machine: ⌘ click hands the link to its own-profile Chrome here, not to the engine", async () => {
    await selectProject(PROJECT_CLIENT);
    const log = join(root, "stdin-istemci.log");
    await startTui(log, "track");
    await hover("/duz?x=1");
    await page.keyboard.down("Meta");
    try {
      await expect.poll(async () => (await tip().locator("span").allTextContents())[1], { timeout: UI_TIMEOUT_MS }).toBe(`⌘ tıkla: ${linkDefaults.text.client}`);
    } finally {
      await page.keyboard.up("Meta");
    }
    const profile = join(userDataDir, browserDefaults.profilesDirName, projectIds[PROJECT_CLIENT]!);
    expect(chromeCommands(profile)).toEqual([]);
    await clickOn("/parantez", CMD);
    // Chrome was started with this machine's profile for the project and the address as its last argument.
    await expect.poll(() => chromeCommands(profile).some((c) => c.trimEnd().endsWith(` ${base}/parantez`)), { timeout: UI_TIMEOUT_MS }).toBe(true);
    const command = chromeCommands(profile).find((c) => c.includes(`${base}/parantez`))!;
    expect(command).toContain("--headless=new");
    expect(command).toContain("--use-mock-keychain");
    expect(command).not.toContain("--remote-debugging");
    await sleep(REFUSAL_WAIT_MS);
    expect((await tabsOf(PROJECT_CLIENT)).running).toBe(false);
    expect(await externalOpens(app!)).toEqual([]);
    expect(mouseReports(log)).toBe(0);
  });

  it("13. nothing was ever opened without a gesture, and nothing reached the real default browser", async () => {
    // Every address the test server saw is one a step above asked for.
    const asked = new Set(["/duz?x=1", "/osc8", "/yerel", "/parantez", `/uzun/${"u".repeat(LONG_PATH_CHARS)}/SON`, "/gercek", "/favicon.ico"]);
    expect(hits.map((h) => h.split(" ")[1]).filter((path) => !asked.has(path!))).toEqual([]);
    expect(await externalOpens(app!)).toEqual([]);
    expect(dialogs).toEqual([]);
    const shell = await app!.evaluate(() => typeof (globalThis as unknown as { __kokpitExternalOpens?: string[] }).__kokpitExternalOpens);
    expect(shell).toBe("object");
  });
});
