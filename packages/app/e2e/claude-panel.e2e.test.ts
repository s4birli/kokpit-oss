// İş C (Adım 8) — Claude paneli end-to-end: the built app (Electron, Playwright `_electron`) against a real engine
// whose HOME is a temp folder with a fake `~/.claude` (never the real one). Open the hidden panel from Görünüm, see
// the fixture skill/agent/command with their sources, preview one, search the Rehber.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickMenu, engineRequest, launchApp, menuItem, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const PROJECT = "Claude'lu";
const SECRET = "KOKPIT-CLAUDE-PANEL-E2E-GIZLI";
const SKILL_BODY = "---\nname: derle\ndescription: Projeyi derler ve sınar\n---\n# Derle\n\n1. pnpm build\n";

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("claude-panel", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panel = (): Locator => page.getByRole("region", { name: "Claude", exact: true });
const tab = (name: string): Locator => panel().getByRole("tab", { name: new RegExp(`^${name}`) });
const items = (): Locator => panel().getByRole("list", { name: "Öğeler" });
const preview = (): Locator => panel().getByRole("region", { name: "Önizleme" });

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `claude-${name}.png`) });
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-claude-")));
  const home = join(root, "home");
  const cfg = join(home, ".claude");
  const repo = join(root, "depo");
  put(join(cfg, ".credentials.json"), SECRET);
  put(join(cfg, "skills", "gunluk", "SKILL.md"), "---\nname: gunluk\ndescription: Günlük özet çıkarır\n---\n");
  put(join(cfg, "agents", "denetci.md"), "---\nname: denetci\ndescription: Kodu denetler\n---\nSen bir denetçisin.\n");
  put(join(cfg, "plugins", "guc", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "guc" }));
  put(join(cfg, "plugins", "guc", "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Önce test yaz\n---\n");
  put(join(repo, ".claude", "skills", "derle", "SKILL.md"), SKILL_BODY);
  put(join(repo, ".claude", "commands", "yayinla.md"), "---\ndescription: Sürüm yayınlar\n---\nAdımlar\n");
  put(join(repo, "CLAUDE.md"), "# Proje\n");

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
  engine = await startEngine(configPath, KEY, { HOME: home });
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await engineRequest(engine.url, KEY, "projects.create", { name: PROJECT, location: { kind: "local", path: repo } });

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().getByText(PROJECT, { exact: true }).waitFor({ timeout: UI_TIMEOUT_MS });
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Claude paneli UI end-to-end", () => {
  it("1. is hidden by default and opens from Görünüm", async () => {
    await rail().getByRole("button", { name: PROJECT, exact: true }).click();
    await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    // İş M: Görünüm is the native menu bar.
    expect((await menuItem(app!, ["Görünüm", "Claude"]))?.checked).toBe(false);
    expect(await panel().count()).toBe(0);
    await clickMenu(app!, ["Görünüm", "Claude"]);
    await panel().waitFor({ timeout: UI_TIMEOUT_MS });
    await expect.poll(async () => (await menuItem(app!, ["Görünüm", "Claude"]))?.checked, { timeout: UI_TIMEOUT_MS }).toBe(true);
  });

  it("2. lists the fixture skills with source badges", async () => {
    await expect.poll(() => items().locator(".kp-claude__name").allTextContents(), { timeout: UI_TIMEOUT_MS }).toEqual([
      "derle",
      "gunluk",
      "guc:tdd",
    ]);
    expect(await items().locator(".kp-claude__badge").allTextContents()).toEqual(["Proje", "Hesap", "Plugin"]);
    expect(await panel().textContent()).not.toContain(SECRET);
    await shot("01-skilller");
  });

  it("3. agents and commands tabs", async () => {
    await tab("Ajanlar").click();
    await expect.poll(() => items().locator(".kp-claude__name").allTextContents(), { timeout: UI_TIMEOUT_MS }).toEqual(["denetci"]);
    await tab("Komutlar").click();
    await expect.poll(() => items().locator(".kp-claude__name").allTextContents(), { timeout: UI_TIMEOUT_MS }).toEqual(["/yayinla"]);
  });

  it("4. previews a skill read-only", async () => {
    await tab("Skill'ler").click();
    await items().getByRole("button", { name: /derle/ }).click();
    await expect.poll(() => preview().locator("code").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(SKILL_BODY);
    expect(await preview().locator(".kp-files__path").textContent()).toBe(".claude/skills/derle/SKILL.md");
    await shot("02-onizleme");
  });

  it("5. search filters the list", async () => {
    await panel().getByRole("searchbox", { name: "Ara" }).fill("günlük");
    await expect.poll(() => items().locator(".kp-claude__name").allTextContents(), { timeout: UI_TIMEOUT_MS }).toEqual(["gunluk"]);
  });

  it("6. Rehber: searchable slash commands and flags, plus the project's command", async () => {
    await tab("Rehber").click();
    const search = panel().getByRole("searchbox", { name: "Ara" });
    await search.fill("");
    await expect.poll(() => panel().getByText("/compact", { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await panel().getByText("/yayinla", { exact: true }).isVisible()).toBe(true);
    expect(await panel().getByText(/Claude Code \d+\.\d+\.\d+ sürümünden/).isVisible()).toBe(true);
    await shot("03-rehber");
    await search.fill("worktree");
    await expect.poll(() => panel().getByText("/compact", { exact: true }).count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    expect(await panel().getByText("-w, --worktree [ad]", { exact: true }).isVisible()).toBe(true);
    await shot("04-rehber-arama");
  });
});
