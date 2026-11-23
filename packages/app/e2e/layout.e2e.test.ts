// İş L — Modüler düzen end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
// Drag a panel into another group, hide/show via Görünüm, resize with a sash, then relaunch with the same userData:
// same layout, same selected project. Steps run in order and share state.
// İş D — proje başına düzen: a second project keeps its own layout; switching back and forth and a relaunch restore
// each; Görünüm's marks follow; Varsayılan düzen resets one project; a pre-İş D state file is migrated.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { UI_STATE_VERSION } from "../src/renderer/engine/ui-state-ipc.ts";
import { defaultLayoutConfig } from "../src/renderer/ui/layout/config.ts";
import { layoutOwnerOf } from "../src/renderer/ui/layout/ui-state.ts";
import { clickMenu, engineRequest, launchApp, launchTerminal, menuItem, SCREENSHOT_DIR, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const PROJECT = "Düzen Projesi";
const OTHER = "Öteki Proje";
/** Must match the main process (src/main/index.ts). */
const UI_STATE_FILE = "ui-state.json";
/** Pixels the sash is dragged by. */
const RESIZE_BY = 120;
/** D1: a restored group may differ from what was on screen by sub-pixel rounding only. */
const SIZE_TOLERANCE_PX = 1;
/** D1: pixels the second sash drag moves; odd, so the split is not one that happens to survive rounding. */
const ODD_RESIZE_BY = 37;
/** D1: project round trips (two switches each) a resized layout must survive unchanged. */
const SWITCH_ROUND_TRIPS = 15;
/** İş D: a terminal that prints a mark and stays open (no real tool is started). */
const TERMINAL_MARK = "duzen-isareti";
const TERMINAL_COMMAND = `echo ${TERMINAL_MARK}; cat`;
/** İş D: a real ui-state.json written before per-project layouts (format 1). */
const V1_FIXTURE = fileURLToPath(new URL("../src/renderer/ui/layout/fixtures/ui-state-v1.json", import.meta.url));

let root: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("layout", () => ({ app, page, engine }));
let sizeAfterResize: number;

async function openApp(): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `layout-${name}.png`) });
}

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
// İş M: Görünüm is the native menu bar now.
const toggle = (name: string) => ({
  click: () => clickMenu(app!, ["Görünüm", name]),
  getAttribute: async (_attr: "aria-pressed") => String((await menuItem(app!, ["Görünüm", name]))?.checked ?? false),
});
const tab = (name: string): Locator => page.getByRole("tab", { name, exact: true });
const headerTitle = (): Promise<string | null> => page.locator(".kp-header__title").textContent();
/** The dockview group (tabs + content) that holds a panel's tab. */
const groupOf = (name: string): Locator => page.locator(".dv-groupview").filter({ has: tab(name) });

async function tabNames(): Promise<string[]> {
  return (await page.getByRole("tab").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))).filter(Boolean).sort();
}

/** Tabs sharing a group with `name`. */
async function groupTabs(name: string): Promise<string[]> {
  return (await groupOf(name).getByRole("tab").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))).filter(Boolean).sort();
}

interface SavedState {
  version?: number;
  layouts?: { inherited?: { normal?: unknown }; projects?: Record<string, { normal?: unknown }> };
  selection?: unknown;
}

function savedState(): SavedState | null {
  const file = join(userDataDir, UI_STATE_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SavedState;
  } catch {
    return null;
  }
}

const sortGroups = (groups: string[][]): string[][] => groups.map((g) => [...g].sort()).sort((a, b) => a.join().localeCompare(b.join()));

/** Panel ids per dockview group of a project's saved normal layout (İş D: one layout per project). */
function savedGroups(projectId: string): string[][] {
  const out: string[][] = [];
  const walk = (node: { type: string; data: unknown }): void => {
    if (node.type === "leaf") out.push((node.data as { views: string[] }).views);
    else for (const child of node.data as { type: string; data: unknown }[]) walk(child);
  };
  const layout = savedState()?.layouts?.projects?.[layoutOwnerOf(projectId)]?.normal as { grid?: { root?: { type: string; data: unknown } } } | undefined;
  if (layout?.grid?.root) walk(layout.grid.root);
  return sortGroups(out);
}

/** İş P: a project's tab above the work area. */
const projectTab = (name: string): Locator => page.getByRole("toolbar", { name: "Proje sekmeleri" }).getByRole("button", { name, exact: true });
const terminalRegion = (): Locator => page.getByRole("region", { name: `Terminal: ${TERMINAL_COMMAND}` });

/** Görünüm's check marks for the panels the tests toggle. */
async function checks(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const name of ["Ajanlar", "Akış", "Harita"]) out[name] = (await menuItem(app!, ["Görünüm", name]))?.checked ?? false;
  return out;
}

async function openTerminal(command: string): Promise<void> {
  await launchTerminal(page, command);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-layout-")));
  userDataDir = join(root, "user-data");
  const home = join(root, "home");
  mkdirSync(home);
  for (const dir of ["duzen", "oteki"]) mkdirSync(join(root, dir));
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
      projects: [
        { name: PROJECT, repoPath: join(root, "duzen"), id: "duzen" },
        { name: OTHER, repoPath: join(root, "oteki"), id: "oteki" },
      ],
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: home });
  // No default tool: a new terminal runs only the command the test gives it.
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await openApp();
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("İş L: modüler düzen end-to-end", () => {
  it("1. connects; the project shows the default layout: Dosyalar | Tarayıcı | Ajanlar over a full-width Terminal", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Ajanlar", "Dosyalar", "Tarayıcı", "Terminal"]);

    const box = async (name: string) => (await groupOf(name).boundingBox())!;
    const [files, browser, agents, terminals] = await Promise.all(["Dosyalar", "Tarayıcı", "Ajanlar", "Terminal"].map(box));
    // One row, left to right, then the terminal below spanning the whole row.
    expect(files!.x).toBeLessThan(browser!.x);
    expect(browser!.x).toBeLessThan(agents!.x);
    expect(Math.abs(files!.y - agents!.y)).toBeLessThan(2);
    expect(terminals!.y).toBeGreaterThan(files!.y + files!.height - 2);
    expect(terminals!.width).toBeGreaterThan(agents!.x + agents!.width - files!.x - 4);
    expect(await toggle("Harita").getAttribute("aria-pressed")).toBe("false");
    expect(await toggle("Akış").getAttribute("aria-pressed")).toBe("false");
    await shot("01-varsayilan");
  });

  it("2. Görünüm hides Ajanlar and shows Akış", async () => {
    await toggle("Ajanlar").click();
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Dosyalar", "Tarayıcı", "Terminal"]);
    expect(await toggle("Ajanlar").getAttribute("aria-pressed")).toBe("false");
    await toggle("Akış").click();
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Akış", "Dosyalar", "Tarayıcı", "Terminal"]);
    await shot("02-gorunum");
  });

  it("3. dragging the Dosyalar tab onto the Terminal group makes it a tab there", async () => {
    const target = groupOf("Terminal").locator(".dv-content-container");
    const tb = (await target.boundingBox())!;
    await tab("Dosyalar").dragTo(target, { targetPosition: { x: tb.width / 2, y: tb.height / 2 } });
    await expect.poll(() => groupTabs("Terminal"), { timeout: UI_TIMEOUT_MS }).toEqual(["Dosyalar", "Terminal"]);
    await shot("03-surukle");
  });

  it("4. dragging the sash above the terminal group resizes it", async () => {
    const group = groupOf("Terminal");
    const before = (await group.boundingBox())!;
    // The horizontal sash sits on the top edge of the bottom group.
    const x = before.x + before.width / 2;
    const y = before.y - 1;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - RESIZE_BY / 2, { steps: 5 });
    await page.mouse.move(x, y - RESIZE_BY, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await group.boundingBox())!.height, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before.height + RESIZE_BY / 2);
    sizeAfterResize = (await group.boundingBox())!.height;
    await shot("04-boyut");
  });

  it("5. the layout and the selected project are saved to userData", async () => {
    await expect
      .poll(() => savedGroups("duzen"), { timeout: UI_TIMEOUT_MS })
      .toEqual(sortGroups([["browser", "flow"], ["files", "terminals"]]));
    expect(savedState()?.selection).toEqual({ kind: "project", projectId: "duzen" });
  });

  it("6. after a relaunch: same layout, same size, same selected project", async () => {
    // Let the debounced save of the last resize land.
    const saved = JSON.stringify(savedState());
    await expect.poll(() => JSON.stringify(savedState()), { timeout: UI_TIMEOUT_MS }).toBe(saved);
    await app!.close();
    app = undefined;
    await openApp();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    expect(await rail().getByRole("button", { name: PROJECT, exact: true }).getAttribute("aria-current")).toBe("true");
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Akış", "Dosyalar", "Tarayıcı", "Terminal"]);
    expect(await groupTabs("Terminal")).toEqual(["Dosyalar", "Terminal"]);
    expect(await toggle("Ajanlar").getAttribute("aria-pressed")).toBe("false");
    const height = (await groupOf("Terminal").boundingBox())!.height;
    expect(Math.abs(height - sizeAfterResize)).toBeLessThanOrEqual(SIZE_TOLERANCE_PX);
    await shot("05-yeniden-acilis");
  });

  // ---- İş D: proje başına düzen ----
  it("7. another project has its own layout: what was closed, opened, dragged and resized here did not happen there", async () => {
    // Terminal shares a group with Dosyalar here; its launcher is on screen only while its tab is the active one.
    await tab("Terminal").click();
    await openTerminal(TERMINAL_COMMAND);
    await expect.poll(() => xtermText(terminalRegion()), { timeout: UI_TIMEOUT_MS }).toContain(TERMINAL_MARK);
    await rail().getByRole("button", { name: OTHER, exact: true }).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(OTHER);
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Ajanlar", "Dosyalar", "Tarayıcı", "Terminal"]);
    expect(await groupTabs("Terminal")).toEqual(["Terminal"]);
    await expect.poll(() => checks(), { timeout: UI_TIMEOUT_MS }).toEqual({ Ajanlar: true, Akış: false, Harita: false });
    // Its own change: Harita on.
    await toggle("Harita").click();
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Ajanlar", "Dosyalar", "Harita", "Tarayıcı", "Terminal"]);
    await expect.poll(() => checks(), { timeout: UI_TIMEOUT_MS }).toEqual({ Ajanlar: true, Akış: false, Harita: true });
    await shot("06-oteki-proje");
  });

  it("8. switching back and forth restores each project's layout; Görünüm's marks follow; the terminal session is intact", async () => {
    for (let round = 0; round < 2; round++) {
      await projectTab(PROJECT).click();
      await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
      await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Akış", "Dosyalar", "Tarayıcı", "Terminal"]);
      expect(await groupTabs("Terminal")).toEqual(["Dosyalar", "Terminal"]);
      await expect.poll(() => checks(), { timeout: UI_TIMEOUT_MS }).toEqual({ Ajanlar: false, Akış: true, Harita: false });
      const height = (await groupOf("Terminal").boundingBox())!.height;
      expect(Math.abs(height - sizeAfterResize)).toBeLessThanOrEqual(SIZE_TOLERANCE_PX);
      // Same terminal, same session: its earlier output is on screen and it still answers.
      await tab("Terminal").click();
      await expect.poll(() => xtermText(terminalRegion()), { timeout: UI_TIMEOUT_MS }).toContain(TERMINAL_MARK);

      await projectTab(OTHER).click();
      await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(OTHER);
      await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Ajanlar", "Dosyalar", "Harita", "Tarayıcı", "Terminal"]);
      expect(await groupTabs("Terminal")).toEqual(["Terminal"]);
      await expect.poll(() => checks(), { timeout: UI_TIMEOUT_MS }).toEqual({ Ajanlar: true, Akış: false, Harita: true });
    }
    const res = (await engineRequest(engine!.url, KEY, "terminals.list", { projectId: "duzen" })) as { terminals: { title: string }[] };
    expect(res.terminals.map((t) => t.title)).toEqual([TERMINAL_COMMAND]);
    await expect
      .poll(() => [savedGroups("duzen"), savedGroups("oteki")], { timeout: UI_TIMEOUT_MS })
      .toEqual([sortGroups([["browser", "flow"], ["files", "terminals"]]), sortGroups([["files"], ["browser", "map"], ["agents"], ["terminals"]])]);
    await shot("07-gecis");
  });

  it(`8b. D1: ${SWITCH_ROUND_TRIPS * 2} more switches move nothing: resized groups keep their size and the stored layouts are not rewritten`, async () => {
    const storedLayouts = (): string => JSON.stringify(["duzen", "oteki"].map((id) => savedState()?.layouts?.projects?.[layoutOwnerOf(id)]?.normal ?? null));
    /** Longer than the debounced save, so a write that was on its way has landed. */
    const settle = (): Promise<void> => page.waitForTimeout(defaultLayoutConfig.saveDebounceMs * 3);
    /** Rendered width and height of the groups holding these tabs. */
    const groupSizes = async (names: string[]): Promise<number[]> => {
      const out: number[] = [];
      for (const name of names) {
        const box = (await groupOf(name).boundingBox())!;
        out.push(box.width, box.height);
      }
      return out;
    };
    const OTHER_GROUPS = ["Dosyalar", "Tarayıcı", "Ajanlar", "Terminal"];
    // The verifier's case: three groups above a Terminal whose sash was dragged — here in Öteki, by an odd amount.
    const terminal = (await groupOf("Terminal").boundingBox())!;
    const x = terminal.x + terminal.width / 2;
    const y = terminal.y - 1;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - ODD_RESIZE_BY, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await groupOf("Terminal").boundingBox())!.height, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(terminal.height + ODD_RESIZE_BY / 2);
    await settle();
    const stored = storedLayouts();
    expect(JSON.parse(stored)).not.toContain(null);
    const otherSizes = await groupSizes(OTHER_GROUPS);

    for (let round = 0; round < SWITCH_ROUND_TRIPS; round++) {
      await projectTab(PROJECT).click();
      await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
      await expect.poll(() => groupTabs("Terminal"), { timeout: UI_TIMEOUT_MS }).toEqual(["Dosyalar", "Terminal"]);
      const height = (await groupOf("Terminal").boundingBox())!.height;
      expect(Math.abs(height - sizeAfterResize), `round ${round}`).toBeLessThanOrEqual(SIZE_TOLERANCE_PX);
      await projectTab(OTHER).click();
      await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(OTHER);
      await expect.poll(() => groupTabs("Terminal"), { timeout: UI_TIMEOUT_MS }).toEqual(["Terminal"]);
      const sizes = await groupSizes(OTHER_GROUPS);
      expect(sizes.map((size, i) => Math.abs(size - otherSizes[i]!) <= SIZE_TOLERANCE_PX), `round ${round}: ${sizes.join()} / ${otherSizes.join()}`).toEqual(sizes.map(() => true));
    }
    // Stored: byte for byte what it was before the switches.
    await settle();
    expect(storedLayouts()).toBe(stored);
  });

  it("9. after a relaunch both projects come back with their own layout", async () => {
    const saved = JSON.stringify(savedState());
    await expect.poll(() => JSON.stringify(savedState()), { timeout: UI_TIMEOUT_MS }).toBe(saved);
    await app!.close();
    app = undefined;
    await openApp();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(OTHER);
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Ajanlar", "Dosyalar", "Harita", "Tarayıcı", "Terminal"]);
    await expect.poll(() => checks(), { timeout: UI_TIMEOUT_MS }).toEqual({ Ajanlar: true, Akış: false, Harita: true });
    await projectTab(PROJECT).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Akış", "Dosyalar", "Tarayıcı", "Terminal"]);
    expect(await groupTabs("Terminal")).toEqual(["Dosyalar", "Terminal"]);
    await expect.poll(() => checks(), { timeout: UI_TIMEOUT_MS }).toEqual({ Ajanlar: false, Akış: true, Harita: false });
    await shot("08-yeniden-acilis-iki-proje");
  });

  it("10. Varsayılan düzen resets only the project on screen", async () => {
    await clickMenu(app!, ["Görünüm", "Varsayılan düzen"]);
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Ajanlar", "Dosyalar", "Tarayıcı", "Terminal"]);
    await expect.poll(() => checks(), { timeout: UI_TIMEOUT_MS }).toEqual({ Ajanlar: true, Akış: false, Harita: false });
    await projectTab(OTHER).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(OTHER);
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(["Ajanlar", "Dosyalar", "Harita", "Tarayıcı", "Terminal"]);
    await expect.poll(() => checks(), { timeout: UI_TIMEOUT_MS }).toEqual({ Ajanlar: true, Akış: false, Harita: true });
    await shot("09-varsayilan-duzen");
  });

  it("11. göç: a state file from before per-project layouts — its one layout is what every project starts from", async () => {
    await app!.close();
    app = undefined;
    // A real file written by the previous format (one shared layout: Ajanlar closed, Harita and Web open).
    userDataDir = join(root, "user-data-eski");
    mkdirSync(userDataDir);
    const old = readFileSync(V1_FIXTURE, "utf8");
    expect((JSON.parse(old) as { version: number }).version).toBe(1);
    writeFileSync(join(userDataDir, UI_STATE_FILE), old);
    await openApp();
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    const inherited = ["Dosyalar", "Harita", "Tarayıcı", "Terminal", "Web"];
    for (const name of [PROJECT, OTHER]) {
      await rail().getByRole("button", { name, exact: true }).click();
      await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(name);
      await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(inherited);
      await expect.poll(() => checks(), { timeout: UI_TIMEOUT_MS }).toEqual({ Ajanlar: false, Akış: false, Harita: true });
    }
    // One project changes; the other still has the old layout.
    await toggle("Harita").click();
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(inherited.filter((t) => t !== "Harita"));
    await projectTab(PROJECT).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await expect.poll(tabNames, { timeout: UI_TIMEOUT_MS }).toEqual(inherited);
    // The file is now in the new format and still holds the old layout for projects not opened yet.
    await expect.poll(() => savedState()?.version, { timeout: UI_TIMEOUT_MS }).toBe(UI_STATE_VERSION);
    expect(savedState()?.layouts?.inherited?.normal).toEqual((JSON.parse(old) as { layouts: { normal: unknown } }).layouts.normal);
    await shot("10-goc");
  });
});
