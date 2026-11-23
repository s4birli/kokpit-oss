// Pencereye sığma: the work area fills the window's content area exactly — at the default size, maximized, in macOS
// full screen (entered and left), at the smallest window, and after a relaunch with a layout stored at another
// size. No horizontal overflow, no panel outside the window, no blank band; the dock's groups keep their shares; a
// native view (Web) stays on its panel. And the selected card's line at the right end of the project tab strip
// ("Kartı sil" → "Silmeyi onayla") stays inside the window and clickable at every one of those sizes.
// Real Electron against a real engine; every bound is read from the window, the display or the stylesheet.
// The tests open a real window: full screen is always left in `finally`, and never outlives a step.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, git, launchApp, launchTerminal, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
/** macOS animates into and out of full screen; the window reports the state when the animation is over. */
const FULL_SCREEN_TIMEOUT_MS = 15_000;
/** Enough open project tabs to fill the strip at the narrow window, so the card's line competes for room. */
const PROJECT_COUNT = 6;
const PROJECTS = Array.from({ length: PROJECT_COUNT }, (_, i) => ({ id: `sigma-${i + 1}`, name: `Sığma Projesi ${i + 1}` }));
const FIRST = PROJECTS[0]!;
const SECOND = PROJECTS[1]!;
/** A window narrower than the default one (the size §11A.1 already measures at). */
const NARROW_WINDOW = { width: 1000, height: 640 };
/** Pixels a sash is dragged by, so a layout with the user's own sizes is stored. Odd: not a split that survives rounding by luck. */
const SASH_DRAG = { dx: 37, dy: -23 };
/** A group's edge may land one pixel off its exact share (whole pixels). */
const ROUNDING_PX = 1;
const TERMINAL_COMMAND = "echo SIGMA_$((40+2)); cat";
/** The engine's limit for a card name (shared protocol): the longest line the card bar can be asked to show. */
const CARD_NAME_MAX = 100;

let root: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let server: https.Server | undefined;
let siteUrl: string;
let page: Page;

diagnoseFailures("window-fit", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const cardBar = (): Locator => page.locator(".kp-cardbar");

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `window-fit-${name}.png`) });
}

async function openApp(): Promise<void> {
  app = await launchApp({
    KOKPIT_USER_DATA_DIR: userDataDir,
    KOKPIT_TEST_WEB_TRUST_HOST: "127.0.0.1",
    KOKPIT_TEST_WEB_SITES: JSON.stringify([{ id: "home", title: "Ana sayfa", url: siteUrl }]),
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface WindowState {
  content: { width: number; height: number };
  fullScreen: boolean;
  maximized: boolean;
  minimum: { width: number; height: number };
  /** The display the window is on: all of it, and what the menu bar and the Dock leave. */
  display: Rect;
  workArea: Rect;
  /** Native views laid over the page that are on screen. */
  views: Rect[];
}

function windowState(): Promise<WindowState> {
  return app!.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const [width, height] = win.getContentSize() as [number, number];
    const [minWidth, minHeight] = win.getMinimumSize() as [number, number];
    const display = screen.getDisplayMatching(win.getBounds());
    const views = win.contentView.children
      .filter((c) => (c as unknown as { getVisible?: () => boolean }).getVisible?.() === true)
      .map((c) => c.getBounds());
    return {
      content: { width, height },
      fullScreen: win.isFullScreen(),
      maximized: win.isMaximized(),
      minimum: { width: minWidth, height: minHeight },
      display: display.bounds,
      workArea: display.workArea,
      views,
    };
  });
}

/** Calls a method of the app window in the main process. */
function onWindow(method: "setFullScreen" | "maximize" | "unmaximize" | "setContentSize" | "setSize", ...args: (number | boolean)[]): Promise<void> {
  return app!.evaluate(
    ({ BrowserWindow }, [m, a]) => {
      const win = BrowserWindow.getAllWindows()[0] as unknown as Record<string, (...x: unknown[]) => void>;
      win[m]!(...a);
    },
    [method, args] as const,
  );
}

/** Enters macOS full screen; false when this machine does not let the window in (then nothing is left to undo). */
async function enterFullScreen(): Promise<boolean> {
  await onWindow("setFullScreen", true);
  try {
    await expect.poll(async () => (await windowState()).fullScreen, { timeout: FULL_SCREEN_TIMEOUT_MS }).toBe(true);
    return true;
  } catch {
    return false;
  }
}

async function leaveFullScreen(): Promise<void> {
  await onWindow("setFullScreen", false);
  await expect.poll(async () => (await windowState()).fullScreen, { timeout: FULL_SCREEN_TIMEOUT_MS }).toBe(false);
}

interface Geometry {
  viewport: { width: number; height: number };
  /** The document's own widths: wider than the viewport means a horizontal scrollbar / cut content. */
  clientWidth: number;
  scrollWidth: number;
  railRight: number;
  dock: Rect;
  groups: { id: string; rect: Rect }[];
  /** Panels whose own content is wider than the panel (it would scroll sideways or be cut). */
  panels: { id: string; rect: Rect; scrollWidth: number; clientWidth: number }[];
  /** Where a native view belongs, when one is on screen. */
  surfaces: Rect[];
}

function geometry(): Promise<Geometry> {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const dock = document.querySelector(".kp-layout");
    const railEl = document.querySelector(".kp-rail");
    if (!dock || !railEl) throw new Error("the dock or the rail is not on screen");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      railRight: railEl.getBoundingClientRect().right,
      dock: rect(dock),
      groups: [...dock.querySelectorAll(".dv-groupview")].map((g) => ({
        id: g.querySelector(".kp-dock-panel")?.getAttribute("data-panel-id") ?? "",
        rect: rect(g),
      })),
      panels: [...dock.querySelectorAll(".kp-dock-panel")].map((p) => ({
        id: p.getAttribute("data-panel-id") ?? "",
        rect: rect(p),
        scrollWidth: p.scrollWidth,
        clientWidth: p.clientWidth,
      })),
      surfaces: [...dock.querySelectorAll(".kp-surface__surface")].map(rect).filter((r) => r.width >= 1 && r.height >= 1),
    };
  });
}

const right = (r: Rect): number => r.x + r.width;
const bottom = (r: Rect): number => r.y + r.height;

/** Everything that is wrong with how the work area sits in the window; empty when it fits exactly. */
async function misfits(): Promise<string[]> {
  const [win, g] = [await windowState(), await geometry()];
  const out: string[] = [];
  const check = (ok: boolean, text: string): void => {
    if (!ok) out.push(text);
  };
  const { width, height } = g.viewport;
  check(width === win.content.width && height === win.content.height, `page ${width}×${height} is not the window's content ${win.content.width}×${win.content.height}`);
  check(g.clientWidth === width && g.scrollWidth === width, `document is ${g.scrollWidth} wide (client ${g.clientWidth}) in a ${width} viewport`);
  check(g.dock.x === g.railRight, `dock starts at ${g.dock.x}, the rail ends at ${g.railRight}`);
  check(right(g.dock) === width, `dock ends at ${right(g.dock)}, the window at ${width}`);
  check(bottom(g.dock) === height, `dock ends at ${bottom(g.dock)} down, the window at ${height}`);
  check(g.groups.length > 0, "the dock has no group");
  // The groups tile the dock: none outside it, together they cover it (no blank band, no overlap).
  for (const { id, rect: r } of g.groups) {
    check(r.x >= g.dock.x && right(r) <= right(g.dock) && r.y >= g.dock.y && bottom(r) <= bottom(g.dock), `group ${id} [${r.x}, ${r.y}, ${right(r)}, ${bottom(r)}] is outside the dock`);
  }
  const covered = g.groups.reduce((sum, { rect: r }) => sum + r.width * r.height, 0);
  const slack = g.groups.length * ROUNDING_PX * (g.dock.width + g.dock.height);
  check(Math.abs(covered - g.dock.width * g.dock.height) <= slack, `groups cover ${covered} px² of the dock's ${g.dock.width * g.dock.height}`);
  check(Math.min(...g.groups.map((x) => x.rect.x)) === g.dock.x, "no group touches the dock's left edge");
  check(Math.max(...g.groups.map((x) => right(x.rect))) === right(g.dock), "no group touches the dock's right edge");
  check(Math.max(...g.groups.map((x) => bottom(x.rect))) === bottom(g.dock), "no group touches the dock's bottom edge");
  for (const p of g.panels) {
    check(p.rect.x >= 0 && right(p.rect) <= width, `panel ${p.id} [${p.rect.x}, ${right(p.rect)}] is outside the window`);
    check(p.scrollWidth <= p.clientWidth, `panel ${p.id} holds ${p.scrollWidth} px of content in ${p.clientWidth} px`);
  }
  // A native view sits exactly on its panel's surface (main rounds to whole pixels).
  check(win.views.length === g.surfaces.length, `${win.views.length} native view(s) on screen for ${g.surfaces.length} surface(s)`);
  for (const [i, s] of g.surfaces.entries()) {
    const v = win.views[i];
    if (!v) continue;
    const want = { x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.width), height: Math.round(s.height) };
    check(v.x === want.x && v.y === want.y && v.width === want.width && v.height === want.height, `native view ${JSON.stringify(v)} is not on its surface ${JSON.stringify(want)}`);
    check(v.x >= 0 && right(v) <= width, `native view [${v.x}, ${right(v)}] is outside the window`);
  }
  return out;
}

/** Waits for the layout to follow the window; a layout that stays stale never gets there and fails with its misfits. */
async function expectFit(label: string): Promise<void> {
  await expect.poll(misfits, { timeout: UI_TIMEOUT_MS, message: label }).toEqual([]);
}

/** Each group's share of the dock's width and height, by the panel it shows. */
async function shares(): Promise<Record<string, { width: number; height: number }>> {
  const g = await geometry();
  return Object.fromEntries(g.groups.map(({ id, rect: r }) => [id, { width: r.width / g.dock.width, height: r.height / g.dock.height }]));
}

/** The groups kept their shares of the dock (to the pixel) after the window changed size. */
async function expectShares(before: Record<string, { width: number; height: number }>, label: string): Promise<void> {
  const g = await geometry();
  for (const { id, rect: r } of g.groups) {
    const was = before[id];
    expect(was, `${label}: group ${id} existed before`).toBeDefined();
    expect(Math.abs(r.width - was!.width * g.dock.width), `${label}: width of ${id}`).toBeLessThanOrEqual(ROUNDING_PX);
    expect(Math.abs(r.height - was!.height * g.dock.height), `${label}: height of ${id}`).toBeLessThanOrEqual(ROUNDING_PX);
  }
}

async function selectProject(name: string): Promise<void> {
  await rail().getByRole("button", { name, exact: true }).click();
  await expect.poll(() => page.locator(".kp-ptab--active").textContent(), { timeout: UI_TIMEOUT_MS }).toContain(name);
}

async function dragSash(index: number): Promise<void> {
  const b = await page.locator(".dv-sash").nth(index).boundingBox();
  if (!b) throw new Error(`sash ${index} has no box`);
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + SASH_DRAG.dx, y + SASH_DRAG.dy, { steps: 5 });
  await page.mouse.up();
}

/** Why a control cannot be used where it is; null when it is whole inside the window and the pointer reaches it. */
function unusable(button: Locator): Promise<string | null> {
  return button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return "no size";
    if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return `outside the window: [${r.left}, ${r.top}, ${r.right}, ${r.bottom}] in ${innerWidth}×${innerHeight}`;
    const strip = el.closest(".kp-topbar")?.getBoundingClientRect();
    if (strip && (r.left < strip.left || r.right > strip.right)) return `outside the tab strip's row: [${r.left}, ${r.right}] in [${strip.left}, ${strip.right}]`;
    // The middle and a point towards each corner (inside the rounded corners): nothing lies over it.
    const inset = Math.min(r.width, r.height) / 4;
    const points: [number, number][] = [
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
      [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
    ];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (hit !== el && !el.contains(hit)) return `covered at ${x},${y} by ${hit?.className || hit?.tagName}`;
    }
    return null;
  });
}

async function cardNames(projectId: string): Promise<string[]> {
  const { cards } = (await engineRequest(engine!.url, KEY, "cards.list", { projectId })) as { cards: { name: string }[] };
  return cards.map((c) => c.name);
}

/** Creates a card of `project`, selects it in the rail, and deletes it from its line in the tab strip. */
async function deleteCardFromBar(project: { id: string; name: string }, card: string, label: string): Promise<void> {
  await engineRequest(engine!.url, KEY, "cards.create", { projectId: project.id, name: card });
  const inRail = rail().getByRole("button", { name: card, exact: true });
  await expect.poll(() => inRail.count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
  await inRail.click();
  // In the rail the name stays inside its own button and the rail does not scroll sideways, however long it is.
  const overflow = await inRail.evaluate((el) => {
    const nav = el.closest(".kp-rail")!;
    return { card: el.scrollWidth - el.clientWidth, rail: nav.scrollWidth - nav.clientWidth };
  });
  expect(overflow, `${label}: rail`).toEqual({ card: 0, rail: 0 });
  const bar = cardBar();
  await expect.poll(() => bar.locator(".kp-cardbar__name").textContent(), { timeout: UI_TIMEOUT_MS, message: label }).toBe(card);
  const remove = bar.getByRole("button", { name: "Kartı sil", exact: true });
  expect(await unusable(remove), `${label}: Kartı sil`).toBeNull();
  await shot(`kart-${label}`);
  await remove.click();
  const confirm = bar.getByRole("button", { name: "Silmeyi onayla", exact: true });
  const cancel = bar.getByRole("button", { name: "Vazgeç", exact: true });
  expect(await unusable(confirm), `${label}: Silmeyi onayla`).toBeNull();
  expect(await unusable(cancel), `${label}: Vazgeç`).toBeNull();
  // The card's line never pushes the page wider than the window.
  expect((await geometry()).scrollWidth, `${label}: document width`).toBe((await geometry()).viewport.width);
  await confirm.click();
  await expect.poll(() => inRail.count(), { timeout: UI_TIMEOUT_MS, message: `${label}: card left the rail` }).toBe(0);
  await expect.poll(() => cardNames(project.id), { timeout: UI_TIMEOUT_MS, message: `${label}: engine deleted the card` }).not.toContain(card);
  expect(await bar.count(), `${label}: the card's line is gone`).toBe(0);
  expect(await page.locator(".kp-cardbar__error").count(), `${label}: no error`).toBe(0);
}

describe("pencereye sığma: the work area fills the window at any size and in full screen", () => {
  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-window-fit-")));
    userDataDir = join(root, "user-data");
    const home = join(root, "home");
    mkdirSync(home);
    for (const p of PROJECTS) {
      const repo = join(root, p.id);
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "README.md"), "e2e\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "init");
    }
    // A local https page for the Web panel's native view (self-signed, trusted only through the test-only flag).
    const [keyPath, certPath] = [join(root, "key.pem"), join(root, "cert.pem")];
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>Sığma</title></head><body style="margin:0;background:#246;color:#fff">Sığma sayfası</body></html>');
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    siteUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
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
        projects: PROJECTS.map((p) => ({ name: p.name, repoPath: join(root, p.id), id: p.id })),
      }),
    );
    engine = await startEngine(configPath, KEY, { HOME: home });
    await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
    await openApp();
    await page.getByLabel("Motor adresi").fill(engine.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await rail().waitFor({ timeout: UI_TIMEOUT_MS });
  });

  afterAll(async () => {
    try {
      // Never leave a window in full screen, whatever a step did.
      if (app && (await windowState().catch(() => null))?.fullScreen) await leaveFullScreen().catch(() => {});
    } finally {
      await app?.close().catch(() => {});
      await stopEngine(engine);
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("1. the default window: the dock fills what the rail leaves, to the pixel; the Web view is on its panel", async () => {
    await selectProject(FIRST.name);
    await launchTerminal(page, TERMINAL_COMMAND);
    await expect.poll(() => page.getByRole("region", { name: `Terminal: ${TERMINAL_COMMAND}` }).textContent(), { timeout: UI_TIMEOUT_MS }).toContain("SIGMA_42");
    // The Web panel (a native view over the page) is open in the first project's layout.
    await expect.poll(async () => (await windowState()).views.length, { timeout: UI_TIMEOUT_MS }).toBe(1);
    await expectFit("default window");
    await shot("01-varsayilan");
  });

  it("2. full screen and back: no overflow, no clipped panel, no blank band; the groups keep their shares", async (ctx) => {
    const before = { shares: await shares(), content: (await windowState()).content };
    const entered = await enterFullScreen();
    try {
      if (!entered) return ctx.skip("this machine did not let the window into macOS full screen");
      const win = await windowState();
      // Full screen is the whole display (a notched display keeps the strip beside the notch to the system).
      expect(win.content.width).toBe(win.display.width);
      expect(win.content.width).toBeGreaterThan(before.content.width);
      await expectFit("full screen");
      await expectShares(before.shares, "full screen");
      await shot("02-tam-ekran");
      // Another project's layout (never stored: the default) and back, while in full screen.
      await selectProject(SECOND.name);
      await expectFit("full screen, second project");
      await selectProject(FIRST.name);
      await expectFit("full screen, back in the first project");
      await expectShares(before.shares, "full screen, back in the first project");
      // The rail gives its width to the dock and takes it back.
      await rail().getByRole("button", { name: "Sol listeyi daralt" }).click();
      await expectFit("full screen, rail collapsed");
      await shot("03-tam-ekran-serit-dar");
      await rail().getByRole("button", { name: "Sol listeyi genişlet" }).click();
      await expectFit("full screen, rail expanded");
    } finally {
      if (entered) await leaveFullScreen();
    }
    await expect.poll(async () => (await windowState()).content, { timeout: UI_TIMEOUT_MS }).toEqual(before.content);
    await expectFit("after full screen");
    await expectShares(before.shares, "after full screen");
    await shot("04-tam-ekrandan-sonra");
  });

  it("3. full screen while another view is on screen: the dock is right when the work view returns", async (ctx) => {
    const before = await shares();
    await rail().getByRole("button", { name: /^Yapılacaklar/ }).click();
    const entered = await enterFullScreen();
    try {
      if (!entered) return ctx.skip("this machine did not let the window into macOS full screen");
      await rail().getByRole("button", { name: "Çalışma", exact: true }).click();
      await expectFit("full screen, entered behind another view");
      await expectShares(before, "full screen, entered behind another view");
      await rail().getByRole("button", { name: /^Yapılacaklar/ }).click();
    } finally {
      if (entered) await leaveFullScreen();
      await rail().getByRole("button", { name: "Çalışma", exact: true }).click();
    }
    await expectFit("left full screen behind another view");
    await expectShares(before, "left full screen behind another view");
  });

  it("4. maximized (the display's work area) and back", async () => {
    const before = { shares: await shares(), content: (await windowState()).content };
    await onWindow("maximize");
    try {
      await expect.poll(async () => (await windowState()).content.width, { timeout: UI_TIMEOUT_MS }).toBe((await windowState()).workArea.width);
      await expectFit("maximized");
      await expectShares(before.shares, "maximized");
      await selectProject(SECOND.name);
      await expectFit("maximized, second project");
      await selectProject(FIRST.name);
      await expectFit("maximized, back in the first project");
    } finally {
      await onWindow("unmaximize");
    }
    await expect.poll(async () => (await windowState()).content, { timeout: UI_TIMEOUT_MS }).toEqual(before.content);
    await expectFit("after maximize");
    await expectShares(before.shares, "after maximize");
  });

  it("5. the smallest window and a narrow one: still no overflow and no panel outside the window", async () => {
    const before = (await windowState()).content;
    const { minimum } = await windowState();
    try {
      await onWindow("setSize", minimum.width, minimum.height);
      await expect.poll(() => page.evaluate(() => innerWidth), { timeout: UI_TIMEOUT_MS }).toBe(minimum.width);
      await expectFit("smallest window");
      await shot("05-en-kucuk");
      await onWindow("setSize", NARROW_WINDOW.width, NARROW_WINDOW.height);
      await expect.poll(() => page.evaluate(() => innerWidth), { timeout: UI_TIMEOUT_MS }).toBe(NARROW_WINDOW.width);
      await expectFit("narrow window");
    } finally {
      await onWindow("setContentSize", before.width, before.height);
    }
    await expect.poll(async () => (await windowState()).content, { timeout: UI_TIMEOUT_MS }).toEqual(before);
    await expectFit("back at the default size");
  });

  it("6. a layout stored at another window size is rescaled: relaunch, then full screen", async (ctx) => {
    const defaultContent = (await windowState()).content;
    // The user arranges the first project's layout in a narrow window; that is what gets stored.
    await onWindow("setSize", NARROW_WINDOW.width, NARROW_WINDOW.height);
    await expect.poll(() => page.evaluate(() => innerWidth), { timeout: UI_TIMEOUT_MS }).toBe(NARROW_WINDOW.width);
    await expectFit("narrow, before the user's resize");
    const untouched = await shares();
    const sashes = await page.locator(".dv-sash").count();
    expect(sashes).toBeGreaterThan(0);
    for (let i = 0; i < sashes; i += 1) await dragSash(i);
    await expectFit("narrow, after the user's resize");
    const stored = await shares();
    expect(stored).not.toEqual(untouched);
    // Past the store's save delay, then a new launch at the app's default size.
    await expect
      .poll(() => readFileSync(join(userDataDir, "ui-state.json"), "utf8"), { timeout: UI_TIMEOUT_MS })
      .toContain(`"${FIRST.id}"`);
    await page.waitForTimeout(UI_TIMEOUT_MS / 10);
    await app!.close();
    await openApp();
    await rail().waitFor({ timeout: UI_TIMEOUT_MS });
    await expect.poll(() => page.locator(".kp-ptab--active").textContent(), { timeout: UI_TIMEOUT_MS }).toContain(FIRST.name);
    expect((await windowState()).content).toEqual(defaultContent);
    await expectFit("relaunched at the default size with a layout stored in a narrow window");
    await expectShares(stored, "relaunched");
    await shot("06-yeniden-acildi");
    const entered = await enterFullScreen();
    try {
      if (!entered) return ctx.skip("this machine did not let the window into macOS full screen");
      await expectFit("full screen after relaunch");
      await expectShares(stored, "full screen after relaunch");
    } finally {
      if (entered) await leaveFullScreen();
    }
    await expectFit("after full screen, after relaunch");
    await expectShares(stored, "after full screen, after relaunch");
  });

  // ---- the selected card's line (Kartı sil) at the right end of the project tab strip ----

  it("7. at the default window: Kartı sil → Silmeyi onayla deletes the card", async () => {
    // Every project has its tab open, so the strip is as full as it gets; the rail is expanded.
    for (const p of PROJECTS) await selectProject(p.name);
    await selectProject(FIRST.name);
    await deleteCardFromBar(FIRST, "varsayilan-kart", "varsayilan");
  });

  it("8. a card of a project whose tab is not the active one", async () => {
    await selectProject(FIRST.name);
    await deleteCardFromBar(PROJECTS[PROJECT_COUNT - 1]!, "baska-sekme-karti", "baska-sekme");
  });

  it("9. the longest card name the engine accepts does not push the buttons out", async () => {
    await deleteCardFromBar(SECOND, "u".repeat(CARD_NAME_MAX), "uzun-ad");
  });

  it("10. at 1000×640 and at the smallest window", async () => {
    const before = (await windowState()).content;
    const { minimum } = await windowState();
    try {
      await onWindow("setSize", NARROW_WINDOW.width, NARROW_WINDOW.height);
      await expect.poll(() => page.evaluate(() => innerWidth), { timeout: UI_TIMEOUT_MS }).toBe(NARROW_WINDOW.width);
      await deleteCardFromBar(FIRST, "dar-pencere-karti", "dar");
      await deleteCardFromBar(SECOND, "d".repeat(CARD_NAME_MAX), "dar-uzun-ad");
      await onWindow("setSize", minimum.width, minimum.height);
      await expect.poll(() => page.evaluate(() => innerWidth), { timeout: UI_TIMEOUT_MS }).toBe(minimum.width);
      await deleteCardFromBar(FIRST, "k".repeat(CARD_NAME_MAX), "en-kucuk-uzun-ad");
    } finally {
      await onWindow("setContentSize", before.width, before.height);
    }
    await expect.poll(async () => (await windowState()).content, { timeout: UI_TIMEOUT_MS }).toEqual(before);
  });

  it("11. maximized and in full screen", async (ctx) => {
    await onWindow("maximize");
    try {
      await expect.poll(async () => (await windowState()).content.width, { timeout: UI_TIMEOUT_MS }).toBe((await windowState()).workArea.width);
      await deleteCardFromBar(FIRST, "buyuk-pencere-karti", "buyuk");
    } finally {
      await onWindow("unmaximize");
    }
    const entered = await enterFullScreen();
    try {
      if (!entered) return ctx.skip("this machine did not let the window into macOS full screen");
      await deleteCardFromBar(SECOND, "tam-ekran-karti", "tam-ekran");
      await deleteCardFromBar(FIRST, "t".repeat(CARD_NAME_MAX), "tam-ekran-uzun-ad");
    } finally {
      if (entered) await leaveFullScreen();
    }
  });
});
