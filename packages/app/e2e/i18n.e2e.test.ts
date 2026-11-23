// i18n end-to-end: the English edition (app and engine in English) shows no Turkish — the connect screen, the
// workbench with its default panels, the View menu and every Ayarlar tab are scanned for Turkish-only letters, with
// the test's own user data (project, engine-seeded names) set aside. Then the language is switched at runtime in
// Settings › Language, and the choice survives a restart of the app.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_DIR, engineRequest, git, launchApp, menuItem, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";
import { LOCALES, localeName } from "@kokpit/shared/i18n";

const KEY = randomBytes(32).toString("hex");
const PROJECT_NAME = "Demo Project";
const UI_TIMEOUT_MS = 20_000;
const ENGLISH = { app: { KOKPIT_TEST_LANGUAGE: "en" }, engine: { KOKPIT_LANGUAGE: "en" } };
/** Letters that only Turkish uses among the two languages. */
const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;
/** The language picker lists each language by its own name ("Türkçe"): that is meant to stay. */
const LANGUAGE_NAMES = LOCALES.map(localeName);
const SETTINGS_TABS_EN = ["Projects", "Servers", "Tools", "Claude accounts", "Sites", "Connection", "Language"];

let root: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
/** User data the scan sets aside: names the engine seeded from its config (tools), not text of the app. */
let userData: string[] = [];

diagnoseFailures("i18n", () => ({ app, page, engine }));

async function openApp(env: Record<string, string>): Promise<void> {
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir, ...env });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function closeApp(): Promise<void> {
  const a = app;
  app = undefined;
  await a?.close();
}

/**
 * Every piece of text the window shows or announces (text nodes, aria-label, title, placeholder, alt, option
 * labels) that contains a Turkish-only letter, after setting aside the given user data. Terminal output is the
 * shell's, not the app's, and is skipped.
 */
async function turkishLeftovers(allowed: readonly string[]): Promise<string[]> {
  const found = await page.evaluate(() => {
    const out: string[] = [];
    const skip = (el: Element | null): boolean => !!el?.closest(".xterm");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue?.trim();
      if (text && !skip(n.parentElement)) out.push(text);
    }
    for (const el of document.body.querySelectorAll("*")) {
      if (skip(el)) continue;
      for (const attr of ["aria-label", "title", "placeholder", "alt", "aria-description"]) {
        const v = el.getAttribute(attr);
        if (v) out.push(`[${attr}] ${v}`);
      }
    }
    out.push(`[document.title] ${document.title}`);
    return out;
  });
  return found.filter((text) => {
    let rest = text;
    // Longest first: "Claude + browser" must not lose only its "Claude".
    for (const a of [...allowed, ...LANGUAGE_NAMES].sort((x, y) => y.length - x.length)) rest = rest.split(a).join("");
    return TURKISH_LETTERS.test(rest);
  });
}

/** Every string value of a `name` key anywhere in a JSON value. */
function namesIn(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(namesIn);
  if (v === null || typeof v !== "object") return [];
  return Object.entries(v).flatMap(([k, x]) => (k === "name" && typeof x === "string" ? [x] : namesIn(x)));
}

const rail = () => page.getByRole("navigation").first();

async function openSettings(name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).first().click();
  await expect.poll(() => page.getByRole("tablist").count(), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-i18n-")));
  const repo = join(root, "repo");
  userDataDir = join(root, "user-data");
  const configPath = join(root, "engine.json");
  mkdirSync(repo);
  mkdirSync(join(root, "home"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "e2e\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
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
      projects: [{ name: PROJECT_NAME, repoPath: repo, id: "demo" }],
      // Config-seeded names are user data; the English edition's config names its projects in English.
      browser: { testMode: true, headless: true, projectName: "Browser tasks" },
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home"), ...ENGLISH.engine });
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  // Tool names are data the engine seeds from its config (tools.defaults.json, built-in variants included); the
  // scan sets them aside.
  const tools = (await engineRequest(engine.url, KEY, "tools.list", {})) as { tools: { name: string }[] };
  const seeded = JSON.parse(readFileSync(join(ENGINE_DIR, "tools.defaults.json"), "utf8")) as unknown;
  userData = [...tools.tools.map((t) => t.name), ...namesIn(seeded)];
});

afterAll(async () => {
  await closeApp().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("i18n: the English edition", () => {
  it("1. the connect screen is in English, with no Turkish left", async () => {
    await openApp(ENGLISH.app);
    await expect.poll(() => page.getByRole("heading", { name: "Connect to the engine" }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.lang)).toMatch(/^en/);
    expect(await turkishLeftovers(userData)).toEqual([]);
  });

  it("2. the workbench, its default panels and the menu bar are in English", async () => {
    await page.getByLabel("Engine address").fill(engine!.url);
    await page.getByLabel("Key").fill(KEY);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.poll(() => rail().getByText(PROJECT_NAME, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await rail().getByText(PROJECT_NAME, { exact: true }).click();
    for (const title of ["Files", "Browser", "Agents", "Terminal"]) {
      await expect.poll(() => page.getByText(title, { exact: true }).first().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    }
    expect(await menuItem(app!, ["View"])).not.toBeNull();
    expect(await menuItem(app!, ["Görünüm"])).toBeNull();
    await page.screenshot({ path: join(SCREENSHOT_DIR, "i18n-01-workbench-en.png") });
    expect(await turkishLeftovers([PROJECT_NAME, ...userData])).toEqual([]);
  });

  it("3. every Settings tab is in English", async () => {
    await openSettings("Settings");
    expect(await page.getByRole("tab").allTextContents()).toEqual(SETTINGS_TABS_EN);
    for (const tab of SETTINGS_TABS_EN) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect.poll(() => page.getByRole("tab", { name: tab, exact: true }).getAttribute("aria-selected")).toBe("true");
      // Lists load from the engine; give them a moment before scanning.
      await page.waitForTimeout(300);
      expect(await turkishLeftovers([PROJECT_NAME, ...userData]), tab).toEqual([]);
    }
  });
});

describe("i18n: switching the language", () => {
  it("4. Settings › Language switches the whole app at once (window and menu bar)", async () => {
    await page.getByRole("tab", { name: "Language", exact: true }).click();
    await page.getByRole("combobox", { name: "Language" }).selectOption("tr");
    await expect.poll(() => page.getByRole("tab", { name: "Dil", exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await page.getByRole("tab").allTextContents()).toEqual(["Projeler", "Sunucular", "Araçlar", "Claude hesapları", "Siteler", "Bağlantı", "Dil"]);
    expect(await page.evaluate(() => document.documentElement.lang)).toMatch(/^tr/);
    await expect.poll(() => menuItem(app!, ["Görünüm"]), { timeout: UI_TIMEOUT_MS }).not.toBeNull();
    expect(await menuItem(app!, ["View"])).toBeNull();
  });

  it("5. the choice is kept on this machine across a restart (over the build's default)", async () => {
    await closeApp();
    await openApp(ENGLISH.app);
    await expect.poll(() => rail().getByText(PROJECT_NAME, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await openSettings("Ayarlar");
    await page.getByRole("tab", { name: "Dil", exact: true }).click();
    expect(await page.getByRole("combobox", { name: "Dil" }).inputValue()).toBe("tr");
    // And back to English, at once.
    await page.getByRole("combobox", { name: "Dil" }).selectOption("en");
    await expect.poll(() => page.getByRole("tab", { name: "Language", exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await turkishLeftovers([PROJECT_NAME, ...userData])).toEqual([]);
  });
});
