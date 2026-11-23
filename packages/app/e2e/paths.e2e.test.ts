// Yollar end-to-end: the built app (Electron, Playwright `_electron`) against a real engine and REAL headless Chrome
// (temp profile, mock keychain), with a temp HOME standing in for the user's.
// "open ~/Documents/Acme-ux-2026-11-05/index.html görmek istediğimde direkt tarayıcıda açılmalı": a fake program
// (fixtures/fake-path-tui.mjs — never the real `claude`) ends like a Claude Code session does, with that line, mouse
// tracking on. A ⌘ click on the path must show the page — with its stylesheet, script and picture — in the
// PROJECT's Chrome on the engine machine, the Tarayıcı panel brought up, and never reach the program.
// Nothing of the user's is touched: no real ~/Documents, no real `open`, no default browser; native menus are
// recorded instead of shown.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickMenu, engineRequest, externalOpens, launchApp, launchTerminal, SCREENSHOT_DIR, sleep, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
/** Long enough for something to have opened if it were (wrongly) going to. */
const REFUSAL_WAIT_MS = 1_500;
const FAKE_TUI = fileURLToPath(new URL("./fixtures/fake-path-tui.mjs", import.meta.url));
/** The texts moved to the catalogs (i18n); these tests run the app in Turkish. */
const trCatalog = (area: string) => JSON.parse(readFileSync(new URL(`../src/i18n/locales/tr/${area}.json`, import.meta.url), "utf8"));
const linkDefaults = JSON.parse(readFileSync(new URL("../src/renderer/engine/links.defaults.json", import.meta.url), "utf8")) as {
  labels: { openBrowser: string; openExternal: string; showInFiles: string; copyPath: string };
  text: Record<string, string>;
  rate: { minIntervalMs: number };
  tooltipDelayMs: number;
};
Object.assign(linkDefaults, { labels: trCatalog("links").labels, text: trCatalog("links").text });
const PROJECT = "Yol Projesi";
const REPORT = "~/Documents/Acme-ux-2026-11-05/index.html";
const PROJECT_FILE = "notlar/okuma.md";
const HIDDEN = "~/.ssh/sayfa.html";
const MISSING = "~/Documents/yok/rapor.html";
/** The page's stylesheet paints the whole page this colour; its script reports what it sees in the title. */
const PAGE_RGB = [0, 170, 60] as const;
const PAGE_TITLE = `stil:rgb(${PAGE_RGB.join(", ")}) resim:1`;
/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
/** Marks clipboard texts of this file, so the user's own clipboard is only put back over ours. */
const OURS = /Acme-ux-2026-11-05/;

let root: string;
let home: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let projectId: string;
let stdinLog: string;
let previousClipboard: string | undefined;

diagnoseFailures("paths", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const terminals = (): Locator => page.getByRole("region", { name: "Terminaller", exact: true });
const activePane = (): Locator => terminals().locator(".kp-tabs__pane--a");
const browserPanel = (): Locator => page.locator("section.kp-browser");
const filesPanel = (): Locator => page.getByRole("region", { name: "Dosyalar", exact: true });
const tip = (): Locator => activePane().locator(".kp-term__linktip");
const note = (): Locator => activePane().locator(".kp-term__linknote");

const readClipboard = (): Promise<string> => app!.evaluate(({ clipboard }) => clipboard.readText());
const writeClipboard = (text: string): Promise<void> => app!.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
/** SGR mouse reports (press/drag/release) the program received. */
const mouseReports = (): number => ((existsSync(stdinLog) ? readFileSync(stdinLog, "latin1") : "").match(/\x1b\[<\d+;\d+;\d+[Mm]/g) ?? []).length;

interface Tabs {
  running: boolean;
  tabs: { url: string; title: string }[];
  active: { url: string; title: string } | undefined;
}
async function tabsOf(): Promise<Tabs> {
  const { browser } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId })) as {
    browser: { running: boolean; activeTabId?: string; tabs: { id: string; url: string; title: string }[] };
  };
  return { running: browser.running, tabs: browser.tabs, active: browser.tabs.find((t) => t.id === browser.activeTabId) };
}

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
async function hover(text: string): Promise<void> {
  const p = await pointOf(text);
  await page.mouse.move(p.x - 4, p.y);
  await page.mouse.move(p.x, p.y, { steps: 3 });
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
async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `yol-${name}.png`) });
}
/** The colour in the middle of the Tarayıcı panel's picture of the page. */
async function panelPixel(): Promise<number[] | null> {
  return browserPanel()
    .locator("canvas")
    .first()
    .evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const ctx = canvas.getContext("2d");
      if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
      return Array.from(ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data.slice(0, 3));
    });
}
const near = (a: readonly number[] | null, b: readonly number[], tolerance = 24): boolean => a !== null && a.every((v, i) => Math.abs(v - b[i]!) <= tolerance);
function pidsWith(needle: string): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}
const write = (path: string, content: string | Buffer): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-paths-")));
  home = join(root, "home");
  const report = join(home, "Documents", "Acme-ux-2026-11-05");
  // A report as agents write them: a page with a stylesheet, a script and a picture next to it.
  write(
    join(report, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>yükleniyor</title><link rel="stylesheet" href="style.css"><body><h1>Acme UX</h1><img id="resim" src="img/a.png"><script src="app.js"></script></body>`,
  );
  write(join(report, "style.css"), `html, body { margin: 0; height: 100%; background: rgb(${PAGE_RGB.join(", ")}); } h1 { color: white; margin: 0; }`);
  write(
    join(report, "app.js"),
    `const img = document.getElementById("resim"); const say = () => { document.title = "stil:" + getComputedStyle(document.body).backgroundColor + " resim:" + img.naturalWidth; }; if (img.complete) say(); else img.addEventListener("load", say);`,
  );
  write(join(report, "img", "a.png"), PNG);
  write(join(home, ".ssh", "sayfa.html"), "<!doctype html><title>GIZLI</title>");
  write(join(root, "proje", "notlar", "okuma.md"), "# Okuma notu\nYOL_DOSYA_ICERIGI\n");
  stdinLog = join(root, "stdin.log");

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
      // The shim is not what this file tests, and no test terminal may reach the real `open`.
      files: { open: { enabled: false } },
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: home });
  // Never start the seeded global default tool (claude).
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const { project } = (await engineRequest(engine.url, KEY, "projects.create", { name: PROJECT, location: { kind: "local", path: join(root, "proje") } })) as { project: { id: string } };
  projectId = project.id;

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data"), KOKPIT_CHROME_HEADLESS: "1" });
  previousClipboard = await readClipboard();
  await recordPopups();
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().getByRole("button", { name: PROJECT, exact: true }).click();
}, 120_000);

afterAll(async () => {
  // The tests run on the user's Mac: give the clipboard its text back (unless they copied something meanwhile).
  if (app && previousClipboard !== undefined && OURS.test(await readClipboard().catch(() => ""))) await writeClipboard(previousClipboard).catch(() => {});
  await app?.close().catch(() => {});
  await stopEngine(engine);
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

describe("Yollar end-to-end", () => {
  it("1. the path of the `open` line is a link: with ⌘ held the tooltip shows the file's real place and where it opens", async () => {
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await launchTerminal(page, `'${process.execPath}' '${FAKE_TUI}' '${stdinLog}' 'open ${REPORT}' 'bkz. ${PROJECT_FILE} dosyası' 'gizli: ${HIDDEN}' 'yok: ${MISSING}'`);
    await expect.poll(() => existsSync(stdinLog), { timeout: UI_TIMEOUT_MS }).toBe(true);
    const mine = activePane().locator(`[aria-label*="${basename(FAKE_TUI)}"]`);
    await expect.poll(async () => (await mine.count()) === 1 && (await xtermText(activePane())).includes("YOL_TUI_HAZIR"), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect((await tabsOf()).running).toBe(false);

    await page.keyboard.down("Meta");
    try {
      await hover("Acme-ux-2026-11-05/index.html");
      await expect.poll(async () => (await tip().locator("span").allTextContents())[0], { timeout: UI_TIMEOUT_MS }).toBe(join(home, "Documents", "Acme-ux-2026-11-05", "index.html"));
      expect((await tip().locator("span").allTextContents())[1]).toBe("⌘ tıkla: Mac mini'deki tarayıcıda açılır");
      await shot("01-ipucu");
    } finally {
      await page.keyboard.up("Meta");
    }
    // Looking is not opening.
    expect((await tabsOf()).running).toBe(false);
  });

  it("2. a plain click there is the program's: it gets the mouse report and nothing opens", async () => {
    const before = mouseReports();
    await clickOn("Acme-ux-2026-11-05/index.html");
    await expect.poll(mouseReports, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before);
    await sleep(REFUSAL_WAIT_MS);
    expect((await tabsOf()).running).toBe(false);
  });

  it("3. ⌘ click: the page opens in the project's Chrome with its stylesheet, script and picture; the Tarayıcı panel shows it; the program never sees the click", async () => {
    // The user had closed the panel in this project's layout.
    await clickMenu(app!, ["Görünüm", "Tarayıcı"]);
    await expect.poll(() => browserPanel().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    const before = mouseReports();

    await clickOn("Acme-ux-2026-11-05/index.html", CMD);
    // The script ran, saw the stylesheet's colour on the body and the picture loaded: all from the folder's own files.
    await expect.poll(async () => (await tabsOf()).active?.title, { timeout: UI_TIMEOUT_MS, message: "the page's title, set by its script" }).toBe(PAGE_TITLE);
    // The blank tab of the Chrome this click started is not left behind (it is closed right after the page's tab
    // came to the front).
    await expect.poll(async () => (await tabsOf()).tabs.length, { timeout: UI_TIMEOUT_MS }).toBe(1);
    const tabs = await tabsOf();
    // The engine's own listener serves it — never file:, and the address names no folder of the user's.
    expect(tabs.active!.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${engine!.port}/files/preview/[A-Za-z0-9_-]{43}/index\\.html$`));
    expect(tabs.active!.url).not.toContain("Documents");

    await expect.poll(() => browserPanel().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => browserPanel().locator("canvas").count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    // What the user sees in the panel is the styled page.
    await expect.poll(async () => near(await panelPixel(), PAGE_RGB), { timeout: UI_TIMEOUT_MS, message: "the panel shows the page in its stylesheet's colour" }).toBe(true);
    expect(mouseReports()).toBe(before);
    expect(await externalOpens(app!)).toEqual([]);
    await shot("02-sayfa");
  });

  it("4. ⌘ click on a file of the project shows it in Dosyalar, selected and large; Esc brings the panel back", async () => {
    await clickOn(PROJECT_FILE, CMD);
    const preview = filesPanel().getByRole("region", { name: "Önizleme" });
    await expect.poll(async () => (await preview.count()) === 1 && (await preview.textContent())?.includes("YOL_DOSYA_ICERIGI"), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await preview.evaluate((el) => el.classList.contains("kp-files__preview--large"))).toBe(true);
    expect(await filesPanel().getByRole("button", { name: "okuma.md" }).getAttribute("aria-current")).toBe("true");
    await shot("03-dosyalar");
    await page.keyboard.press("Escape");
    await expect.poll(() => preview.evaluate((el) => el.classList.contains("kp-files__preview--large")), { timeout: UI_TIMEOUT_MS }).toBe(false);
    // No tab was opened for it.
    expect((await tabsOf()).tabs).toHaveLength(1);
  });

  it("5. right click: the path's own native menu; “Yolu kopyala” copies the file's real place", async () => {
    const before = mouseReports();
    const items = await menuOn("Acme-ux-2026-11-05/index.html", linkDefaults.labels.copyPath);
    expect(items.map((i) => i.label).slice(1)).toEqual([linkDefaults.labels.openBrowser, linkDefaults.labels.copyPath]);
    expect(items[0]!.enabled).toBe(false);
    expect(items[0]!.label.endsWith("/index.html")).toBe(true);
    await expect.poll(readClipboard, { timeout: UI_TIMEOUT_MS }).toBe(join(home, "Documents", "Acme-ux-2026-11-05", "index.html"));
    // A project file offers Dosyalar (and, being a type the preview serves, the browser); a refused one only copying.
    expect((await menuOn(PROJECT_FILE)).map((i) => i.label).slice(1)).toEqual([linkDefaults.labels.openBrowser, linkDefaults.labels.showInFiles, linkDefaults.labels.copyPath]);
    expect((await menuOn(".ssh/sayfa.html")).map((i) => i.label).slice(1)).toEqual([linkDefaults.labels.copyPath]);
    expect(mouseReports()).toBe(before);
    expect((await tabsOf()).tabs).toHaveLength(1);
  });

  it("6. a refused folder and a missing file: a short message under the terminal, nothing opens", async () => {
    await clickOn(".ssh/sayfa.html", CMD);
    await expect.poll(async () => ((await note().count()) === 1 ? await note().textContent() : null), { timeout: UI_TIMEOUT_MS }).toBe("Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez");
    await shot("04-reddedildi");
    await clickOn("yok/rapor.html", CMD);
    await expect.poll(async () => ((await note().count()) === 1 ? await note().textContent() : null), { timeout: UI_TIMEOUT_MS }).toBe("Dosya bulunamadı");
    await sleep(REFUSAL_WAIT_MS);
    const tabs = await tabsOf();
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.tabs.some((t) => t.title.includes("GIZLI"))).toBe(false);
    expect(await externalOpens(app!)).toEqual([]);
    // The engine's log never held the address's token or the user's folder path.
    const token = /preview\/([A-Za-z0-9_-]{43})\//.exec(tabs.active!.url)![1]!;
    expect(engine!.log()).not.toContain(token);
    expect(engine!.log()).toContain('"root":"Acme-ux-2026-11-05"');
  });
});
