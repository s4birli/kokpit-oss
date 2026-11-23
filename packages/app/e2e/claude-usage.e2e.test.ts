// End-to-end for Claude kullanımı: the built Kokpit app (Electron) against a real engine with a temp HOME whose two
// account folders hold SYNTHETIC transcripts, and a fake `claude` on PATH for "Claude'a sor". The real `claude`,
// ~/.claude*, credentials and the Keychain are never touched. Steps run in order and share state.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeClaude, type FakeClaude } from "../../engine/test/fakes/fake-claude-agents-setup.ts";
import { appendTranscript, SECRET_SUBDIR, SECRET_TEXT, SECRET_TITLE, writeTranscript } from "../../engine/test/fixtures/claude-usage.ts";
import { clickMenu, launchApp, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REFRESH_MS = 1500;
const WORK_PROJECT = "Work işi";

let root: string;
let home: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let fake: FakeClaude;
let workTranscript: string;

diagnoseFailures("claude-usage", () => ({ app, page, engine }));

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `claude-usage-${name}.png`) });
}

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const form = (): Locator => page.locator("form.kp-settings__form");
const item = (name: string): Locator => page.locator("li.kp-item").filter({ has: page.getByRole("heading", { name, exact: true }) });
const usage = (scope: Locator | Page, name: string): Locator => scope.getByRole("group", { name: `Claude kullanımı: ${name}` });
const rowText = (block: Locator, label: string): Promise<string | null> => block.getByRole("row", { name: new RegExp(`^${label}`) }).textContent();
const projectTab = (name: string): Locator =>
  page.getByRole("toolbar", { name: "Proje sekmeleri" }).locator(".kp-ptab").filter({ has: page.getByRole("button", { name, exact: true }) });

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

async function save(): Promise<void> {
  await form().getByRole("button", { name: "Kaydet" }).click();
  await expect.poll(() => form().count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-usage-")));
  home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(root, "work"));
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `${SECRET_TEXT}-TOKEN` } }));
  const now = Date.now();
  writeTranscript(join(home, ".claude"), "-benim/s1.jsonl", [
    { id: "b1", t: now - HOUR, cwd: `/x/${SECRET_SUBDIR}/benim-isim`, input: 1000, output: 20_000, cacheWrite: 300_000, cacheRead: 4_000_000, blocks: 3 },
    { id: "b2", t: now - 3 * DAY, cwd: "/x/eski-is", model: "claude-haiku-5-5", input: 500, output: 500, cacheWrite: 0, cacheRead: 99_000 },
  ]);
  workTranscript = writeTranscript(join(home, ".claude-work"), "-work/s1.jsonl", [
    { id: "k1", t: now - 30 * 60_000, cwd: join(root, "work"), model: "claude-fable-5-2", input: 0, output: 200_000, cacheWrite: 0, cacheRead: 1_000_000 },
  ]);
  fake = installFakeClaude(root, []);
  fake.setRateLimits(join(home, ".claude-work"), { seven_day: { utilization: 0.59, resetsAt: Math.round((now + 2 * DAY) / 1000) } });
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      killGraceMs: 200,
      claudeUsage: { refreshIntervalMs: REFRESH_MS },
    }),
  );
  engine = await startEngine(configPath, KEY, {
    HOME: home,
    PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
    KOKPIT_BG_AGENTS_POLL_MS: "0",
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

describe("Claude kullanımı UI end-to-end", () => {
  it("connects", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await expect.poll(() => rail().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
  });

  it("Ayarlar › Claude hesapları shows each account's usage, counted from its own folder", async () => {
    await openSettings("Claude hesapları");
    await page.getByRole("button", { name: "Hesap ekle" }).click();
    await form().getByLabel("Ad", { exact: true }).fill("Work");
    await form().getByLabel("Ayar klasörü", { exact: true }).fill("~/.claude-work");
    await save();

    const benim = usage(item("Benim"), "Benim");
    const work = usage(item("Work"), "Work");
    await expect.poll(() => rowText(benim, "Son 5 saat"), { timeout: UI_TIMEOUT_MS }).toContain("4,3 Mn");
    // total · input · output · cache write · cache read · messages (one message although written as three lines)
    expect((await rowText(benim, "Son 5 saat"))!.replace(/\s+/g, " ")).toContain("4,3 Mn1 B20 B300 B4 Mn1");
    expect(await rowText(benim, "Son 7 gün")).toContain("4,4 Mn");
    await expect.poll(() => rowText(work, "Son 5 saat"), { timeout: UI_TIMEOUT_MS }).toContain("1,2 Mn");
    expect(await benim.getByText("Kokpit bu Mac'teki oturum kayıtlarından sayar; Claude'un kendi kota yüzdesi değildir.").isVisible()).toBe(true);
    expect(await benim.getByText(/^Son güncelleme: \d\d:\d\d$/).isVisible()).toBe(true);
    // Breakdown of the long window: models and projects, by folder NAME only.
    expect(await benim.getByRole("list", { name: /^Modeller/ }).textContent()).toContain("Opus");
    expect(await benim.getByRole("list", { name: /^Modeller/ }).textContent()).toContain("Haiku");
    expect(await benim.getByRole("list", { name: /^Projeler/ }).textContent()).toContain("benim-isim");
    expect(await work.getByRole("list", { name: /^Modeller/ }).textContent()).toContain("Fable");
    // No quota figures yet: nothing gave them, and Kokpit reads no credentials.
    expect(await work.getByRole("meter").count()).toBe(0);
    expect(await work.getByText(/Claude'un kendi kota yüzdesi bilinmiyor/).isVisible()).toBe(true);
    await shot("settings");
  });

  it("new messages appear without leaving the tab (the view re-reads at the engine's interval)", async () => {
    appendTranscript(workTranscript, [{ id: "k2", t: Date.now() - 1000, cwd: join(root, "work"), model: "claude-fable-5-2", output: 1_800_000 }], Date.now());
    const work = usage(item("Work"), "Work");
    await expect.poll(() => rowText(work, "Son 5 saat"), { timeout: UI_TIMEOUT_MS }).toContain("3 Mn");
  });

  it("“Claude'a sor” asks only after confirmation and then shows Claude's own weekly figure", async () => {
    const work = usage(item("Work"), "Work");
    await work.getByRole("button", { name: "Claude'a sor: Work" }).click();
    expect(await work.getByText(/küçük bir istek/).isVisible()).toBe(true);
    expect(fake.calls().filter((c) => c[0] === "-p")).toHaveLength(0);
    await work.getByRole("button", { name: "Sor", exact: true }).click();
    const meter = work.getByRole("meter", { name: "haftalık kota" });
    await expect.poll(() => meter.count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    expect(await meter.getAttribute("aria-valuetext")).toBe("%59");
    expect(await work.textContent()).toContain("Claude'a soruldu");
    expect(fake.calls().filter((c) => c[0] === "-p")).toHaveLength(1);
    // The other account was not asked.
    expect(await usage(item("Benim"), "Benim").getByRole("meter").count()).toBe(0);
    await shot("settings-plan");
  });

  it("the account badge on a project tab carries the numbers in its tooltip", async () => {
    await openSettings("Projeler");
    await page.getByRole("button", { name: "Proje ekle" }).click();
    await form().getByLabel("Ad", { exact: true }).fill(WORK_PROJECT);
    await form().getByLabel("Klasör yolu", { exact: true }).fill(join(root, "work"));
    await form().getByLabel("Claude hesabı", { exact: true }).selectOption({ label: "Work" });
    await save();
    await closeSettings();
    await rail().getByRole("button", { name: WORK_PROJECT, exact: true }).click();
    const badge = projectTab(WORK_PROJECT).locator(".kp-ptab__account");
    await expect.poll(() => badge.count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await badge.hover();
    await expect.poll(() => badge.getAttribute("title"), { timeout: UI_TIMEOUT_MS }).toContain("Son 5 saat: 3 Mn token");
    const title = (await badge.getAttribute("title"))!;
    expect(title).toContain("Claude hesabı");
    expect(title).toContain("Claude kotası: haftalık %59");
    expect(title).toContain("Kokpit'in bu Mac'teki sayımı");
  });

  it("the Claude panel has a Kullanım tab: the project's account first, its sessions under the Kokpit project's name", async () => {
    await clickMenu(app!, ["Görünüm", "Claude"]);
    const panel = page.getByRole("region", { name: "Claude", exact: true });
    await expect.poll(() => panel.count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await panel.getByRole("tab", { name: "Kullanım" }).click();
    await expect.poll(() => panel.getByRole("group").count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    expect(await panel.getByRole("group").first().getAttribute("aria-label")).toBe("Claude kullanımı: Work");
    expect(await panel.getByRole("heading", { name: "Work (bu projenin hesabı)" }).isVisible()).toBe(true);
    const work = usage(panel, "Work");
    await expect.poll(() => work.getByRole("list", { name: /^Projeler/ }).textContent(), { timeout: UI_TIMEOUT_MS }).toContain(WORK_PROJECT);
    await shot("panel");
  });

  it("no message text, session title, deep folder or token ever reached the window or the engine's log", async () => {
    await openSettings("Claude hesapları");
    await expect.poll(() => usage(item("Benim"), "Benim").count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    const dom = await page.content();
    const log = engine!.log();
    for (const secret of [SECRET_TEXT, SECRET_TITLE, SECRET_SUBDIR, "FAKE-PROBE-ANSWER"]) {
      expect(dom).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
    await closeSettings();
  });
});
