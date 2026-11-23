// Kopyalama end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
// "Claude terminalinden hiçbir şey kopyalayamıyorum": a fake full-screen program (fixtures/fake-tui.mjs — never the
// real `claude`) turns on mouse tracking and writes OSC 52, exactly what makes copying fail in a plain xterm.
// The system clipboard is the real one (read in the main process); the text it held is put back afterwards.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, git, launchApp, launchTerminal, SCREENSHOT_DIR, sleep, startEngine, stopEngine, xtermLines, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
/** Long enough for an OSC 52 write to have reached the clipboard if it were (wrongly) honoured. */
const REFUSAL_WAIT_MS = 1_500;
const PROJECT = "Kopya Projesi";
const FAKE_TUI = fileURLToPath(new URL("./fixtures/fake-tui.mjs", import.meta.url));
/** The texts moved to the catalogs (i18n); these tests run the app in Turkish. */
const trCatalog = (area: string) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/tr/${area}.json`, import.meta.url), "utf8"));
const copyDefaults = JSON.parse(readFileSync(new URL("../src/renderer/engine/clipboard.defaults.json", import.meta.url), "utf8")) as {
  osc52MaxBytes: number;
  selectionHint: string;
  labels: { cut: string; copy: string; paste: string; selectAll: string };
};
Object.assign(copyDefaults, { labels: trCatalog("main").contextMenu, selectionHint: trCatalog("terminal").clipboard.selectionHint });
// Computed by the shell, so the typed command line never matches.
const SHELL_CMD = "echo DUZ_KABUK_$((6*7))_SATIRI";
const SHELL_OUT = "DUZ_KABUK_42_SATIRI";
const TUI_LINE = "TUI_SATIRI_SECILECEK_4711";
const FILE_TEXT = "echo DOSYADAN_$((40+2))_KOPYA\n";
const FILE_OUT = "DOSYADAN_42_KOPYA";
/** What the clipboard holds while a test expects it not to change. */
const SENTINEL = `KOKPIT_E2E_NOBETCI_${randomBytes(4).toString("hex")}`;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("copy", () => ({ app, page, engine }));
let stdinLog: string;
let previousClipboard: string | undefined;

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panel = (): Locator => page.getByRole("region", { name: "Terminaller", exact: true });
const tabList = (): Locator => panel().getByRole("tablist", { name: "Terminal sekmeleri" });
const paneOf = (title: string): Locator => panel().locator('[role="tabpanel"]').filter({ has: page.locator(`[aria-label="Terminal: ${title}"]`) });
const files = (): Locator => page.getByRole("region", { name: "Dosyalar", exact: true });

const readClipboard = (): Promise<string> => app!.evaluate(({ clipboard }) => clipboard.readText());
/** Markers this file's texts carry: tells the tests' clipboard contents from something the user copied meanwhile. */
const OURS = /NOBETCI|DUZ_KABUK|TUI_|OSC52_|YAPISTIR_|DOSYADAN_|satir1|komut\.txt/;
const writeClipboard = (text: string): Promise<void> => app!.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
const stdin = (): string => (existsSync(stdinLog) ? readFileSync(stdinLog, "latin1") : "");
/** SGR mouse reports (press/drag/release) the program received. */
const mouseReports = (): number => (stdin().match(/\x1b\[<\d+;\d+;\d+[Mm]/g) ?? []).length;

interface PopupItem {
  label: string;
  role: string | undefined;
  enabled: boolean;
}
type PopupStore = { __popups: Electron.Menu[]; __popupClick: string | null };
/**
 * Native context menus are recorded in main instead of shown: a real popup would sit on the user's screen and block.
 * `__popupClick` names the item to choose (by label) as soon as a menu opens.
 */
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
/** The context menus opened since the last call. */
async function takePopups(): Promise<PopupItem[][]> {
  return app!.evaluate(() => {
    const g = globalThis as unknown as PopupStore;
    return g.__popups.splice(0).map((m) => m.items.map((i) => ({ label: i.label, role: i.role as string | undefined, enabled: i.enabled })));
  });
}
/** Right-clicks and returns the one context menu that opened; `choose` clicks an item of it by label. */
async function contextMenu(target: Locator | { x: number; y: number }, choose: string | null = null): Promise<PopupItem[]> {
  await takePopups();
  await app!.evaluate((_electron, label) => {
    (globalThis as unknown as PopupStore).__popupClick = label;
  }, choose);
  if ("x" in target) await page.mouse.click(target.x, target.y, { button: "right" });
  else await target.click({ button: "right" });
  let menus: PopupItem[][] = [];
  await expect.poll(async () => (menus = menus.concat(await takePopups())).length, { timeout: UI_TIMEOUT_MS }).toBe(1);
  return menus[0]!;
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `kopya-${name}.png`) });
}

async function waitForText(title: string, text: string): Promise<void> {
  await expect.poll(() => xtermText(paneOf(title)), { timeout: UI_TIMEOUT_MS, interval: 100 }).toContain(text);
}

/** Drags across the whole terminal row that shows `text` (as its own line), with optional modifier keys held. */
async function dragRow(title: string, text: string, modifiers: readonly string[] = []): Promise<void> {
  const pane = paneOf(title);
  const index = (await xtermLines(pane)).findIndex((l) => l === text);
  if (index < 0) throw new Error(`row "${text}" not on screen`);
  const row = pane.locator(".xterm-rows > div").nth(index);
  const box = await row.boundingBox();
  if (!box) throw new Error("row has no box");
  const y = box.y + box.height / 2;
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 5 });
  await page.mouse.move(box.x + box.width - 1, y, { steps: 5 });
  await page.mouse.up();
  for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
}

/** One key to the fake TUI, waiting until it echoed it. */
async function tuiKey(title: string, key: string): Promise<void> {
  const before = (await xtermText(paneOf(title))).split(`TUS_${key}`).length;
  await page.keyboard.type(key);
  await expect.poll(async () => (await xtermText(paneOf(title))).split(`TUS_${key}`).length, { timeout: UI_TIMEOUT_MS, interval: 100 }).toBeGreaterThan(before);
}

let TUI_CMD: string;

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-copy-")));
  const repo = join(root, "depo");
  mkdirSync(repo);
  mkdirSync(join(root, "home"));
  writeFileSync(join(repo, "komut.txt"), FILE_TEXT);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "ilk");
  stdinLog = join(root, "tui-stdin.log");
  TUI_CMD = `'${process.execPath}' '${FAKE_TUI}' '${stdinLog}'`;

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
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home") });
  // Never start the seeded global default tool (claude).
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await engineRequest(engine.url, KEY, "projects.create", { name: PROJECT, location: { kind: "local", path: repo } });

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  previousClipboard = await readClipboard();
  await recordPopups();
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().getByRole("button", { name: PROJECT, exact: true }).click();
});

afterAll(async () => {
  // The tests run on the user's Mac: give the clipboard its text back.
  // If the user copied something else in the meantime, that stays.
  if (app && previousClipboard !== undefined && OURS.test(await readClipboard().catch(() => ""))) await writeClipboard(previousClipboard).catch(() => {});
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Kopyalama end-to-end", () => {
  it("1. plain shell output: drag-select + Cmd+C puts the text on the clipboard", async () => {
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await launchTerminal(page, SHELL_CMD);
    await waitForText(SHELL_CMD, SHELL_OUT);
    await writeClipboard(SENTINEL);
    await dragRow(SHELL_CMD, SHELL_OUT);
    await page.keyboard.press("Meta+c");
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe(SHELL_OUT);
    await shot("01-kabuk-secim");
  });

  it("2. Düzen › Kopyala copies the terminal selection; Düzen › Yapıştır types the clipboard into the shell", async () => {
    await writeClipboard(SENTINEL);
    await dragRow(SHELL_CMD, SHELL_OUT);
    // What the native Edit menu's copy / paste roles do (their macOS selectors end in these calls).
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy());
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe(SHELL_OUT);

    await writeClipboard("echo YAPISTIR_$((9*9))_OK");
    await paneOf(SHELL_CMD).locator(".xterm").click();
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.paste());
    await waitForText(SHELL_CMD, "echo YAPISTIR_$((9*9))_OK");
    await page.keyboard.press("Enter");
    await waitForText(SHELL_CMD, "YAPISTIR_81_OK");
  });

  it("3. the Edit menu has copy, paste, cut and select-all", async () => {
    const roles = await app!.evaluate(({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).flatMap((top) => (top.submenu?.items ?? []).map((i) => i.role as string | undefined)),
    );
    for (const role of ["copy", "paste", "cut", "selectall"]) expect(roles.map((r) => r?.toLowerCase())).toContain(role);
  });

  it("4. a program with mouse tracking on gets a plain drag; nothing is selected and the hint shows once", async () => {
    await launchTerminal(page, TUI_CMD);
    await waitForText(TUI_CMD, "TUI_HAZIR");
    await writeClipboard(SENTINEL);
    expect(mouseReports()).toBe(0);
    await dragRow(TUI_CMD, TUI_LINE);
    await expect.poll(mouseReports, { timeout: UI_TIMEOUT_MS }).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Meta+c");
    await sleep(REFUSAL_WAIT_MS);
    expect(await readClipboard()).toBe(SENTINEL);
    // The one-time hint names the modifier.
    const hint = paneOf(TUI_CMD).locator(".kp-term__hint");
    await expect.poll(() => hint.count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    expect(await hint.textContent()).toBe(copyDefaults.selectionHint);
    await shot("04-ipucu");
  });

  it("5. Option-drag selects locally while mouse tracking is on; Cmd+C copies; the program sees no mouse report", async () => {
    const before = mouseReports();
    await dragRow(TUI_CMD, TUI_LINE, ["Alt"]);
    await page.keyboard.press("Meta+c");
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe(TUI_LINE);
    expect(mouseReports()).toBe(before);
    await shot("05-option-secim");
  });

  it("6. Shift-drag selects locally too", async () => {
    await writeClipboard(SENTINEL);
    const before = mouseReports();
    await dragRow(TUI_CMD, "TUI_HAZIR", ["Shift"]);
    await page.keyboard.press("Meta+c");
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe("TUI_HAZIR");
    expect(mouseReports()).toBe(before);
  });

  it("7. Ctrl+C still reaches the program, with a selection present", async () => {
    await dragRow(TUI_CMD, TUI_LINE, ["Alt"]);
    await page.keyboard.press("Control+c");
    await expect.poll(() => stdin().includes("\x03"), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await waitForText(TUI_CMD, "TUS_CTRL_C");
  });

  it("8. OSC 52 from the program lands on the system clipboard (BEL and ST terminated, empty target)", async () => {
    await paneOf(TUI_CMD).locator(".xterm").click({ modifiers: ["Alt"] });
    await writeClipboard(SENTINEL);
    await tuiKey(TUI_CMD, "w");
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe("OSC52_YAZILDI_çğış_1");
    await tuiKey(TUI_CMD, "s");
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe("OSC52_ST_4");
    await tuiKey(TUI_CMD, "e");
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe("OSC52_BOS_HEDEF_3");
  });

  it("9. an OSC 52 read request is refused: the program gets no reply and the clipboard is untouched", async () => {
    await writeClipboard(SENTINEL);
    const before = stdin().length;
    await tuiKey(TUI_CMD, "r");
    await sleep(REFUSAL_WAIT_MS);
    // Only the key itself arrived — no OSC 52 answer carrying the clipboard.
    expect(stdin().slice(before)).toBe("r");
    expect(stdin()).not.toContain(Buffer.from(SENTINEL).toString("base64"));
    expect(await readClipboard()).toBe(SENTINEL);
  });

  it("10. oversized and malformed OSC 52 payloads are refused without breaking the terminal", async () => {
    await writeClipboard(SENTINEL);
    expect(copyDefaults.osc52MaxBytes).toBeLessThan(4 * 1024 * 1024); // the fake TUI's oversized write
    await tuiKey(TUI_CMD, "b");
    await tuiKey(TUI_CMD, "g");
    await sleep(REFUSAL_WAIT_MS);
    expect(await readClipboard()).toBe(SENTINEL);
    // Still alive and still copying.
    await tuiKey(TUI_CMD, "x");
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe("OSC52_YAZILDI_2");
  });

  it("11. paste reaches the program bracketed (Cmd+V and Düzen › Yapıştır)", async () => {
    await writeClipboard("satir1\nsatir2");
    const before = stdin().length;
    await page.keyboard.press("Meta+v");
    await expect.poll(() => stdin().slice(before), { timeout: UI_TIMEOUT_MS }).toBe("\x1b[200~satir1\rsatir2\x1b[201~");
    const again = stdin().length;
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.paste());
    await expect.poll(() => stdin().slice(again), { timeout: UI_TIMEOUT_MS }).toBe("\x1b[200~satir1\rsatir2\x1b[201~");
  });

  it("12. a re-attached terminal does not replay old OSC 52 writes into the clipboard", async () => {
    // The engine's buffer still holds the earlier OSC 52 sequences; a relaunch replays it.
    await writeClipboard(SENTINEL);
    await page.reload();
    await tabList().locator(`[role="tab"][data-title="${TUI_CMD}"]`).click();
    await waitForText(TUI_CMD, "TUS_x");
    await sleep(REFUSAL_WAIT_MS);
    expect(await readClipboard()).toBe(SENTINEL);
    // The terminal tab's tooltip carries the selection hint.
    expect(await tabList().locator(`[role="tab"][data-title="${TUI_CMD}"]`).getAttribute("title")).toContain(copyDefaults.selectionHint);
  });

  it("13. Dosyalar preview → select → Cmd+C → paste into the terminal", async () => {
    await writeClipboard(SENTINEL);
    await files().getByRole("list", { name: "Dosya ağacı" }).getByRole("button", { name: "komut.txt", exact: true }).click();
    const code = files().getByRole("region", { name: "Önizleme" }).locator("code");
    await expect.poll(() => code.textContent(), { timeout: UI_TIMEOUT_MS }).toBe(FILE_TEXT);
    // Triple click selects the line, as a user would.
    await code.click({ clickCount: 3 });
    await page.keyboard.press("Meta+c");
    await expect.poll(async () => (await readClipboard()).trim(), { timeout: UI_TIMEOUT_MS }).toBe(FILE_TEXT.trim());
    // The narrow Dosyalar column opened the file in the large preview; Esc returns to the panel.
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".kp-files__preview--large").count(), { timeout: UI_TIMEOUT_MS }).toBe(0);

    await tabList().locator(`[role="tab"][data-title="${SHELL_CMD}"]`).click();
    await paneOf(SHELL_CMD).locator(".xterm").click();
    await page.keyboard.press("Meta+v");
    await waitForText(SHELL_CMD, FILE_TEXT.trim());
    await page.keyboard.press("Enter");
    await waitForText(SHELL_CMD, FILE_OUT);
    await shot("13-dosyadan-terminale");
  });

  it("14. the file's path and name in Dosyalar can be selected and copied", async () => {
    await writeClipboard(SENTINEL);
    await files().locator(".kp-files__path").click({ clickCount: 3 });
    await page.keyboard.press("Meta+c");
    await expect.poll(async () => (await readClipboard()).trim(), { timeout: UI_TIMEOUT_MS }).toBe("komut.txt");
    // Right click on the selected text: the native menu copies the selection.
    const menu = await contextMenu(files().locator(".kp-files__path"));
    expect(menu.map((i) => [i.label, i.role?.toLowerCase(), i.enabled])).toEqual([[copyDefaults.labels.copy, "copy", true]]);
  });

  it("15. right click on a file in the tree or on a terminal tab (buttons, not selectable) offers Kopyala for its value", async () => {
    await writeClipboard(SENTINEL);
    await page.evaluate(() => getSelection()?.removeAllRanges());
    const entry = files().getByRole("list", { name: "Dosya ağacı" }).getByRole("button", { name: "komut.txt", exact: true });
    const menu = await contextMenu(entry, copyDefaults.labels.copy);
    expect(menu.map((i) => i.label)).toEqual([copyDefaults.labels.copy]);
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe("komut.txt");
    await writeClipboard(SENTINEL);
    await contextMenu(tabList().locator(`[role="tab"][data-title="${SHELL_CMD}"]`), copyDefaults.labels.copy);
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe(SHELL_CMD);
  });

  it("16. right click in the terminal offers Kopyala / Yapıştır for the selection; blank places open no menu", async () => {
    await dragRow(SHELL_CMD, FILE_OUT);
    const index = (await xtermLines(paneOf(SHELL_CMD))).findIndex((l) => l === FILE_OUT);
    // By position: xterm re-renders its row elements.
    const box = (await paneOf(SHELL_CMD).locator(".xterm-rows > div").nth(index).boundingBox())!;
    const menu = await contextMenu({ x: box.x + box.height, y: box.y + box.height / 2 });
    const byRole = new Map(menu.map((i) => [i.role?.toLowerCase(), i]));
    expect(byRole.get("copy")).toMatchObject({ label: copyDefaults.labels.copy, enabled: true });
    expect(byRole.get("paste")).toMatchObject({ label: copyDefaults.labels.paste, enabled: true });

    await page.evaluate(() => getSelection()?.removeAllRanges());
    await files().locator(".kp-files__gutter").click({ button: "right" });
    await sleep(REFUSAL_WAIT_MS);
    expect(await takePopups()).toEqual([]);
  });
});
