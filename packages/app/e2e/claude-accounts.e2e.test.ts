// End-to-end for İş H (Adım 8, Claude hesapları): the built Kokpit app (Electron) against a real engine with a
// temp HOME and a fake `claude` on PATH (prints $CLAUDE_CONFIG_DIR, lists background sessions per config dir).
// The real `claude`, ~/.claude and the Keychain are never touched. Steps run in order and share state.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeClaude, type FakeClaude } from "../../engine/test/fakes/fake-claude-agents-setup.ts";
import { escapeRe, launchApp, launchTerminal, SCREENSHOT_DIR, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const POLL_MS = 300;
const WORK_PROJECT = "Work işi";
const PLAIN_PROJECT = "Düz proje";

let root: string;
let home: string;
let workDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("claude-accounts", () => ({ app, page, engine }));
let fake: FakeClaude;

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `claude-accounts-${name}.png`) });
}

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panels = (): Locator => page.locator("section.kp-term");
const form = (): Locator => page.locator("form.kp-settings__form");
/** A project's tab above the work area; the account badge (non-default accounts only) sits on it. */
const projectTab = (name: string): Locator =>
  page.getByRole("toolbar", { name: "Proje sekmeleri" }).locator(".kp-ptab").filter({ has: page.getByRole("button", { name, exact: true }) });
const headerTitle = (): Promise<string | null> => page.locator(".kp-header__title").textContent();
const item = (name: string): Locator => page.locator("li.kp-item").filter({ has: page.getByRole("heading", { name, exact: true }) });
const bgSection = (): Locator =>
  page.getByRole("main").getByRole("region", { name: "Ajanlar" }).getByRole("region", { name: "Arka plan ajanları" });

async function openSettings(tab: "Projeler" | "Claude hesapları"): Promise<void> {
  if ((await page.getByRole("tablist", { name: "Ayarlar" }).count()) === 0) {
    await rail().getByRole("button", { name: "Ayarlar", exact: true }).click();
  }
  await page.getByRole("tab", { name: tab }).click();
  await expect.poll(() => page.getByRole("tab", { name: tab }).getAttribute("aria-selected"), { timeout: UI_TIMEOUT_MS }).toBe("true");
}

async function closeSettings(): Promise<void> {
  if ((await page.getByRole("tablist", { name: "Ayarlar" }).count()) === 0) return;
  await page.getByRole("button", { name: "Geri", exact: true }).click();
  await expect.poll(() => rail().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
}

async function fill(label: string, value: string): Promise<void> {
  await form().getByLabel(label, { exact: true }).fill(value);
}

async function save(): Promise<void> {
  await form().getByRole("button", { name: "Kaydet" }).click();
  await expect.poll(() => form().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
}

async function selectProject(name: string): Promise<void> {
  await rail().getByRole("button", { name, exact: true }).click();
  await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(name);
}

/** New terminal in the selected project running `command`; returns its panel. */
async function newTerminal(command: string): Promise<Locator> {
  const before = await panels().count();
  await launchTerminal(page, command);
  await expect.poll(() => panels().count(), { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before);
  return panels().last();
}

async function addProject(name: string, dir: string, account?: string): Promise<void> {
  await openSettings("Projeler");
  await page.getByRole("button", { name: "Proje ekle" }).click();
  await fill("Ad", name);
  await fill("Klasör yolu", dir);
  if (account) await form().getByLabel("Claude hesabı", { exact: true }).selectOption({ label: account });
  await save();
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-accounts-")));
  home = join(root, "home");
  workDir = join(home, ".claude-work");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(root, "work"));
  mkdirSync(join(root, "duz"));
  fake = installFakeClaude(root, [
    { id: "aaaa1111", cwd: join(root, "duz"), name: "Benim ajanım", state: "working", status: "busy", kind: "background", startedAt: Date.now() - 60_000 },
  ]);
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false, killGraceMs: 200 }),
  );
  engine = await startEngine(configPath, KEY, {
    HOME: home,
    PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
    KOKPIT_BG_AGENTS_POLL_MS: String(POLL_MS),
    ...fake.env,
  });
  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Claude hesapları UI end-to-end", () => {
  it("0. connects", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await expect.poll(() => rail().getByRole("button", { name: "Ayarlar", exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
  });

  it("1. Ayarlar › Claude hesapları lists the default account and adds Work's", async () => {
    await openSettings("Claude hesapları");
    await expect.poll(() => item("Benim").textContent(), { timeout: UI_TIMEOUT_MS }).toContain(join(home, ".claude"));
    expect(await item("Benim").getByText("Varsayılan").count()).toBe(1);
    await page.getByRole("button", { name: "Hesap ekle" }).click();
    await fill("Ad", "Work");
    await fill("Ayar klasörü", "~/.claude-work");
    await save();
    await expect.poll(() => item("Work").textContent(), { timeout: UI_TIMEOUT_MS }).toContain(workDir);
    expect(lstatSync(workDir).isDirectory()).toBe(true);
    await shot("01-hesaplar");
  });

  it("2. Skill'leri paylaş asks first, then links the default account's skills", async () => {
    await item("Work").getByRole("button", { name: "Skill'leri paylaş: Work" }).click();
    await expect.poll(() => item("Work").getByText(/var olanlara dokunulmaz/).count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await shot("02-paylas-onay");
    await item("Work").getByRole("button", { name: "Paylaşmayı onayla" }).click();
    await expect.poll(() => item("Work").getByRole("status").textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/Bağlandı: skills/);
    expect(readlinkSync(join(workDir, "skills"))).toBe(join(home, ".claude", "skills"));
  });

  it("3. Giriş yap opens `claude /login` with Work's config dir in the built-in project", async () => {
    await item("Work").getByRole("button", { name: "Giriş yap: Work" }).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe("Mac mini");
    await expect
      .poll(() => xtermText(panels().last()), { timeout: UI_TIMEOUT_MS })
      .toMatch(new RegExp(`FAKE-LOGIN CONFIG_DIR=\\[${escapeRe(workDir)}\\]`));
    await shot("03-giris");
  });

  it("4. a project assigned to Work opens terminals with CLAUDE_CONFIG_DIR; its tab names the account", async () => {
    await addProject(WORK_PROJECT, join(root, "work"), "Work");
    await addProject(PLAIN_PROJECT, join(root, "duz"));
    expect(await item(WORK_PROJECT).textContent()).toContain("Claude hesabı: Work");
    await shot("04-proje-formu");
    await closeSettings();

    await selectProject(WORK_PROJECT);
    await expect.poll(() => projectTab(WORK_PROJECT).getByTitle("Claude hesabı").textContent(), { timeout: UI_TIMEOUT_MS }).toBe("Work");
    const workTerm = await newTerminal("claude config-dir");
    await expect.poll(() => xtermText(workTerm), { timeout: UI_TIMEOUT_MS }).toMatch(new RegExp(`CONFIG_DIR=\\[${escapeRe(workDir)}\\]`));
    await shot("05-work-terminal");

    await selectProject(PLAIN_PROJECT);
    expect(await projectTab(PLAIN_PROJECT).getByTitle("Claude hesabı").count()).toBe(0);
    const plainTerm = await newTerminal("claude config-dir");
    await expect.poll(() => xtermText(plainTerm), { timeout: UI_TIMEOUT_MS }).toMatch(/CONFIG_DIR=\[\]/);
  });

  it("5. background agents come from both accounts; Work's carries the account badge", async () => {
    fake.setSessionsFor(workDir, [
      { id: "bbbb2222", cwd: join(root, "work"), name: "Work'in ajanı", state: "blocked", kind: "background", startedAt: Date.now() - 120_000 },
    ]);
    await selectProject(WORK_PROJECT);
    const row = bgSection().locator('[data-bg-agent-id="bbbb2222"]');
    await expect.poll(() => row.count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    expect(await row.getByTitle("Claude hesabı").textContent()).toBe("Work");
    await bgSection().getByLabel("Tüm projeler").check();
    const mine = bgSection().locator('[data-bg-agent-id="aaaa1111"]');
    await expect.poll(() => mine.count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    expect(await mine.getByTitle("Claude hesabı").count()).toBe(0);
    await shot("06-arka-plan");
  });
});
