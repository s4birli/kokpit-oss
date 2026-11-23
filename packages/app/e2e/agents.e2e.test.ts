// End-to-end for İş A (ajan özeti): the built Kokpit app (Electron) against a real engine whose PATH starts
// with a fake `claude` that prints Claude Code's permission prompt and waits. The real `claude` never runs.
// Steps run in order and share state.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, TerminalInfo } from "@kokpit/shared";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineRequest, launchApp, SCREENSHOT_DIR, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const DIMS = { cols: 100, rows: 30 };
const AGENT_PROJECT = "Ajan Projesi";
const WINDOW_MS = 800;

/** Claude Code's permission prompt (bold, cursor moves, ❯ marker), then a blocking read, work, silence. */
const FAKE_CLAUDE = `#!/bin/sh
printf '\\033[1mBash command\\033[0m\\r\\n  npm test\\r\\n\\033[1mDo\\033[1Cyou want to proceed?\\033[0m\\r\\n\\033[36m\\342\\235\\257 1. Yes\\033[39m\\r\\n  2. No, and tell Claude what to do differently (esc)\\r\\n'
read answer
i=0
while [ $i -lt 20 ]; do echo "working $i"; i=$((i+1)); sleep 0.1; done
echo "all done"
exec sleep 600
`;
const TICKER = "i=0; while [ $i -lt 100000 ]; do echo tick $i; i=$((i+1)); sleep 0.2; done";

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("agents", () => ({ app, page, engine }));
let builtin: Project;
let agentProject: Project;
let claudeTerminal: TerminalInfo;

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `agents-${name}.png`) });
}

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const waiting = (): Locator => rail().getByRole("region", { name: "Seni bekleyen" });
const agentsPanel = (): Locator => page.getByRole("main").getByRole("region", { name: "Ajanlar" });
const headerTitle = (): Promise<string | null> => page.locator(".kp-header__title").textContent();
const agentItem = (name: RegExp): Locator => agentsPanel().getByRole("listitem").filter({ hasText: name });

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-agents-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const projectDir = join(root, "ajan projesi");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(projectDir);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);

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
      activityWindowMs: WINDOW_MS,
      activityDebounceMs: 100,
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` });
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const { projects } = (await engineRequest(engine.url, KEY, "projects.list", {})) as { projects: Project[] };
  builtin = projects.find((p) => p.builtin)!;
  ({ project: agentProject } = (await engineRequest(engine.url, KEY, "projects.create", {
    name: AGENT_PROJECT,
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

describe("İş A UI end-to-end", () => {
  it("0. connects; nothing waits yet", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await expect.poll(() => rail().getByText(AGENT_PROJECT, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await waiting().count()).toBe(0);
  });

  it("1. Claude asking for permission shows under Seni bekleyen, with a counter on its project", async () => {
    ({ terminal: claudeTerminal } = (await engineRequest(engine!.url, KEY, "terminal.open", {
      projectId: agentProject.id,
      toolId: "claude",
      ...DIMS,
    })) as { terminal: TerminalInfo });
    // A busy terminal in another project.
    await engineRequest(engine!.url, KEY, "terminal.open", { projectId: builtin.id, command: TICKER, ...DIMS });

    await expect.poll(() => waiting().getByRole("button").count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    const item = waiting().getByRole("button").first();
    expect(await item.textContent()).toMatch(new RegExp(`Claude.*${AGENT_PROJECT}`));
    await expect
      .poll(() => rail().getByLabel(`${AGENT_PROJECT}: 0 çalışıyor, 1 seni bekliyor`).count(), { timeout: UI_TIMEOUT_MS })
      .toBe(1);
    await expect
      .poll(() => rail().getByLabel(`${builtin.name}: 1 çalışıyor, 0 seni bekliyor`).count(), { timeout: UI_TIMEOUT_MS })
      .toBe(1);
    await shot("01-seni-bekleyen");
  });

  it("2. clicking it opens the project; the Ajanlar panel says seni bekliyor and shows the prompt line", async () => {
    await waiting().getByRole("button").first().click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(AGENT_PROJECT);
    const item = agentItem(/Claude/);
    await expect.poll(() => item.textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/seni bekliyor/);
    expect(await item.textContent()).toMatch(/No, and tell Claude what to do differently/);
    const panel = page.locator(`section.kp-term[data-terminal-id="${claudeTerminal.id}"]`);
    await expect.poll(() => xtermText(panel), { timeout: UI_TIMEOUT_MS }).toMatch(/Do you want to proceed\?/);
    // The terminal got the focus: typing goes straight into it.
    await expect
      .poll(() => panel.evaluate((el) => el.contains(document.activeElement)), { timeout: UI_TIMEOUT_MS })
      .toBe(true);
    await shot("02-ajanlar-bekliyor");
  });

  it("3. answering in the terminal: running, then idle; Seni bekleyen empties", async () => {
    await page.keyboard.type("1");
    await page.keyboard.press("Enter");
    await expect.poll(() => agentItem(/Claude/).textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/çalışıyor/);
    expect(await waiting().count()).toBe(0);
    await shot("03-ajanlar-calisiyor");
    await expect.poll(() => agentItem(/Claude/).textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/boşta/);
    expect(await agentItem(/Claude/).textContent()).toMatch(/all done/);
    await shot("04-ajanlar-bosta");
  });

  it("4. the busy terminal of the other project is running in its Ajanlar panel", async () => {
    await rail().getByRole("button", { name: builtin.name, exact: true }).click();
    await expect.poll(headerTitle, { timeout: UI_TIMEOUT_MS }).toBe(builtin.name);
    const item = agentsPanel().getByRole("listitem").first();
    await expect.poll(() => item.textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/çalışıyor.*tick \d+/);
    await shot("05-ajanlar-calisan");
  });

  it("5. Ayarlar › Araçlar shows Claude's Bekleme kalıpları", async () => {
    await rail().getByRole("button", { name: "Ayarlar", exact: true }).click();
    await page.getByRole("tab", { name: "Araçlar" }).click();
    await page.getByRole("button", { name: "Düzenle: Claude", exact: true }).click();
    const field = page.locator("form.kp-settings__form").getByLabel("Bekleme kalıpları", { exact: true });
    await expect.poll(() => field.inputValue(), { timeout: UI_TIMEOUT_MS }).toMatch(/Do you want to/);
    await shot("06-bekleme-kaliplari");
  });
});
