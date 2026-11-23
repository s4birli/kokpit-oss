// End-to-end for Yapılacaklar (Adım 6): the built app against a real engine whose clock is pinned
// (KOKPIT_TEST_NOW, TZ). Add, check, reorder, live update from a second client, the note surviving an
// app relaunch, and the next-day rollover after an engine restart. Steps run in order and share state.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Todo } from "@kokpit/shared";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, launchApp, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const ZONE = "Europe/Istanbul";
const DAY1 = "2026-11-16";
const DAY1_NOW = "2026-11-16T09:00:00Z";
const DAY2 = "2026-11-17";
const DAY2_NOW = "2026-11-17T09:00:00Z";
const NOTE = "Toplantıdan önce raporu bitir.\nİkinci satır.";

let root: string;
let configPath: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("todos", () => ({ app, page, engine }));

function writeConfig(port: number): void {
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port, shell: "/bin/sh", shellArgs: [], listenTailscale: false }),
  );
}

const engineEnv = (now: string) => ({
  HOME: join(root, "home"),
  TZ: ZONE,
  KOKPIT_TEST_NOW: now,
});

async function openApp(): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `todos-${name}.png`) });
}

const panel = (): Locator => page.locator("section.kp-todo");
const list = (): Locator => panel().getByRole("list", { name: "Yapılacaklar listesi" });
const texts = (): Promise<(string | null)[]> =>
  list().locator("li").evaluateAll((els) => els.map((el) => el.getAttribute("data-text")));
const dayTitle = (): Promise<string | null> => panel().getByTestId("todo-day").textContent();

async function openTodos(): Promise<void> {
  await page.getByRole("navigation", { name: "Kokpit" }).getByRole("button", { name: "Yapılacaklar" }).click();
  await expect.poll(() => panel().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
  await expect.poll(dayTitle, { timeout: UI_TIMEOUT_MS }).toMatch(/^Bugün/);
}

async function add(text: string): Promise<void> {
  const before = (await texts()).length;
  const box = panel().getByLabel("Yeni yapılacak");
  await box.fill(text);
  await box.press("Enter");
  await expect.poll(async () => (await texts()).length, { timeout: UI_TIMEOUT_MS }).toBe(before + 1);
}

async function engineList(date?: string): Promise<Todo[]> {
  const res = (await engineRequest(engine!.url, KEY, "todos.list", date ? { date } : {})) as { todos: Todo[] };
  return res.todos;
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-todos-")));
  mkdirSync(join(root, "home"));
  configPath = join(root, "engine.json");
  userDataDir = join(root, "user-data");
  writeConfig(0);
  engine = await startEngine(configPath, KEY, engineEnv(DAY1_NOW));
  // Restarts reuse the same port so the app reconnects by itself.
  writeConfig(engine.port);
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await openApp();
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Yapılacaklar UI end-to-end", () => {
  it("0. connects and opens Yapılacaklar on the engine's today", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await openTodos();
    expect(await dayTitle()).toContain("16 Kasım 2026");
    expect(await panel().getByText("Bu gün için yapılacak yok.").isVisible()).toBe(true);
  });

  it("1. adds with Enter, checks one, reorders with a button and with Alt+arrow", async () => {
    await add("Süt al");
    await add("Faturayı öde");
    await add("Raporu yaz");
    await panel().getByRole("checkbox", { name: "Süt al" }).check();
    await expect.poll(async () => (await engineList()).find((t) => t.text === "Süt al")?.done, { timeout: UI_TIMEOUT_MS }).toBe(true);

    await panel().getByRole("button", { name: "Yukarı taşı: Raporu yaz" }).click();
    await expect.poll(texts, { timeout: UI_TIMEOUT_MS }).toEqual(["Süt al", "Raporu yaz", "Faturayı öde"]);

    const item = list().locator('li[data-text="Süt al"]');
    await item.focus();
    await item.press("Alt+ArrowDown");
    await expect.poll(texts, { timeout: UI_TIMEOUT_MS }).toEqual(["Raporu yaz", "Süt al", "Faturayı öde"]);
    await expect
      .poll(async () => (await engineList()).map((t) => t.text), { timeout: UI_TIMEOUT_MS })
      .toEqual(["Raporu yaz", "Süt al", "Faturayı öde"]);
  });

  it("2. a todo created by another client appears live", async () => {
    await engineRequest(engine!.url, KEY, "todos.create", { text: "Başka cihazdan" });
    await expect.poll(texts, { timeout: UI_TIMEOUT_MS }).toEqual(["Raporu yaz", "Süt al", "Faturayı öde", "Başka cihazdan"]);
  });

  it("3. the note is saved and survives an app relaunch", async () => {
    await panel().getByLabel("Not").fill(NOTE);
    await expect.poll(() => panel().getByText("Kaydedildi").isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await engineRequest(engine!.url, KEY, "notes.get", {})).toEqual({ date: DAY1, text: NOTE });
    await shot("01-day1");

    await app!.close();
    app = undefined;
    await openApp();
    await openTodos();
    await expect.poll(() => panel().getByLabel("Not").inputValue(), { timeout: UI_TIMEOUT_MS }).toBe(NOTE);
    expect(await texts()).toEqual(["Raporu yaz", "Süt al", "Faturayı öde", "Başka cihazdan"]);
    expect(await panel().getByRole("checkbox", { name: "Süt al" }).isChecked()).toBe(true);
  });

  it("4. on the next day unfinished todos roll over with a 'dünden' badge; yesterday keeps the done one and the note", async () => {
    await stopEngine(engine);
    engine = await startEngine(configPath, KEY, engineEnv(DAY2_NOW));
    // The app reconnects by itself and reloads "today", which is now the engine's next day.
    await expect.poll(dayTitle, { timeout: UI_TIMEOUT_MS }).toMatch(/^Bugün · 17 Kasım 2026/);
    await expect.poll(texts, { timeout: UI_TIMEOUT_MS }).toEqual(["Raporu yaz", "Faturayı öde", "Başka cihazdan"]);
    expect(await list().getByText("dünden").count()).toBe(3);
    expect(await panel().getByLabel("Not").inputValue()).toBe("");
    expect((await engineList()).every((t) => t.date === DAY2 && t.rolledFrom === DAY1)).toBe(true);
    await shot("02-day2-rollover");

    await panel().getByRole("button", { name: "Önceki gün" }).click();
    await expect.poll(dayTitle, { timeout: UI_TIMEOUT_MS }).toMatch(/^Dün/);
    await expect.poll(texts, { timeout: UI_TIMEOUT_MS }).toEqual(["Süt al"]);
    await expect.poll(() => panel().getByLabel("Not").inputValue(), { timeout: UI_TIMEOUT_MS }).toBe(NOTE);
    expect(await panel().getByLabel("Yeni yapılacak").count()).toBe(0);
    await shot("03-day1-after-rollover");
  });
});
