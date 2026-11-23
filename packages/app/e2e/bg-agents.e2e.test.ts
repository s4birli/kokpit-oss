// End-to-end for İş A (Adım 7, arka plan ajanları): the built Kokpit app (Electron) against a real engine whose
// PATH starts with a fake `claude` (scripted `claude agents --json --all`, recorded attach/logs/stop). The real
// `claude` never runs. Steps run in order and share state.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, TerminalInfo } from "@kokpit/shared";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeClaude, type FakeClaude } from "../../engine/test/fakes/fake-claude-agents-setup.ts";
import { engineRequest, launchApp, SCREENSHOT_DIR, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const POLL_MS = 300;
const PROJECT = "Arka Plan Projesi";

let root: string;
let projectDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("bg-agents", () => ({ app, page, engine }));
let fake: FakeClaude;
let project: Project;

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `bg-agents-${name}.png`) });
}

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const waiting = (): Locator => rail().getByRole("region", { name: "Seni bekleyen" });
const agentsPanel = (): Locator => page.getByRole("main").getByRole("region", { name: "Ajanlar" });
const bgSection = (): Locator => agentsPanel().getByRole("region", { name: "Arka plan ajanları" });
const headerTitle = (): Promise<string | null> => page.locator(".kp-header__title").textContent();

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-bgagents-")));
  const home = join(root, "home");
  projectDir = join(root, "arka plan projesi");
  mkdirSync(home);
  mkdirSync(join(projectDir, "src"), { recursive: true });
  const started = Date.now();
  fake = installFakeClaude(root, [
    { id: "a1b2c3d4", cwd: join(projectDir, "src"), name: "Testleri düzelt", state: "blocked", kind: "background", startedAt: started - 12 * 60_000 },
    { id: "e5f6a7b8", cwd: projectDir, name: "Sıradaki adım", state: "idle", kind: "background", startedAt: started - 4 * 60_000 },
    { id: "c9d0e1f2", cwd: projectDir, name: "Derleme", state: "working", status: "busy", kind: "background", startedAt: started - 60_000 },
    { id: "0f1e2d3c", cwd: projectDir, name: "Eski rapor", state: "done", kind: "background", startedAt: started - 3 * 3_600_000 },
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
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  ({ project } = (await engineRequest(engine.url, KEY, "projects.create", {
    name: PROJECT,
    location: { kind: "local", path: projectDir },
  })) as { project: Project });

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("arka plan ajanları UI end-to-end", () => {
  it("0. connects; Seni bekleyen lists the waiting background agents with their reason", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await expect.poll(() => rail().getByText(PROJECT, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => waiting().getByRole("button").count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    const texts = await waiting().getByRole("button").allTextContents();
    expect(texts[0]).toMatch(new RegExp(`Testleri düzelt.*${PROJECT} · onay bekliyor`));
    expect(texts[1]).toMatch(new RegExp(`Sıradaki adım.*${PROJECT} · sıra sende`));
    await expect.poll(() => rail().getByLabel(`${PROJECT}: 1 çalışıyor, 2 seni bekliyor`).count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
  });

  it("1. clicking one selects the project; the panel groups Seni bekliyor / Çalışıyor / Bitti (collapsed)", async () => {
    await waiting().getByRole("button", { name: /Testleri düzelt/ }).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(PROJECT);
    await expect.poll(() => bgSection().getByRole("list", { name: "Seni bekliyor" }).getByRole("listitem").count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    expect(await bgSection().getByRole("list", { name: "Çalışıyor" }).textContent()).toMatch(/Derleme/);
    expect(await bgSection().getByRole("button", { name: "Bitti (1)" }).getAttribute("aria-expanded")).toBe("false");
    // Bağlan of the clicked session is offered (focused).
    await expect
      .poll(() => bgSection().getByRole("button", { name: "Bağlan: Testleri düzelt" }).evaluate((el) => el === document.activeElement), {
        timeout: UI_TIMEOUT_MS,
      })
      .toBe(true);
    await shot("01-gruplar");
  });

  it("2. Kayıtlar shows the session's recent output", async () => {
    await bgSection().getByRole("button", { name: "Kayıtlar: Derleme" }).click();
    const drawer = bgSection().getByRole("dialog", { name: "Kayıtlar: Derleme" });
    await expect.poll(() => drawer.locator("pre").textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/FAKE-LOG c9d0e1f2/);
    await shot("02-kayitlar");
    await drawer.getByRole("button", { name: "Kapat" }).click();
    expect(fake.calls()).toContainEqual(["logs", "c9d0e1f2"]);
  });

  it("3. Bağlan opens a new terminal tab running `claude attach <id>`", async () => {
    await bgSection().getByRole("button", { name: "Bağlan: Testleri düzelt" }).click();
    let attached: TerminalInfo | undefined;
    await expect
      .poll(
        async () => {
          const { terminals } = (await engineRequest(engine!.url, KEY, "terminals.list", { projectId: project.id })) as { terminals: TerminalInfo[] };
          attached = terminals.find((t) => t.command?.includes("attach a1b2c3d4"));
          return attached !== undefined;
        },
        { timeout: UI_TIMEOUT_MS },
      )
      .toBe(true);
    const panel = page.locator(`section.kp-term[data-terminal-id="${attached!.id}"]`);
    await expect.poll(() => xtermText(panel), { timeout: UI_TIMEOUT_MS }).toMatch(/FAKE-ATTACH a1b2c3d4/);
    expect(fake.calls()).toContainEqual(["attach", "a1b2c3d4"]);
    await shot("03-baglan");
  });

  it("4. Durdur asks first, then stops; the session moves to Bitti", async () => {
    await bgSection().getByRole("button", { name: "Durdur: Derleme" }).click();
    await bgSection().getByRole("button", { name: "Evet, durdur" }).click();
    await expect.poll(() => fake.calls().some((a) => a[0] === "stop" && a[1] === "c9d0e1f2"), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => bgSection().getByRole("button", { name: "Bitti (2)" }).count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await expect.poll(() => rail().getByLabel(`${PROJECT}: 0 çalışıyor, 2 seni bekliyor`).count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await shot("04-durdur");
  });
});
