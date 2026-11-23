// Kopyalama — akıtılan yüzeyler, end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
//   Tarayıcı:     the engine's real HEADLESS Chrome (temp profile, mock keychain) showing a local test page.
// The LOCAL clipboard is the real one of this Mac (read / written in the app's main process): every text written
// carries a marker, and the text it held before is put back at the end unless the user copied something meanwhile.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserState } from "@kokpit/shared";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diagnoseFailures } from "./diagnostics.ts";
import { clickMenu, engineRequest, git, launchApp, launchTerminal, menuItem, SCREENSHOT_DIR, sleep, startEngine, stopEngine, xtermLines, xtermText, type EngineHandle } from "./harness.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
/** Long enough for a (wrong) clipboard write or pasteboard run to have happened. */
const QUIET_MS = 1_500;
const PROJECT = "Pano Projesi";
/** The texts moved to the catalogs (i18n); these tests run the app in Turkish. */
const trCatalog = (area: string) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/tr/${area}.json`, import.meta.url), "utf8"));
const copyDefaults = JSON.parse(readFileSync(new URL("../src/renderer/engine/clipboard.defaults.json", import.meta.url), "utf8")) as {
  labels: { cut: string; copy: string; paste: string; copyLink: string; copyAddress: string };
};
Object.assign(copyDefaults, { labels: trCatalog("main").contextMenu });
/** Every text this file puts on the real clipboard matches this: tells ours from something the user copied meanwhile. */
const OURS = /uzak pano|SAYFADAN_|DOSYADAN_|UZAK_PANO_|YEREL_PANO_|KOKPIT_E2E_NOBETCI_|\/hedef|pano-sayfa|HAZIR_/;
const SENTINEL = `KOKPIT_E2E_NOBETCI_${randomBytes(4).toString("hex")}`;
/** Computed by the shell, so the typed command never matches its output. */
const PAGE_COMMAND = "echo SAYFADAN_$((6*7))_OK";
const PAGE_OUT = "SAYFADAN_42_OK";
const FILE_TEXT = "DOSYADAN_GIRDI_ığüşöç";
const READY_CMD = "echo HAZIR_$((1+1))";
const READY_OUT = "HAZIR_2";
/** The engine names its same-machine probe differently from what the app accepts: the app sees "another Mac". */
const REMOTE_PROBE_NAME = "baska-makine.probe";

/**
 * The remote page, laid out in viewport fractions so a point of the picture is the same element at any panel size:
 * 0–20 % a paragraph (the command), 20–30 % a link, 30–50 % an input, 50–75 % a textarea, 75–100 % a
 * contenteditable. What the fields hold is reported in the title (read back through the engine's tab list).
 */
const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>pano-sayfa</title></head>
<body style="margin:0;font-family:monospace;background:#fff">
<p id="p" style="position:absolute;left:0;top:0;width:100vw;height:20vh;margin:0;padding:2vh 2vw;box-sizing:border-box;font-size:8vh;line-height:1;white-space:nowrap;overflow:hidden">${PAGE_COMMAND}</p>
<a id="a" href="/hedef" style="position:absolute;left:0;top:20vh;width:100vw;height:10vh;font-size:6vh;line-height:10vh">baglanti</a>
<input id="i" style="position:absolute;left:0;top:30vh;width:100vw;height:20vh;font-size:8vh;box-sizing:border-box">
<textarea id="t" style="position:absolute;left:0;top:50vh;width:100vw;height:25vh;font-size:6vh;box-sizing:border-box"></textarea>
<div id="ce" contenteditable style="position:absolute;left:0;top:75vh;width:100vw;height:25vh;font-size:6vh;background:#eef"></div>
<script>
  let ctx = 0;
  const el = (id) => document.getElementById(id);
  const report = () => { document.title = 'i=' + el('i').value + '|t=' + el('t').value + '|ce=' + el('ce').textContent + '|ctx=' + ctx; };
  for (const id of ['i', 't', 'ce']) el(id).addEventListener('input', report);
  addEventListener('contextmenu', (e) => { e.preventDefault(); ctx++; report(); });
</script></body></html>`;
/** Points of the picture, as fractions of its width and height. */
const AT = { paragraph: [0.08, 0.06], link: [0.05, 0.25], input: [0.5, 0.4], textarea: [0.5, 0.62], editable: [0.5, 0.87] } as const;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let site: http.Server;
let siteUrl: string;
let projectId: string;
let previousClipboard: string | undefined;

diagnoseFailures("copy-streams", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const browser = (): Locator => page.locator("section.kp-browser");
const browserCanvas = (): Locator => browser().locator("canvas");
const browserFrames = async (): Promise<number> => Number((await browserCanvas().getAttribute("data-frames")) ?? "0");
const terminals = (): Locator => page.getByRole("region", { name: "Terminaller", exact: true });
const paneOf = (title: string): Locator => terminals().locator('[role="tabpanel"]').filter({ has: page.locator(`[aria-label="Terminal: ${title}"]`) });
const files = (): Locator => page.getByRole("region", { name: "Dosyalar", exact: true });

const readClipboard = (): Promise<string> => app!.evaluate(({ clipboard }) => clipboard.readText());
const writeClipboard = (text: string): Promise<void> => app!.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
/** What the native Edit menu's (and a context menu's) copy / cut / paste roles do on macOS. */
const editRole = (role: "copy" | "cut" | "paste"): Promise<void> =>
  app!.evaluate(({ BrowserWindow }, r) => BrowserWindow.getAllWindows()[0]!.webContents[r](), role);

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `pano-${name}.png`) });
}

/** The active tab of the engine's Chrome, as the engine reports it. */
async function remoteTab(): Promise<{ title: string; url: string }> {
  const { browser: state } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as { browser: BrowserState };
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  return { title: tab?.title ?? "", url: tab?.url ?? "" };
}
const remoteTitle = async (): Promise<string> => (await remoteTab()).title;

async function pointOn(canvas: Locator, at: readonly [number, number]): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no box");
  return { x: box.x + at[0] * box.width, y: box.y + at[1] * box.height };
}

interface PopupItem {
  label: string;
  role: string | undefined;
  enabled: boolean;
  type: string;
}
type PopupStore = { __popups: Electron.Menu[]; __popupClick: string | null };
/**
 * Native context menus are recorded in main instead of shown (a real popup would sit on the user's screen and
 * block). `__popupClick` names an item to click as soon as a menu opens — for items with their own click handler;
 * role items are native on macOS and are exercised with `editRole`.
 */
async function recordPopups(target: ElectronApplication): Promise<void> {
  await target.evaluate(({ Menu }) => {
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
    return g.__popups.splice(0).map((m) => m.items.map((i) => ({ label: i.label, role: i.role as string | undefined, enabled: i.enabled, type: i.type })));
  });
}
/** Right-clicks a point of the browser picture (with optional modifier keys) and returns the menus that opened. */
async function rightClickPage(at: readonly [number, number], opts: { choose?: string; modifiers?: string[]; expectMenu?: boolean } = {}): Promise<PopupItem[][]> {
  await takePopups();
  await app!.evaluate((_electron, label) => {
    (globalThis as unknown as PopupStore).__popupClick = label;
  }, opts.choose ?? null);
  const p = await pointOn(browserCanvas(), at);
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y, { button: "right" });
  for (const m of [...(opts.modifiers ?? [])].reverse()) await page.keyboard.up(m);
  let menus: PopupItem[][] = [];
  if (opts.expectMenu === false) {
    await sleep(QUIET_MS);
    return takePopups();
  }
  await expect.poll(async () => (menus = menus.concat(await takePopups())).length, { timeout: UI_TIMEOUT_MS }).toBe(1);
  return menus;
}
const labels = (menu: PopupItem[]): string[] => menu.map((i) => (i.type === "separator" ? "—" : i.label));
const item = (menu: PopupItem[], label: string): PopupItem | undefined => menu.find((i) => i.label === label);

async function waitForTerminal(title: string, text: string): Promise<void> {
  await expect.poll(() => xtermText(paneOf(title)), { timeout: UI_TIMEOUT_MS, interval: 100 }).toContain(text);
}

/** Drags across the whole terminal row that shows `text` as its own line. */
async function dragRow(title: string, text: string): Promise<void> {
  const pane = paneOf(title);
  const index = (await xtermLines(pane)).findIndex((l) => l === text);
  if (index < 0) throw new Error(`row "${text}" not on screen`);
  const box = await pane.locator(".xterm-rows > div").nth(index).boundingBox();
  if (!box) throw new Error("row has no box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 5 });
  await page.mouse.move(box.x + box.width - 1, y, { steps: 5 });
  await page.mouse.up();
}


function pidsWith(needle: string): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}
function killAll(needle: string): void {
  for (const pid of pidsWith(needle)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Engine config for one test engine: headless test Chrome. */
function writeEngineConfig(dir: string): string {
  const configPath = join(dir, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(dir, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      // Test-only: no window and no keychain dialog on the desktop.
      browser: { headless: true, testMode: true },
    }),
  );
  return configPath;
}

async function connect(target: Page, url: string): Promise<void> {
  await target.waitForLoadState("domcontentloaded");
  await target.getByLabel("Motor adresi").fill(url);
  await target.getByLabel("Anahtar").fill(KEY);
  await target.getByRole("button", { name: "Bağlan" }).click();
}

/**
 * Cmd+V. The panels leave this key alone (the clipboard's text comes with the browser's paste event). From a real
 * keyboard macOS then hands the key to the menu, whose Yapıştır role pastes (`editRole("paste")` is that half);
 * Playwright's synthetic key carries Chromium's own "paste" command instead. Either way: one paste event.
 */
async function pressPaste(): Promise<void> {
  await page.keyboard.press("Meta+v");
}


beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-pano-")));
  const repo = join(root, "depo");
  mkdirSync(repo);
  writeFileSync(join(repo, "girdi.txt"), `${FILE_TEXT}\n`);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "ilk");

  site = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(TEST_PAGE);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

  // No temp HOME: Chrome would then look for a login keychain that does not exist and show a dialog.
  engine = await startEngine(writeEngineConfig(root), KEY);
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const created = (await engineRequest(engine.url, KEY, "projects.create", { name: PROJECT, location: { kind: "local", path: repo } })) as { project: { id: string } };
  projectId = created.project.id;

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  previousClipboard = await readClipboard();
  await recordPopups(app);
  page = await app.firstWindow();
  await connect(page, engine.url);
  await rail().getByRole("button", { name: PROJECT, exact: true }).click();
}, 180_000);

afterAll(async () => {
  // The tests run on the user's Mac: give the clipboard its text back — unless the user copied something meanwhile.
  if (app && previousClipboard !== undefined && OURS.test(await readClipboard().catch(() => ""))) await writeClipboard(previousClipboard).catch(() => {});
  await app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((r) => (site ? site.close(() => r()) : r()));
  if (root) {
    killAll(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Kopyalama: Tarayıcı sayfası ↔ bu bilgisayarın panosu", () => {
  it("1. the page is shown; the address bar itself copies and pastes like any input", async () => {
    await browser().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(browserFrames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    const address = browser().getByLabel("Adres");
    await address.fill(`${siteUrl}/`);
    await address.press("Enter");
    await expect.poll(remoteTitle, { timeout: UI_TIMEOUT_MS }).toBe("pano-sayfa");
    await writeClipboard(SENTINEL);
    // Selected again on every try: the panel rewrites the field once when the page's address arrives.
    await expect
      .poll(
        async () => {
          await address.selectText();
          await editRole("copy");
          return readClipboard();
        },
        { timeout: UI_TIMEOUT_MS, interval: 300 },
      )
      .toBe(`${siteUrl}/`);
    await writeClipboard(`${siteUrl}/hedef`);
    await address.selectText();
    await editRole("paste");
    await expect.poll(() => address.inputValue(), { timeout: UI_TIMEOUT_MS }).toBe(`${siteUrl}/hedef`);
    // Nothing of this went to the remote page: it is still the one that was opened.
    expect((await remoteTab()).url).toBe(`${siteUrl}/`);
  });

  it("2. browser page → clipboard → terminal: triple click a line of the page, Cmd+C, paste into the shell, run it", async () => {
    await writeClipboard(SENTINEL);
    const before = await browserFrames();
    const p = await pointOn(browserCanvas(), AT.paragraph);
    await page.mouse.click(p.x, p.y, { clickCount: 3 });
    // The selection is drawn in the picture.
    await expect.poll(browserFrames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before);
    await expect
      .poll(
        async () => {
          await page.keyboard.press("Meta+c");
          return (await readClipboard()).trim();
        },
        { timeout: UI_TIMEOUT_MS, interval: 300 },
      )
      .toBe(PAGE_COMMAND);
    await shot("02-sayfadan-kopya");

    await launchTerminal(page, READY_CMD);
    await waitForTerminal(READY_CMD, READY_OUT);
    await paneOf(READY_CMD).locator(".xterm").click();
    await pressPaste();
    await waitForTerminal(READY_CMD, PAGE_COMMAND);
    await page.keyboard.press("Enter");
    await waitForTerminal(READY_CMD, PAGE_OUT);
    await shot("02-terminalde");
  });

  it("3. Düzen › Kopyala copies the page's selection too; nothing selected leaves the clipboard alone", async () => {
    await writeClipboard(SENTINEL);
    const p = await pointOn(browserCanvas(), AT.paragraph);
    await page.mouse.click(p.x, p.y, { clickCount: 3 });
    await expect
      .poll(
        async () => {
          await editRole("copy");
          return (await readClipboard()).trim();
        },
        { timeout: UI_TIMEOUT_MS, interval: 300 },
      )
      .toBe(PAGE_COMMAND);
    // A single click in the (empty) input drops the selection. (First let the loop's last copy land.)
    await sleep(QUIET_MS);
    await writeClipboard(SENTINEL);
    const i = await pointOn(browserCanvas(), AT.input);
    await page.mouse.click(i.x, i.y);
    await sleep(500);
    await page.keyboard.press("Meta+c");
    await sleep(QUIET_MS);
    expect(await readClipboard()).toBe(SENTINEL);
  });

  it("4. Dosyalar → page input: select the preview line, Cmd+C, click the page's input, Cmd+V", async () => {
    await files().getByRole("list", { name: "Dosya ağacı" }).getByRole("button", { name: "girdi.txt", exact: true }).click();
    const code = files().getByRole("region", { name: "Önizleme" }).locator("code");
    await expect.poll(() => code.textContent(), { timeout: UI_TIMEOUT_MS }).toBe(`${FILE_TEXT}\n`);
    await code.click({ clickCount: 3 });
    await editRole("copy");
    await expect.poll(async () => (await readClipboard()).trim(), { timeout: UI_TIMEOUT_MS }).toBe(FILE_TEXT);
    // The narrow Dosyalar column opened the file in the large preview; Esc returns to the panel.
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".kp-files__preview--large").count(), { timeout: UI_TIMEOUT_MS }).toBe(0);

    const i = await pointOn(browserCanvas(), AT.input);
    await page.mouse.click(i.x, i.y);
    await pressPaste();
    await expect.poll(remoteTitle, { timeout: UI_TIMEOUT_MS }).toContain(`i=${FILE_TEXT}|`);
    // The key itself was not typed into the page ("v" would be in the field).
    expect(await remoteTitle()).not.toContain(`i=${FILE_TEXT}v`);
    await shot("04-dosyadan-sayfaya");
  });

  it("5. terminal → page textarea: select the shell's output line, Cmd+C, click the textarea, Düzen › Yapıştır", async () => {
    await dragRow(READY_CMD, PAGE_OUT);
    await editRole("copy");
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe(PAGE_OUT);
    const t = await pointOn(browserCanvas(), AT.textarea);
    await page.mouse.click(t.x, t.y);
    await editRole("paste");
    await expect.poll(remoteTitle, { timeout: UI_TIMEOUT_MS }).toContain(`|t=${PAGE_OUT}|`);
  });

  it("6. right click: Kokpit's menu — Kopyala (off without a selection), Yapıştır into a contenteditable, Adresi kopyala; the click stays out of the page", async () => {
    const text = "YEREL_PANO_sağ_tık_çğ";
    await writeClipboard(text);
    const e = await pointOn(browserCanvas(), AT.editable);
    await page.mouse.click(e.x, e.y);
    const [menu] = await rightClickPage(AT.editable);
    expect(labels(menu!)).toEqual([copyDefaults.labels.copy, copyDefaults.labels.paste, "—", copyDefaults.labels.copyAddress]);
    expect(item(menu!, copyDefaults.labels.copy)).toMatchObject({ role: "copy", enabled: false });
    expect(item(menu!, copyDefaults.labels.paste)).toMatchObject({ role: "paste", enabled: true });
    // Choosing Yapıştır is the paste role on the focused picture.
    await editRole("paste");
    await expect.poll(remoteTitle, { timeout: UI_TIMEOUT_MS }).toContain(`|ce=${text}|`);
    expect(await remoteTitle()).toContain("|ctx=0");
    await shot("06-sag-tik");
  });

  it("7. right click on a link offers Bağlantıyı kopyala; on a selection Kopyala is on; Adresi kopyala copies the page's address", async () => {
    await writeClipboard(SENTINEL);
    const [linkMenu] = await rightClickPage(AT.link, { choose: copyDefaults.labels.copyLink });
    expect(labels(linkMenu!)).toContain(copyDefaults.labels.copyLink);
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe(`${siteUrl}/hedef`);

    const p = await pointOn(browserCanvas(), AT.paragraph);
    await page.mouse.click(p.x, p.y, { clickCount: 3 });
    await expect
      .poll(async () => item((await rightClickPage(AT.paragraph))[0]!, copyDefaults.labels.copy)?.enabled, { timeout: UI_TIMEOUT_MS, interval: 300 })
      .toBe(true);
    await rightClickPage(AT.paragraph, { choose: copyDefaults.labels.copyAddress });
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe(`${siteUrl}/`);
    expect(await remoteTitle()).toContain("|ctx=0");
  });

  it("8. ⌥ Option + right click goes to the page (its own contextmenu handler runs) and opens no Kokpit menu", async () => {
    const menus = await rightClickPage(AT.link, { modifiers: ["Alt"], expectMenu: false });
    expect(menus).toEqual([]);
    await expect.poll(remoteTitle, { timeout: UI_TIMEOUT_MS }).toContain("|ctx=1");
  });

  it("9. Cmd+X cuts: the page's field loses the selection, the clipboard gets it", async () => {
    await writeClipboard(SENTINEL);
    const i = await pointOn(browserCanvas(), AT.input);
    // Triple click selects the input's whole line.
    await page.mouse.click(i.x, i.y, { clickCount: 3 });
    await expect
      .poll(
        async () => {
          await page.keyboard.press("Meta+x");
          return readClipboard();
        },
        { timeout: UI_TIMEOUT_MS, interval: 300 },
      )
      .toBe(FILE_TEXT);
    await expect.poll(remoteTitle, { timeout: UI_TIMEOUT_MS }).toContain("i=|");
  });
});

