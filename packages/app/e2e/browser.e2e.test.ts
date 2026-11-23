// İş B end-to-end: the built app against a real engine that starts a real (headless, test-only) Chrome.
// Engine mode: the Tarayıcı panel shows the screencast, the address bar navigates, clicks and keys reach the
// page. Client mode: the app starts a local Chrome with its own profile under the app's userData.
// Every Chrome started here lives under a temp dir and is killed at the end.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@kokpit/shared";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_DIR, engineRequest, launchApp, SCREENSHOT_DIR, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
const PAGE_TITLE = "Kokpit Test Sayfası";
const CLICKED_TITLE = "tıklandı";
const CLIENT_PROJECT = "Yerel Tarayıcı";
const engineDefaults = JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as {
  browser: { projectName: string; profilesDirName: string };
};
const appBrowserDefaults = JSON.parse(readFileSync(new URL("../src/main/browser.defaults.json", import.meta.url), "utf8")) as {
  profilesDirName: string;
};

// A full-window button: a click anywhere on the screencast hits it. Keys go to the title. Both change ONLY
// document.title (no navigation, no hash): the tab list must still update (the engine watches the title).
const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head>
<body style="margin:0"><button id="b" style="position:fixed;inset:0;width:100%;height:100%;font-size:48px;background:#fde68a"
onclick="document.title='${CLICKED_TITLE}';this.style.background='#86efac';this.textContent='Tıklandı'">Tıkla</button>
<script>document.addEventListener('keydown',function(e){if(e.key.length===1){document.title='tuş:'+e.key;}});</script></body></html>`;
/** How much of the canvas must be on screen without scrolling. */
const VISIBLE_CANVAS_MIN_PX = 300;
const EXT_FIXTURE = join(ENGINE_DIR, "test", "fixtures", "ext-marker");
const EXT_NAME = "Kokpit test marker";

let root: string;
let userDataDir: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("browser", () => ({ app, page, engine }));
let server: http.Server;
let pageUrl: string;

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const panel = (): Locator => page.locator("section.kp-browser");
const frames = async (): Promise<number> => Number((await panel().locator("canvas").getAttribute("data-frames")) ?? "0");
const tabTitles = async (): Promise<string[]> => panel().getByRole("group", { name: "Sekmeler" }).getByRole("button").allTextContents();

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `browser-${name}.png`) });
}

async function selectProject(name: string): Promise<void> {
  await rail().getByRole("button", { name, exact: true }).click();
  await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(name);
}

/** PIDs of processes whose command line contains `needle` (our temp root keeps this to our Chromes). */
function pidsWith(needle: string): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

function killAll(needle: string): void {
  for (const pid of pidsWith(needle)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-browser-")));
  userDataDir = join(root, "user-data");
  mkdirSync(join(root, "yerel"));

  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(TEST_PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  pageUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

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
      // Test-only: no window and no keychain dialog on the desktop (headless + mock keychain).
      browser: { headless: true, testMode: true },
    }),
  );
  // No temp HOME: Chrome would then look for a login keychain that does not exist and show a dialog.
  engine = await startEngine(configPath, KEY);
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });

  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir, KOKPIT_CHROME_HEADLESS: "1" });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (root) {
    killAll(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("İş B: Tarayıcı paneli", () => {
  it("0. connects; the built-in browser project is in the rail", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await expect
      .poll(() => rail().getByRole("button", { name: engineDefaults.browser.projectName, exact: true }).isVisible(), {
        timeout: UI_TIMEOUT_MS,
      })
      .toBe(true);
  });

  it("1. 'Tarayıcıyı aç' starts the engine's Chrome and frames are drawn", async () => {
    await selectProject(engineDefaults.browser.projectName);
    await panel().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    // At the default 1440x900 window the view starts on screen, without scrolling.
    const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    const box = await panel().locator("canvas").boundingBox();
    expect(box).not.toBeNull();
    // A useful part of the page (not just its top edge) is visible.
    const visible = Math.min(box!.height, VISIBLE_CANVAS_MIN_PX);
    expect(box!.y + visible, `canvas top ${box!.y} + ${visible}px within ${viewport.height}px`).toBeLessThanOrEqual(viewport.height);
    await shot("01-open");
  });

  it("2. typing a URL navigates; the tab list shows the page title and new frames arrive", async () => {
    const before = await frames();
    const address = panel().getByLabel("Adres");
    await address.fill(pageUrl.replace("http://", ""));
    await address.press("Enter");
    await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).toContain(PAGE_TITLE);
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before);
    await shot("02-navigated");
  });

  it("3. a click on the canvas reaches the page", async () => {
    await panel().locator("canvas").click();
    await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).toContain(CLICKED_TITLE);
    await shot("03-clicked");
  });

  it("4. keys typed on the focused canvas reach the page", async () => {
    await page.keyboard.press("k");
    await expect.poll(tabTitles, { timeout: UI_TIMEOUT_MS }).toContain("tuş:k");
  });

  it("4b. Uzantılar: a developer extension from the engine's disk loads; 'Mac mini ekranında göster' sets the project's window", async () => {
    await panel().getByRole("button", { name: "Uzantılar" }).click();
    const menu = panel().getByRole("region", { name: "Uzantılar" });
    await menu.getByLabel(/Uzantı klasörü/).fill(EXT_FIXTURE);
    await menu.getByRole("button", { name: "Geliştirici uzantısı yükle" }).click();
    await expect.poll(() => menu.getByRole("listitem").allTextContents(), { timeout: UI_TIMEOUT_MS }).toEqual([expect.stringMatching(new RegExp(`${EXT_NAME}.*yüklü`))]);
    expect(await menu.getByText(/Web Mağazası/).isVisible()).toBe(true);
    await shot("04b-extensions");
    // Gizli tarayıcı: "Mac mini ekranında göster" is the project's window setting, one click, hidden by default.
    const show = menu.getByRole("checkbox", { name: "Mac mini ekranında göster" });
    expect(await show.isChecked()).toBe(false);
    expect(await show.locator("xpath=..").getAttribute("title")).toMatch(/eşitleme onayı/);
    expect(await menu.getByRole("button", { name: "Öne getir" }).count()).toBe(0);
    const windowOf = async () => {
      const { projects } = (await engineRequest(engine!.url, KEY, "projects.list", {})) as { projects: Project[] };
      return projects.find((p) => p.name === engineDefaults.browser.projectName)?.browser?.window ?? "hidden";
    };
    await show.click();
    await expect.poll(windowOf, { timeout: UI_TIMEOUT_MS }).toBe("visible");
    await expect.poll(() => show.isChecked(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    // Headless test Chrome (test config): it stays without a window, and "Öne getir" says so.
    await menu.getByRole("button", { name: "Öne getir" }).click();
    await expect.poll(() => menu.getByRole("alert").textContent(), { timeout: UI_TIMEOUT_MS }).toMatch(/gizli/);
    await show.click();
    await expect.poll(windowOf, { timeout: UI_TIMEOUT_MS }).toBe("hidden");
    // The panel keeps showing the page throughout.
    const before = await frames();
    await panel().getByRole("button", { name: "Yenile" }).click();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before);
    await menu.getByRole("button", { name: `Kaldır: ${EXT_NAME}` }).click();
    await expect.poll(() => menu.getByText(/Henüz geliştirici uzantısı yok/).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await panel().getByRole("button", { name: "Uzantılar" }).click();
  });

  it("5. 'Tarayıcıyı kapat' stops it", async () => {
    await panel().getByRole("button", { name: "Tarayıcıyı kapat" }).click();
    await expect.poll(() => panel().getByRole("button", { name: "Tarayıcıyı aç" }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    const profileDir = join(root, "data", engineDefaults.browser.profilesDirName);
    await expect.poll(() => pidsWith(profileDir).length, { timeout: UI_TIMEOUT_MS }).toBe(0);
  });

  it("6. client mode opens a local Chrome with the app's own profile for the project", async () => {
    const { project } = (await engineRequest(engine!.url, KEY, "projects.create", {
      name: CLIENT_PROJECT,
      location: { kind: "local", path: join(root, "yerel") },
      browser: { runOn: "client" },
    })) as { project: Project };
    await expect.poll(() => rail().getByRole("button", { name: CLIENT_PROJECT, exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await selectProject(CLIENT_PROJECT);
    expect(await panel().getByText(/ajan bu tarayıcıyı süremez/).isVisible()).toBe(true);
    await shot("04-client-mode");
    await panel().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    const profileArg = `--user-data-dir=${join(userDataDir, appBrowserDefaults.profilesDirName, project.id)}`;
    await expect.poll(() => pidsWith(profileArg).length, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    killAll(profileArg);
    await expect.poll(() => pidsWith(profileArg).length, { timeout: UI_TIMEOUT_MS }).toBe(0);
  });
});
