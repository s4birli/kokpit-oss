// Adım 8 İş P — proje sekmeleri end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
// Three projects open as tabs, each tab shows only its own terminals, a tab closes (nothing deleted), tabs reorder
// by drag, and after a relaunch with the same userData the same tabs, order and active tab come back. The rail
// collapses and stays collapsed. Steps run in order and share state.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, launchApp, launchTerminal, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
/** Must match the main process (src/main/index.ts). */
const UI_STATE_FILE = "ui-state.json";
const PROJECTS = [
  { id: "elma", name: "Elma Projesi", cmd: "echo ELMA_$((10+1))" },
  { id: "armut", name: "Armut Projesi", cmd: "echo ARMUT_$((20+2))" },
  { id: "kiraz", name: "Kiraz Projesi", cmd: "echo KIRAZ_$((30+3))" },
] as const;
const [ELMA, ARMUT, KIRAZ] = PROJECTS;

let root: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("project-tabs", () => ({ app, page, engine }));

async function openApp(): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `project-tabs-${name}.png`) });
}

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const strip = (): Locator => page.getByRole("toolbar", { name: "Proje sekmeleri" });
const tabButton = (name: string): Locator => strip().getByRole("button", { name, exact: true });
/** The whole tab (title, counter, ×) of a project; `has` is relative to each .kp-ptab. */
const tabOf = (name: string): Locator => strip().locator(".kp-ptab").filter({ has: page.getByRole("button", { name, exact: true }) });
const headerTitle = (): Promise<string | null> => page.locator(".kp-header__title").textContent();
const terminalTabList = (): Locator => page.getByRole("tablist", { name: "Terminal sekmeleri" });

async function stripTitles(): Promise<string[]> {
  return strip()
    .locator(".kp-ptab__main")
    .evaluateAll((els) => els.map((e) => e.textContent ?? ""));
}
async function activeTab(): Promise<string | null> {
  const active = strip().locator('.kp-ptab__main[aria-current="page"]');
  return (await active.count()) === 0 ? null : active.textContent();
}
async function terminalTitles(): Promise<string[]> {
  const list = terminalTabList();
  if ((await list.count()) === 0) return [];
  return list.locator('[role="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-title") ?? ""));
}

async function openTerminal(command: string): Promise<void> {
  await launchTerminal(page, command);
  await expect.poll(terminalTitles, { timeout: UI_TIMEOUT_MS }).toEqual([command]);
}

function savedState(): { tabs?: { tabs: { projectId: string }[]; active: string | null }; railCollapsed?: boolean } | null {
  const file = join(userDataDir, UI_STATE_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof savedState>;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-project-tabs-")));
  userDataDir = join(root, "user-data");
  const home = join(root, "home");
  mkdirSync(home);
  for (const p of PROJECTS) mkdirSync(join(root, p.id));
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
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("İş P: proje sekmeleri end-to-end", () => {
  it("1. opening three projects from the rail makes three tabs; each gets its own terminal", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    for (const p of PROJECTS) {
      await rail().getByRole("button", { name: p.name, exact: true }).click();
      await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(p.name);
      await expect.poll(activeTab, { timeout: UI_TIMEOUT_MS }).toBe(p.name);
      await openTerminal(p.cmd);
    }
    expect(await stripTitles()).toEqual(PROJECTS.map((p) => p.name));
    await shot("01-uc-sekme");
  });

  it("2. switching tabs: each project shows only its own terminals", async () => {
    for (const p of [ELMA, KIRAZ, ARMUT, ELMA]) {
      await tabButton(p.name).click();
      await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(p.name);
      await expect.poll(terminalTitles, { timeout: UI_TIMEOUT_MS }).toEqual([p.cmd]);
    }
    await shot("02-gecis");
  });

  it("3. closing the active tab activates its neighbour and deletes nothing", async () => {
    await tabButton(ARMUT.name).click();
    await expect.poll(activeTab, { timeout: UI_TIMEOUT_MS }).toBe(ARMUT.name);
    await strip().getByRole("button", { name: `Sekmeyi kapat: ${ARMUT.name}`, exact: true }).click();
    await expect.poll(stripTitles, { timeout: UI_TIMEOUT_MS }).toEqual([ELMA.name, KIRAZ.name]);
    await expect.poll(activeTab, { timeout: UI_TIMEOUT_MS }).toBe(KIRAZ.name);
    await expect.poll(terminalTitles, { timeout: UI_TIMEOUT_MS }).toEqual([KIRAZ.cmd]);
    // Still a project with its terminal: reopening the tab shows it again.
    const res = (await engineRequest(engine!.url, KEY, "terminals.list", { projectId: ARMUT.id })) as { terminals: { title: string }[] };
    expect(res.terminals.map((t) => t.title)).toEqual([ARMUT.cmd]);
    await rail().getByRole("button", { name: ARMUT.name, exact: true }).click();
    await expect.poll(stripTitles, { timeout: UI_TIMEOUT_MS }).toEqual([ELMA.name, KIRAZ.name, ARMUT.name]);
    await expect.poll(terminalTitles, { timeout: UI_TIMEOUT_MS }).toEqual([ARMUT.cmd]);
    // Middle-click closes too.
    await tabOf(ELMA.name).click({ button: "middle" });
    await expect.poll(stripTitles, { timeout: UI_TIMEOUT_MS }).toEqual([KIRAZ.name, ARMUT.name]);
    await rail().getByRole("button", { name: ELMA.name, exact: true }).click();
    await expect.poll(stripTitles, { timeout: UI_TIMEOUT_MS }).toEqual([KIRAZ.name, ARMUT.name, ELMA.name]);
    await shot("03-kapat");
  });

  it("4. dragging a tab reorders the strip; the keyboard does too", async () => {
    await tabOf(ELMA.name).dragTo(tabOf(KIRAZ.name));
    await expect.poll(stripTitles, { timeout: UI_TIMEOUT_MS }).toEqual([ELMA.name, KIRAZ.name, ARMUT.name]);
    await tabButton(ARMUT.name).click();
    await tabButton(ARMUT.name).press("Alt+Shift+ArrowLeft");
    await expect.poll(stripTitles, { timeout: UI_TIMEOUT_MS }).toEqual([ELMA.name, ARMUT.name, KIRAZ.name]);
    await expect.poll(activeTab, { timeout: UI_TIMEOUT_MS }).toBe(ARMUT.name);
    await shot("04-sirala");
  });

  it("5. the rail collapses (projects still reachable through the tabs)", async () => {
    await rail().getByRole("button", { name: "Sol listeyi daralt", exact: true }).click();
    await expect.poll(() => rail().getByRole("button", { name: ELMA.name, exact: true }).count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    const railBox = (await rail().boundingBox())!;
    const stripBox = (await strip().boundingBox())!;
    expect(railBox.width).toBeLessThan(stripBox.width / 4);
    await tabButton(KIRAZ.name).click();
    await expect.poll(terminalTitles, { timeout: UI_TIMEOUT_MS }).toEqual([KIRAZ.cmd]);
    await tabButton(ARMUT.name).click();
    await shot("05-daralt");
  });

  it("6. after a relaunch: same tabs, same order, same active tab, rail still collapsed", async () => {
    await expect
      .poll(() => savedState()?.tabs, { timeout: UI_TIMEOUT_MS })
      .toEqual({ tabs: [{ projectId: ELMA.id }, { projectId: ARMUT.id }, { projectId: KIRAZ.id }], active: ARMUT.id });
    expect(savedState()?.railCollapsed).toBe(true);
    await app!.close();
    app = undefined;
    await openApp();
    await expect.poll(stripTitles, { timeout: UI_TIMEOUT_MS }).toEqual([ELMA.name, ARMUT.name, KIRAZ.name]);
    expect(await activeTab()).toBe(ARMUT.name);
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(ARMUT.name);
    await expect.poll(terminalTitles, { timeout: UI_TIMEOUT_MS }).toEqual([ARMUT.cmd]);
    expect(await rail().getByRole("button", { name: "Sol listeyi genişlet", exact: true }).getAttribute("aria-expanded")).toBe("false");
    await shot("06-yeniden-acilis");
    await rail().getByRole("button", { name: "Sol listeyi genişlet", exact: true }).click();
    await expect.poll(() => rail().getByRole("button", { name: ELMA.name, exact: true }).count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await shot("07-genislet");
  });
});
