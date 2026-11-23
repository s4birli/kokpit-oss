// Adım 7 İş T end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
// Two terminals as tabs of the Terminal panel; switching never mixes their output; "Böl" shows both side by side;
// a tab closes only after confirmation; after a relaunch with the same userData the same tabs, active tab and split
// come back. Steps run in order and share state.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, launchApp, launchTerminal, SCREENSHOT_DIR, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const PROJECT = "Sekme Projesi";
const PROJECT_ID = "sekme";
/** Must match the main process (src/main/index.ts). */
const UI_STATE_FILE = "ui-state.json";
// Markers are computed by the shell, so the typed command line itself never matches the output.
const CMD_ONE = "echo ONE_$((20+1))";
const OUT_ONE = "ONE_21";
const CMD_TWO = "echo TWO_$((40+2))";
const OUT_TWO = "TWO_42";
const CMD_THREE = "echo THREE_$((60+3))";
const TYPED_ONE = "echo MORE_ONE_$((7*11))";
const OUT_TYPED_ONE = "MORE_ONE_77";
const TYPED_TWO = "echo MORE_TWO_$((8*11))";
const OUT_TYPED_TWO = "MORE_TWO_88";

let root: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("terminal-tabs", () => ({ app, page, engine }));

async function openApp(): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `terminal-tabs-${name}.png`) });
}

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const headerTitle = (): Promise<string | null> => page.locator(".kp-header__title").textContent();
const panel = (): Locator => page.getByRole("region", { name: "Terminaller", exact: true });
const tabList = (): Locator => panel().getByRole("tablist", { name: "Terminal sekmeleri" });
const tabOf = (title: string): Locator => tabList().locator(`[role="tab"][data-title="${title}"]`);
/** A terminal's pane (visible or hidden): the tabpanel holding its xterm. */
const paneOf = (title: string): Locator => panel().locator('[role="tabpanel"]').filter({ has: page.locator(`[aria-label="Terminal: ${title}"]`) });

async function tabTitles(): Promise<string[]> {
  return tabList().locator('[role="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-title") ?? ""));
}
async function activeTitle(): Promise<string | null> {
  return tabList().locator('[role="tab"][aria-selected="true"]').getAttribute("data-title");
}
async function visiblePanes(): Promise<string[]> {
  const out: string[] = [];
  for (const title of await tabTitles()) if (await paneOf(title).isVisible()) out.push(title);
  return out.sort();
}

/** The Terminal panel's launcher ("+ Yeni terminal ▾", or the empty panel's own) with a start command. */
async function openTerminal(command: string): Promise<void> {
  const before = (await tabTitles()).length;
  await launchTerminal(page, command);
  await expect.poll(async () => (await tabTitles()).length, { timeout: UI_TIMEOUT_MS }).toBe(before + 1);
}

async function waitForText(title: string, text: string): Promise<void> {
  await expect.poll(() => xtermText(paneOf(title)), { timeout: UI_TIMEOUT_MS, interval: 100 }).toContain(text);
}

async function typeInto(title: string, text: string): Promise<void> {
  await paneOf(title).locator(".xterm").click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function engineTerminals(): Promise<{ id: string; title: string }[]> {
  const res = (await engineRequest(engine!.url, KEY, "terminals.list", { projectId: PROJECT_ID })) as {
    terminals: { id: string; title: string; cardId?: string }[];
  };
  return res.terminals.filter((t) => t.cardId === undefined);
}

function savedTabs(): unknown {
  const file = join(userDataDir, UI_STATE_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as { panels?: { terminals?: Record<string, { tabs?: unknown }> } };
    return state.panels?.terminals?.[`project:${PROJECT_ID}`]?.tabs;
  } catch {
    return undefined;
  }
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("no bounding box");
  return b;
}

/** Both panes on screen, `left` then `right` in one row, neither collapsed. */
async function expectSideBySide(left: string, right: string): Promise<void> {
  await expect.poll(visiblePanes, { timeout: UI_TIMEOUT_MS }).toEqual([left, right].sort());
  const a = await box(paneOf(left));
  const b = await box(paneOf(right));
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
  const stage = await box(panel().locator(".kp-tabs__stage"));
  for (const p of [a, b]) {
    expect(p.width).toBeGreaterThan(stage.width / 5);
    expect(p.height).toBeGreaterThan(stage.height / 2);
  }
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-terminal-tabs-")));
  userDataDir = join(root, "user-data");
  const home = join(root, "home");
  mkdirSync(home);
  mkdirSync(join(root, "sekme"));
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
      projects: [{ name: PROJECT, repoPath: join(root, "sekme"), id: PROJECT_ID }],
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

describe("İş T: terminal sekmeleri end-to-end", () => {
  it("1. two terminals open as two tabs; only the active one is on screen", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);

    await openTerminal(CMD_ONE);
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(CMD_ONE);
    await openTerminal(CMD_TWO);
    // The newest terminal is the active tab.
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(CMD_TWO);
    expect(await tabTitles()).toEqual([CMD_ONE, CMD_TWO]);
    await waitForText(CMD_ONE, OUT_ONE);
    await waitForText(CMD_TWO, OUT_TWO);
    expect(await visiblePanes()).toEqual([CMD_TWO]);
    expect((await engineTerminals()).map((t) => t.title).sort()).toEqual([CMD_ONE, CMD_TWO].sort());
    await shot("01-two-tabs");
  });

  it("2. switching tabs never mixes output (markers typed into each)", async () => {
    await tabOf(CMD_ONE).click();
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(CMD_ONE);
    await expect.poll(visiblePanes, { timeout: UI_TIMEOUT_MS }).toEqual([CMD_ONE]);
    await typeInto(CMD_ONE, TYPED_ONE);
    await waitForText(CMD_ONE, OUT_TYPED_ONE);

    await tabOf(CMD_TWO).click();
    await expect.poll(visiblePanes, { timeout: UI_TIMEOUT_MS }).toEqual([CMD_TWO]);
    await typeInto(CMD_TWO, TYPED_TWO);
    await waitForText(CMD_TWO, OUT_TYPED_TWO);

    await tabOf(CMD_ONE).click();
    await expect.poll(visiblePanes, { timeout: UI_TIMEOUT_MS }).toEqual([CMD_ONE]);
    const one = await xtermText(paneOf(CMD_ONE));
    const two = await xtermText(paneOf(CMD_TWO));
    expect(one).toContain(OUT_ONE);
    expect(one).toContain(OUT_TYPED_ONE);
    expect(one).not.toContain(OUT_TWO);
    expect(one).not.toContain(OUT_TYPED_TWO);
    expect(two).toContain(OUT_TWO);
    expect(two).toContain(OUT_TYPED_TWO);
    expect(two).not.toContain(OUT_ONE);
    expect(two).not.toContain(OUT_TYPED_ONE);
    await shot("02-switched");
  });

  it("3. Böl shows both terminals side by side; the partner's tab swaps the panes", async () => {
    await panel().getByRole("button", { name: "Böl", exact: true }).click();
    expect(await panel().getByRole("button", { name: "Böl", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await expectSideBySide(CMD_ONE, CMD_TWO);
    // Make the second terminal the active (left) one, so the restore below differs from the default.
    await tabOf(CMD_TWO).click();
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(CMD_TWO);
    await expectSideBySide(CMD_TWO, CMD_ONE);
    // Typing still reaches only the terminal typed into.
    await typeInto(CMD_ONE, "echo SPLIT_$((5*5))");
    await waitForText(CMD_ONE, "SPLIT_25");
    expect(await xtermText(paneOf(CMD_TWO))).not.toContain("SPLIT_25");
    await shot("03-split");
  });

  it("4. closing a tab asks first; Vazgeç keeps it, the confirmation closes it in the engine too", async () => {
    await openTerminal(CMD_THREE);
    expect(await tabTitles()).toEqual([CMD_ONE, CMD_TWO, CMD_THREE]);
    const close = panel().getByRole("button", { name: `${CMD_THREE} sekmesini kapat`, exact: true });

    await close.click();
    await expect.poll(() => panel().getByText("kapatılsın mı?").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await shot("04-close-confirm");
    await panel().getByRole("button", { name: "Vazgeç", exact: true }).click();
    expect(await tabTitles()).toEqual([CMD_ONE, CMD_TWO, CMD_THREE]);
    expect((await engineTerminals()).map((t) => t.title)).toContain(CMD_THREE);

    await close.click();
    await panel().getByRole("button", { name: "Kapatmayı onayla", exact: true }).click();
    await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).toEqual([CMD_ONE, CMD_TWO]);
    await expect.poll(async () => (await engineTerminals()).map((t) => t.title).sort(), { timeout: UI_TIMEOUT_MS }).toEqual(
      [CMD_ONE, CMD_TWO].sort(),
    );
    // The new terminal had replaced the active (left) pane; closing it hands that pane to its neighbour and the
    // split partner stays.
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(CMD_TWO);
    await expectSideBySide(CMD_TWO, CMD_ONE);
    await shot("05-closed");
  });

  it("5. after a relaunch: same tabs, same active tab, same split", async () => {
    const ids = new Map((await engineTerminals()).map((t) => [t.title, t.id]));
    const one = ids.get(CMD_ONE)!;
    const two = ids.get(CMD_TWO)!;
    await expect
      .poll(savedTabs, { timeout: UI_TIMEOUT_MS })
      .toMatchObject({ order: [one, two], active: two, split: one });

    await app!.close();
    app = undefined;
    await openApp();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).toEqual([CMD_ONE, CMD_TWO]);
    await expect.poll(activeTitle, { timeout: UI_TIMEOUT_MS }).toBe(CMD_TWO);
    expect(await panel().getByRole("button", { name: "Böl", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await expectSideBySide(CMD_TWO, CMD_ONE);
    // Each pane got its own terminal's history back.
    await waitForText(CMD_ONE, OUT_TYPED_ONE);
    await waitForText(CMD_TWO, OUT_TYPED_TWO);
    expect(await xtermText(paneOf(CMD_ONE))).not.toContain(OUT_TYPED_TWO);
    expect(await xtermText(paneOf(CMD_TWO))).not.toContain(OUT_TYPED_ONE);
    await shot("06-relaunched");
  });
});
