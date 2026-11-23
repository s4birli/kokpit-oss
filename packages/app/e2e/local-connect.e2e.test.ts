// Yerel bağlantı end-to-end: the app runs on the engine's own Mac. A temp HOME holds a fake
// ~/.config/kokpit/engine.json pointing at the test engine's dataDir and port, and <dataDir>/engine.key holds the
// key; the connect screen offers "Bu Mac'teki motora bağlan" and one click opens the workbench.
// Never the real config, key or engine: HOME, XDG_CONFIG_HOME and every KOKPIT_* lookup var point at temp paths.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchApp, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const PROJECT_NAME = "Yerel Proje";
const UI_TIMEOUT_MS = 20_000;
const LOCAL_BUTTON = "Bu Mac'teki motora bağlan";

let root: string;
let home: string;
let dataDir: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("local-connect", () => ({ app, page, engine }));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-local-")));
  home = join(root, "home");
  dataDir = join(root, "data");
  userDataDir = join(root, "user-data");
  const repo = join(root, "repo");
  for (const d of [home, dataDir, repo, join(home, ".config", "kokpit")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dataDir, "engine.key"), KEY + "\n", { mode: 0o600 });
  const configPath = join(home, ".config", "kokpit", "engine.json");
  const port = await freePort();
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      port,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      projects: [{ name: PROJECT_NAME, repoPath: repo, id: "yerel" }],
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: home });
  expect(engine.port).toBe(port);
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Bu Mac'teki motora bağlan", () => {
  it("detects the engine on this Mac and connects with one click", async () => {
    app = await launchApp({
      KOKPIT_USER_DATA_DIR: userDataDir,
      KOKPIT_LOCAL_ENGINE_DETECT: "1",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      KOKPIT_CONFIG: "",
      KOKPIT_KEY: "",
      KOKPIT_PORT: "",
      KOKPIT_DATA_DIR: "",
    });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const button = page.getByRole("button", { name: LOCAL_BUTTON, exact: true });
    await expect.poll(() => button.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await page.getByText(`127.0.0.1:${engine!.port}`, { exact: true }).isVisible()).toBe(true);
    // The manual form is still there.
    expect(await page.getByLabel("Motor adresi").isVisible()).toBe(true);
    // The key never reaches the page for detection.
    expect(await page.content()).not.toContain(KEY);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "local-connect-01-button.png") });

    await button.click();
    const rail = page.getByRole("navigation", { name: "Kokpit" });
    await expect.poll(() => rail.getByText(PROJECT_NAME, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "local-connect-02-connected.png") });

    // Saved by main: url in clear, key encrypted (never in the file as plain text).
    const saved = readFileSync(join(userDataDir, "engine-settings.json"), "utf8");
    expect(JSON.parse(saved).url).toBe(`ws://127.0.0.1:${engine!.port}`);
    expect(saved).not.toContain(KEY);
  });

  it("stays connected after a restart (settings were saved)", async () => {
    await app!.close();
    app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir, HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
    page = await app.firstWindow();
    const rail = page.getByRole("navigation", { name: "Kokpit" });
    await expect.poll(() => rail.getByText(PROJECT_NAME, { exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
  });
});
