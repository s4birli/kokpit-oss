// Terminal geçmişi end-to-end: the built app (Electron, Playwright `_electron`) against a real engine with its
// DEFAULT history size. A program (the engine's test fixture flood.ts — never a real tool) fills the terminal's
// history buffer several times over and keeps printing numbered lines. Closing and reopening the app, and reloading
// the window, must bring the history back: the terminal is never blank until the next output.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, launchApp, launchTerminal, SCREENSHOT_DIR, sleep, startEngine, stopEngine, xtermLines, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
/** The flood is megabytes of escape sequences through the DOM renderer. */
const FLOOD_TIMEOUT_MS = 90_000;
const PROJECT = "Geçmiş Projesi";
const FLOOD = fileURLToPath(new URL("../../engine/test/fixtures/flood.ts", import.meta.url));
const { bufferBytes: BUFFER_BYTES } = JSON.parse(readFileSync(new URL("../../engine/config.defaults.json", import.meta.url), "utf8")) as { bufferBytes: number };
/** The program prints this many buffers' worth before it starts ticking: the buffer is full and has wrapped. */
const FLOOD_BUFFERS = 3;
const TICK_MS = 400;
/** How long the app stays closed: several ticks are printed meanwhile. */
const CLOSED_MS = 2_000;
const NOTICE = "Geçmiş yüklenemedi";

let root: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("terminal-history", () => ({ app, page, engine }));
let command: string;

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const term = (): Locator => page.getByRole("region", { name: `Terminal: ${command}`, exact: true });

async function openApp(): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `gecmis-${name}.png`) });
}

/** Numbers of the tick lines on screen, top to bottom. */
async function ticks(): Promise<number[]> {
  return (await xtermLines(term())).flatMap((line) => {
    const m = /^TIK_(\d+)_/.exec(line);
    return m ? [Number(m[1])] : [];
  });
}

async function lastTick(): Promise<number> {
  return Math.max(-1, ...(await ticks()));
}

/** What is on screen is one unbroken run of ticks: nothing lost or doubled where the history meets live output. */
async function expectUnbroken(): Promise<void> {
  const seen = await ticks();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).toEqual(seen.map((_n, i) => seen[0]! + i));
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-history-")));
  userDataDir = join(root, "user-data");
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "work"));
  command = `exec '${process.execPath}' '${FLOOD}' ${FLOOD_BUFFERS * BUFFER_BYTES} ${TICK_MS}`;
  const configPath = join(root, "engine.json");
  // No `bufferBytes`: the engine's default, as the user runs it.
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false, flushIntervalMs: 100, killGraceMs: 200 }),
  );
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home") });
  // Never start the seeded global default tool (claude).
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await engineRequest(engine.url, KEY, "projects.create", { name: PROJECT, location: { kind: "local", path: join(root, "work") } });

  await openApp();
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().getByRole("button", { name: PROJECT, exact: true }).click();
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Terminal geçmişi end-to-end", () => {
  let seenBeforeClose = -1;

  it("1. a program fills the history buffer several times over and keeps printing", async () => {
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await launchTerminal(page, command);
    await expect.poll(lastTick, { timeout: FLOOD_TIMEOUT_MS, interval: 250 }).toBeGreaterThanOrEqual(2);
    await shot("01-dolu-gecmis");
  });

  it("2. closing and reopening the app shows the history — including what was printed while it was closed", async () => {
    seenBeforeClose = await lastTick();
    const closing = app!;
    app = undefined;
    await closing.close();
    await sleep(CLOSED_MS);

    await openApp();
    await expect.poll(() => rail().getByText(PROJECT, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    // Not blank: the line right after the last one seen was printed while the app was closed — only the history has it.
    await expect.poll(ticks, { timeout: UI_TIMEOUT_MS, interval: 100 }).toContain(seenBeforeClose + 1);
    await expectUnbroken();
    expect(await page.getByText(NOTICE).count()).toBe(0);
    // …and it is still running.
    const now = await lastTick();
    await expect.poll(lastTick, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(now + 1);
    await expectUnbroken();
    await shot("02-yeniden-acildi");
  });

  it("3. reloading the window re-attaches: the history is there again, once", async () => {
    const before = await lastTick();
    await page.reload();
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    // Ticks from before the reload can only come from the history.
    await expect.poll(async () => (await ticks())[0] ?? Infinity, { timeout: UI_TIMEOUT_MS, interval: 100 }).toBeLessThanOrEqual(before);
    await expect.poll(lastTick, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before + 1);
    await expectUnbroken();
    expect(await page.getByText(NOTICE).count()).toBe(0);
    await shot("03-yeniden-yuklendi");
  });
});
