// Çalışma alanı: a selected project spends no row above the dock. The dock starts right under the project tabs
// (only the work view's own row gap between them), the project's location is the tab's tooltip, the Terminal
// panel offers the launcher while it is empty, and a card's name / branch / "Kartı sil" sit in the tab strip's
// row. Real Electron against a real engine, at the default 1440×900 window. Steps run in order and share state.
// Second part — room for the screens: no panel repeats its dock tab's name in a title row, panels fill their dock
// group edge to edge, and what is left of each panel's chrome is bounded by the design tokens (theme.css). The
// usable content box of Dosyalar / Tarayıcı / Ajanlar / Terminal is written to the metrics file.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, git, launchApp, launchTerminal, menuItem, SCREENSHOT_DIR, startEngine, stopEngine, terminalLauncher, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const PROJECT = "Alan Projesi";
const CARD = "alan-karti";
const COMMAND = "echo ALAN_$((40+2))";
/** Where the measurements of this run are written (next to the screenshots), for before/after comparisons. */
const METRICS_FILE = join(SCREENSHOT_DIR, "work-area-metrics.json");

let root: string;
let repo: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("work-area", () => ({ app, page, engine }));
const metrics: Record<string, number> = {};
const saveMetrics = (): void => writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const strip = (): Locator => page.getByRole("toolbar", { name: "Proje sekmeleri" });
const dock = (): Locator => page.locator(".kp-layout");
const selectionTitle = (): Promise<string | null> => page.locator(".kp-header__title").textContent();

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `work-area-${name}.png`) });
}

interface Box {
  top: number;
  bottom: number;
  height: number;
}
async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return { top: b.y, bottom: b.y + b.height, height: b.height };
}

/** The work view's own gap between its rows, as the stylesheet resolves it (px). */
const rowGap = (): Promise<number> => page.locator(".kp-view--work").evaluate((el) => parseFloat(getComputedStyle(el).rowGap));

/** Vertical distance from the tab strip's bottom edge to the dock's top edge, and the dock's height. */
async function measure(label: string): Promise<{ gap: number; dockHeight: number }> {
  const [s, d] = [await box(strip()), await box(dock())];
  const out = { gap: d.top - s.bottom, dockHeight: d.height };
  metrics[`${label}.gap`] = out.gap;
  metrics[`${label}.dockHeight`] = out.dockHeight;
  metrics[`${label}.stripHeight`] = s.height;
  saveMetrics();
  return out;
}

describe("çalışma alanı: no header row above the dock", () => {
  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-work-area-")));
    repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(home);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "e2e\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
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
        projects: [{ name: PROJECT, repoPath: repo, id: "alan" }],
      }),
    );
    engine = await startEngine(configPath, KEY, { HOME: home });
    await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
    app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    await stopEngine(engine);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("1. a selected project: the dock starts right under the project tabs", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    await expect.poll(selectionTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await expect.poll(() => dock().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await shot("01-proje");
    const { gap } = await measure("project");
    // Nothing but the view's own row gap separates the strip from the dock.
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(await rowGap());
    // The name stays for assistive tech, without a box in the layout.
    const title = page.getByRole("heading", { level: 2, name: PROJECT, exact: true });
    expect(await title.count()).toBe(1);
    const titleBox = await title.boundingBox();
    expect(Math.max(titleBox?.width ?? 0, titleBox?.height ?? 0)).toBeLessThanOrEqual(1);
    // No launcher and no location line outside the dock.
    expect(await page.locator(".kp-view--work > *").evaluateAll((els) => els.filter((e) => e.querySelector("form") !== null && !e.classList.contains("kp-layout")).length)).toBe(0);
    expect(await page.getByText(repo, { exact: false }).count()).toBe(0);
  });

  it("2. the project's location is its tab's tooltip", async () => {
    const tab = strip().getByRole("button", { name: PROJECT, exact: true });
    expect(await tab.getAttribute("title")).toContain(repo);
  });

  it("3. an empty Terminal panel offers the launcher; the terminal opens from there", async () => {
    const launcher = page.getByRole("group", { name: "Yeni terminal" });
    await expect.poll(() => launcher.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await launcher.getByLabel("Araç").count()).toBe(1);
    await shot("02-bos-terminal");
    await launchTerminal(page, COMMAND);
    const region = page.getByRole("region", { name: `Terminal: ${COMMAND}` });
    await expect.poll(() => region.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => region.textContent(), { timeout: UI_TIMEOUT_MS }).toContain("ALAN_42");
    // With a terminal open the launcher is behind "+ Yeni terminal" again.
    expect(await launcher.count()).toBe(0);
    await shot("03-terminal");
    expect((await measure("projectWithTerminal")).gap).toBeLessThanOrEqual(await rowGap());
  });

  it("4. a card: name, branch and Kartı sil share the tab strip's row — the dock does not move", async () => {
    const before = await box(dock());
    await rail().getByRole("button", { name: `Yeni kart: ${PROJECT}` }).click();
    await rail().getByLabel("Kart adı").fill(CARD);
    await rail().getByRole("button", { name: "Oluştur" }).click();
    await expect.poll(selectionTitle, { timeout: UI_TIMEOUT_MS }).toBe(CARD);
    const bar = page.locator(".kp-cardbar");
    await expect.poll(() => bar.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await bar.locator(".kp-cardbar__branch").textContent()).toMatch(new RegExp(`^${PROJECT} / \\S+$`));
    expect(await bar.getByRole("button", { name: "Kartı sil" }).count()).toBe(1);
    await shot("04-kart");
    const { gap } = await measure("card");
    expect(gap).toBeLessThanOrEqual(await rowGap());
    const after = await box(dock());
    expect(after.top).toBe(before.top);
    expect(after.height).toBe(before.height);
    // The card's controls are on the strip's own line.
    const [s, b] = [await box(strip()), await box(bar)];
    expect(b.top).toBeGreaterThanOrEqual(s.top);
    expect(b.bottom).toBeLessThanOrEqual(s.bottom);
  });

  it("5. Kartı sil asks first; the engine's refusal shows next to it and the card stays", async () => {
    const worktree = git(repo, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .find((p) => p !== repo)!;
    writeFileSync(join(worktree, "dirty.txt"), "uncommitted\n");
    await page.getByRole("button", { name: "Kartı sil" }).click();
    await page.getByRole("button", { name: "Silmeyi onayla" }).click();
    const alert = page.locator(".kp-cardbar__error");
    await expect.poll(() => alert.textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/dirty\.txt/);
    expect(await rail().getByRole("button", { name: CARD, exact: true }).isVisible()).toBe(true);
    await shot("05-kart-silinemedi");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Room for the screens. Own engine (with a headless, test-only Chrome and a local page) and own app.
// ---------------------------------------------------------------------------------------------------------------

const SPACE_PROJECT = "Yer Projesi";
const SPACE_CARD = "yer-karti";
const SPACE_COMMAND = "echo YER_$((40+2))";
const PAGE_TITLE = "Kokpit Yer Sayfası";
const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head>
<body style="margin:0;background:#fde68a;font:48px sans-serif"><p style="margin:24px">Yer sayfası</p></body></html>`;
/** The window the measurements are taken at (the app's default) and the narrow one the bars must still fit. */
const DEFAULT_WINDOW = { width: 1440, height: 900 };
const NARROW_WINDOW = { width: 1000, height: 640 };
/** The dock panels of the default layout and, for each, the element(s) the panel exists to show. */
const PANELS = {
  files: { title: "Dosyalar", content: ".kp-files__body" },
  browser: { title: "Tarayıcı", content: ".kp-browser__view" },
  // Everything but the panel's own (hidden) name: section headings, the list, the background agents.
  agents: { title: "Ajanlar", content: ".kp-agents > :not(.kp-panel__head):not(.kp-panel__title)" },
  terminals: { title: "Terminal", content: ".kp-tabs__pane--a .kp-term__host" },
} as const;
type PanelKey = keyof typeof PANELS;
const PANEL_KEYS = Object.keys(PANELS) as PanelKey[];

interface Space {
  /** Rows the panel spends above its content, inside its dock group (px). */
  chromeTop: number;
  /** Width of the dock group not given to the content (px). */
  inset: number;
  /** The content box: what the tree, the page, the list, the xterm can use (px). */
  width: number;
  height: number;
}

describe("çalışma alanı: room for the screens", () => {
  let spaceRoot: string;
  let server: http.Server;
  let pageUrl: string;

  const panel = (id: PanelKey): Locator => page.locator(`.kp-dock-panel[data-panel-id="${id}"]`);
  const browserPanel = (): Locator => panel("browser");
  const frames = async (): Promise<number> => Number((await browserPanel().locator("canvas").getAttribute("data-frames")) ?? "0");

  /** A length token of theme.css resolved to px (0 when the token does not exist). */
  const token = (name: string): Promise<number> =>
    page.evaluate((n) => {
      const probe = document.createElement("div");
      probe.style.cssText = `position:absolute;visibility:hidden;height:var(${n})`;
      document.querySelector(".kp-root")!.append(probe);
      const h = probe.getBoundingClientRect().height;
      probe.remove();
      return h;
    }, name);

  /** What a dock panel leaves to its content, measured against its dock group's content area. */
  async function space(id: PanelKey, prefix = "space"): Promise<Space> {
    const out = await page.evaluate(
      ([panelId, selector]) => {
        const host = document.querySelector(`.kp-dock-panel[data-panel-id="${panelId}"]`);
        if (!host) throw new Error(`panel ${panelId} is not open`);
        const group = (host.closest(".dv-content-container") ?? host).getBoundingClientRect();
        const rects = [...host.querySelectorAll(selector!)].map((el) => el.getBoundingClientRect());
        if (rects.length === 0) throw new Error(`panel ${panelId} has no ${selector}`);
        const top = Math.min(...rects.map((r) => r.top));
        const width = Math.max(...rects.map((r) => r.width));
        // The panel's inner bottom edge (its own border and the group's padding are not usable), never beyond the group.
        const section = host.firstElementChild!;
        const inner = section.getBoundingClientRect().bottom - parseFloat(getComputedStyle(section).borderBottomWidth);
        const bottom = Math.min(inner, group.bottom);
        return { chromeTop: top - group.top, inset: group.width - width, width, height: bottom - top };
      },
      [id, PANELS[id].content] as const,
    );
    for (const [k, v] of Object.entries(out)) metrics[`${prefix}.${id}.${k}`] = Math.round(v * 100) / 100;
    saveMetrics();
    return out;
  }

  async function setWindow(size: { width: number; height: number }): Promise<void> {
    await app!.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setSize(s.width, s.height), size);
    await expect.poll(() => page.evaluate(() => innerWidth), { timeout: UI_TIMEOUT_MS }).toBe(size.width);
  }

  /** PIDs of processes whose command line contains `needle` (the temp root keeps this to our own Chromes). */
  function pidsWith(needle: string): number[] {
    return execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  }

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    spaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-work-space-")));
    const spaceRepo = join(spaceRoot, "repo");
    mkdirSync(join(spaceRepo, "src"), { recursive: true });
    git(spaceRepo, "init", "-q", "-b", "main");
    writeFileSync(join(spaceRepo, "README.md"), "e2e\n");
    writeFileSync(join(spaceRepo, "src", "main.ts"), "export const answer = 42;\n");
    git(spaceRepo, "add", ".");
    git(spaceRepo, "commit", "-q", "-m", "init");
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(TEST_PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    pageUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const configPath = join(spaceRoot, "engine.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        dataDir: join(spaceRoot, "data"),
        port: 0,
        shell: "/bin/sh",
        shellArgs: [],
        listenTailscale: false,
        flushIntervalMs: 100,
        killGraceMs: 200,
        projects: [{ name: SPACE_PROJECT, repoPath: spaceRepo, id: "yer" }],
        // Test-only: no window and no keychain dialog on the desktop (headless + mock keychain).
        browser: { headless: true, testMode: true },
      }),
    );
    // No temp HOME: Chrome would then look for a login keychain that does not exist and show a dialog.
    engine = await startEngine(configPath, KEY);
    await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
    app = await launchApp({ KOKPIT_USER_DATA_DIR: join(spaceRoot, "user-data"), KOKPIT_CHROME_HEADLESS: "1" });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    await stopEngine(engine);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (spaceRoot) {
      for (const pid of pidsWith(spaceRoot)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(spaceRoot, { recursive: true, force: true });
    }
  });

  it("6. Dosyalar, Tarayıcı (a page open), Ajanlar and Terminal (a terminal open) are on screen", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await rail().getByRole("button", { name: SPACE_PROJECT, exact: true }).click();
    await expect.poll(selectionTitle, { timeout: UI_TIMEOUT_MS }).toBe(SPACE_PROJECT);
    await launchTerminal(page, SPACE_COMMAND);
    const term = page.getByRole("region", { name: `Terminal: ${SPACE_COMMAND}` });
    await expect.poll(() => term.textContent(), { timeout: UI_TIMEOUT_MS }).toContain("YER_42");
    await browserPanel().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    const before = await frames();
    const address = browserPanel().getByLabel("Adres");
    await address.fill(pageUrl);
    await address.press("Enter");
    const tabs = browserPanel().getByRole("group", { name: "Sekmeler" });
    await expect.poll(() => tabs.getByRole("button").allTextContents(), { timeout: UI_TIMEOUT_MS }).toContain(PAGE_TITLE);
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before);
    await expect.poll(() => panel("files").getByText("README.md").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await shot("10-paneller");
  });

  it("7. each panel's content box: the chrome left above and beside it is bounded by the design tokens", async () => {
    const [bar, border, hit] = [await token("--bar-h"), await token("--border-w"), await token("--hit-min")];
    metrics["token.bar-h"] = bar;
    metrics["token.hit-min"] = hit;
    const spaces = {} as Record<PanelKey, Space>;
    for (const id of PANEL_KEYS) spaces[id] = await space(id);
    // The tokens exist and keep hit targets usable.
    expect(hit).toBeGreaterThanOrEqual(24);
    expect(bar).toBeGreaterThanOrEqual(hit);
    /** One slim row (a toolbar or a tab strip) and its bottom border. */
    const row = bar + border;
    // Ajanlar has no actions: no row at all. Dosyalar has "Yenile", Terminal its tabs: one slim row each.
    // Tarayıcı with a page open: its tabs and its toolbar.
    expect(spaces.agents.chromeTop).toBe(0);
    expect(spaces.files.chromeTop).toBeLessThanOrEqual(row);
    expect(spaces.terminals.chromeTop).toBeLessThanOrEqual(row);
    expect(spaces.browser.chromeTop).toBeLessThanOrEqual(2 * row);
    // No card around a panel: the content is as wide as the dock group.
    for (const id of PANEL_KEYS) expect(spaces[id].inset, `${id} inset`).toBe(0);
  });

  it("8. the dock reaches the window's edges and its strips are one slim row tall", async () => {
    const [bar, border] = [await token("--bar-h"), await token("--border-w")];
    const m = await measure("space");
    const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const d = await dock().boundingBox();
    const r = await rail().boundingBox();
    metrics["space.dockWidth"] = d!.width;
    saveMetrics();
    expect(d!.x).toBe(r!.x + r!.width);
    expect(d!.x + d!.width).toBe(view.width);
    expect(d!.y + d!.height).toBe(view.height);
    expect(m.gap).toBe(await rowGap());
    expect((await box(strip())).height).toBeLessThanOrEqual(bar + border);
    const dockTabs = await page.locator(".kp-dock .dv-tabs-and-actions-container").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(dockTabs.length).toBeGreaterThan(0);
    for (const h of dockTabs) expect(h).toBeLessThanOrEqual(bar);
  });

  it("9. a panel's name is shown once (its dock tab); the name stays for assistive tech", async () => {
    for (const id of PANEL_KEYS) {
      const { title } = PANELS[id];
      // Exactly one element shows the name: the dock tab.
      const shown = await page
        .getByText(title, { exact: true })
        .evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 1 && e.getBoundingClientRect().height > 1).length);
      expect(shown, `"${title}" on screen`).toBe(1);
    }
    // Role-based access is unchanged: every panel is still a named region.
    for (const name of ["Dosyalar", "Tarayıcı", "Ajanlar", "Terminaller"]) {
      expect(await page.getByRole("region", { name, exact: true }).count(), `region ${name}`).toBe(1);
    }
  });

  it("10. the bars carry no size controls and no profile text; every other control is still there", async () => {
    expect(await page.getByRole("group", { name: "Yazı boyutu" }).count()).toBe(0);
    expect(await page.getByRole("group", { name: "Yakınlaştırma" }).count()).toBe(0);
    expect(await page.getByText(/Profil:/).count()).toBe(0);
    // Their function lives in the native Görünüm menu (and Cmd/Ctrl −/=/0 while the panel has focus).
    const labels = (JSON.parse(readFileSync(new URL("../src/i18n/locales/tr/main.json", import.meta.url), "utf8")) as { menu: Record<string, string> }).menu;
    for (const key of ["terminalSmaller", "terminalLarger", "terminalReset", "browserZoomOut", "browserZoomIn", "browserZoomReset"]) {
      expect(await menuItem(app!, [labels.view!, labels[key]!]), labels[key]).toMatchObject({ enabled: true });
    }
    const b = browserPanel();
    for (const name of ["Geri", "İleri", "Yenile", "Uzantılar", "Tarayıcıyı kapat", "Yeni sekme"]) {
      expect(await b.getByRole("button", { name, exact: true }).isVisible(), name).toBe(true);
    }
    expect(await b.getByLabel("Adres").isVisible()).toBe(true);
    const t = panel("terminals");
    expect(await t.getByRole("tab").count()).toBe(1);
    for (const name of ["Böl", "+ Yeni terminal ▾"]) expect(await t.getByRole("button", { name, exact: true }).isVisible(), name).toBe(true);
    expect(await panel("files").getByRole("button", { name: "Yenile", exact: true }).isVisible()).toBe(true);
    // Every button in the dock is at least the smallest hit target tall and wide.
    const hit = await token("--hit-min");
    const small = await dock()
      .locator("button:visible")
      .evaluateAll(
        (els, min) =>
          els
            .filter((e) => e.getBoundingClientRect().height < min || e.getBoundingClientRect().width < min)
            .map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""),
        hit,
      );
    expect(small).toEqual([]);
  });

  it("11. a card: the panels keep their content boxes", async () => {
    const before = { files: await space("files"), terminals: await space("terminals"), dock: await box(dock()) };
    await rail().getByRole("button", { name: `Yeni kart: ${SPACE_PROJECT}` }).click();
    await rail().getByLabel("Kart adı").fill(SPACE_CARD);
    await rail().getByRole("button", { name: "Oluştur" }).click();
    await expect.poll(selectionTitle, { timeout: UI_TIMEOUT_MS }).toBe(SPACE_CARD);
    await expect.poll(() => terminalLauncher(page).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await shot("11-kart");
    // The card's name is on the tab strip's row and, in Dosyalar, in the slim row next to "Yenile" — no extra row.
    expect((await space("files", "card")).chromeTop).toBe(before.files.chromeTop);
    expect((await box(dock())).height).toBe(before.dock.height);
    await rail().getByRole("button", { name: SPACE_PROJECT, exact: true }).click();
    await expect.poll(selectionTitle, { timeout: UI_TIMEOUT_MS }).toBe(SPACE_PROJECT);
    await expect.poll(() => panel("terminals").locator(PANELS.terminals.content).count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    expect((await space("terminals")).height).toBe(before.terminals.height);
  });

  it("12. a narrow window (1000×640): every bar keeps its controls inside its panel", async () => {
    await setWindow(NARROW_WINDOW);
    // The dock has followed the window, and the page is drawn again at its new size.
    await expect
      .poll(async () => {
        const b = await panel("agents").boundingBox();
        return b!.x + b!.width;
      }, { timeout: UI_TIMEOUT_MS })
      .toBe(NARROW_WINDOW.width);
    const drawn = await frames();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(drawn);
    await shot("12-dar-pencere");
    for (const id of PANEL_KEYS) await space(id, "narrow");
    const inside = async (id: PanelKey, control: Locator): Promise<void> => {
      const [p, c] = [await panel(id).boundingBox(), await control.boundingBox()];
      expect(c, `${id}: control has a box`).not.toBeNull();
      expect(c!.x).toBeGreaterThanOrEqual(p!.x);
      expect(c!.x + c!.width).toBeLessThanOrEqual(p!.x + p!.width);
      expect(c!.y).toBeGreaterThanOrEqual(p!.y);
      expect(c!.y + c!.height).toBeLessThanOrEqual(p!.y + p!.height);
    };
    const b = browserPanel();
    for (const name of ["Geri", "İleri", "Yenile", "Uzantılar", "Tarayıcıyı kapat"]) await inside("browser", b.getByRole("button", { name, exact: true }));
    await inside("browser", b.getByLabel("Adres"));
    for (const name of ["Böl", "+ Yeni terminal ▾"]) await inside("terminals", panel("terminals").getByRole("button", { name, exact: true }));
    await inside("files", panel("files").getByRole("button", { name: "Yenile", exact: true }));
    await setWindow(DEFAULT_WINDOW);
  });

  it("13. the rail still collapses and gives its width to the dock", async () => {
    const before = await dock().boundingBox();
    await rail().getByRole("button", { name: "Sol listeyi daralt" }).click();
    await expect.poll(async () => (await dock().boundingBox())!.width, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before!.width);
    // The panels themselves get the width: the rightmost one reaches the window's edge again.
    const rightEdge = async (): Promise<number> => {
      const b = await panel("agents").boundingBox();
      return b!.x + b!.width;
    };
    await expect.poll(rightEdge, { timeout: UI_TIMEOUT_MS }).toBe(DEFAULT_WINDOW.width);
    await shot("13-serit-dar");
    const collapsed = await dock().boundingBox();
    metrics["space.railCollapsed.dockWidth"] = collapsed!.width;
    saveMetrics();
    expect(collapsed!.height).toBe(before!.height);
    await rail().getByRole("button", { name: "Sol listeyi genişlet" }).click();
    await expect.poll(async () => (await dock().boundingBox())!.width, { timeout: UI_TIMEOUT_MS }).toBe(before!.width);
  });
});
