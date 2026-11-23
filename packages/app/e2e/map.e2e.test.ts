// İş C — Harita end-to-end: the built app (Electron, Playwright `_electron`) against a real engine.
// A temp project holds a fake graphify-out whose newest graph.html carries a marker and probes its own
// isolation from inside the sandboxed frame. The update command is an `echo` (never the real claude).
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@kokpit/shared";
import type { ElectronApplication, Frame, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickMenu, engineRequest, launchApp, menuItem, SCREENSHOT_DIR, startEngine, stopEngine, xtermText, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 20_000;
const MAP_PROJECT = "Haritalı";
const EMPTY_PROJECT = "Haritasız";
const SSH_PROJECT = "Uzak Harita";
const NEW_MARKER = "KOKPIT-HARITA-E2E-YENI";
const OLD_MARKER = "KOKPIT-HARITA-E2E-ESKI";
const UPDATE_COMMAND = "echo MAP_UPDATE_$((6*7))";
const UPDATE_OUTPUT = /MAP_UPDATE_42/;
/** What the page inside the sandbox can see of the app: nothing. */
const ISOLATED = "self:undefined parent:blocked top:blocked storage:blocked origin:null";

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>graph</title></head><body>
<h1 id="marker">${NEW_MARKER}</h1>
<p id="probe">bekleniyor</p>
<script>
  var r = [];
  r.push("self:" + typeof window.kokpit);
  try { r.push("parent:" + typeof window.parent.kokpit); } catch (e) { r.push("parent:blocked"); }
  try { r.push("top:" + typeof window.top.document.body); } catch (e) { r.push("top:blocked"); }
  try { localStorage.setItem("x", "1"); r.push("storage:ok"); } catch (e) { r.push("storage:blocked"); }
  r.push("origin:" + window.origin);
  document.getElementById("probe").textContent = r.join(" ");
</script>
</body></html>`;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;

diagnoseFailures("map", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const mapPanel = (): Locator => page.getByRole("region", { name: "Harita", exact: true });
const mapFrame = () => page.frameLocator("iframe.kp-map__frame");

/** İş D: layouts are per project — a panel opened in one project is not open in the next; open it here too. */
async function openPanelHere(name: string): Promise<void> {
  await expect.poll(() => menuItem(app!, ["Görünüm", name]), { timeout: UI_TIMEOUT_MS }).toEqual({ checked: false, enabled: true });
  await clickMenu(app!, ["Görünüm", name]);
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `harita-${name}.png`) });
}

async function selectProject(name: string): Promise<void> {
  await rail().getByRole("button", { name, exact: true }).click();
  await expect.poll(() => page.locator(".kp-header__title").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(name);
}

function mapFrameHandle(): Frame | undefined {
  return page.frames().find((f) => f !== page.mainFrame() && f.url().includes("/map/"));
}

function writeAt(path: string, content: string, mtimeSec: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeSec, mtimeSec);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-map-")));
  const mapDir = join(root, "haritali");
  const emptyDir = join(root, "haritasiz");
  mkdirSync(join(root, "home"));
  mkdirSync(emptyDir);
  writeAt(join(mapDir, "graphify-out", "graph.html"), `<p>${OLD_MARKER}</p>`, 1_700_000_000);
  writeAt(join(mapDir, "graphify-out", "2026-11-12", "graph.html"), PROBE_HTML, 1_800_000_000);

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
      map: { updateCommand: UPDATE_COMMAND },
    }),
  );
  engine = await startEngine(configPath, KEY, { HOME: join(root, "home") });
  // Never start the seeded global default tool (claude).
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  await engineRequest(engine.url, KEY, "projects.create", { name: MAP_PROJECT, location: { kind: "local", path: mapDir } });
  await engineRequest(engine.url, KEY, "projects.create", { name: EMPTY_PROJECT, location: { kind: "local", path: emptyDir } });
  const { host } = (await engineRequest(engine.url, KEY, "sshHosts.create", { name: "Kutu", hostname: "kutu.example" })) as {
    host: { id: string };
  };
  const { project } = (await engineRequest(engine.url, KEY, "projects.create", {
    name: SSH_PROJECT,
    location: { kind: "ssh", hostId: host.id, path: mapDir },
  })) as { project: Project };
  expect(project.location.kind).toBe("ssh");

  app = await launchApp({ KOKPIT_USER_DATA_DIR: join(root, "user-data") });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel("Motor adresi").fill(engine.url);
  await page.getByLabel("Anahtar").fill(KEY);
  await page.getByRole("button", { name: "Bağlan" }).click();
  await rail().getByText(MAP_PROJECT, { exact: true }).waitFor({ timeout: UI_TIMEOUT_MS });
});

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Harita UI end-to-end", () => {
  it("1. shows the newest map inside the Harita panel", async () => {
    await selectProject(MAP_PROJECT);
    // İş L: Harita is closed in the default layout; Görünüm opens it.
    await clickMenu(app!, ["Görünüm", "Harita"]);
    await expect.poll(() => mapPanel().isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expect.poll(() => mapFrame().getByText(NEW_MARKER).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await mapFrame().getByText(OLD_MARKER).count()).toBe(0);
    expect(await page.locator("iframe.kp-map__frame").getAttribute("sandbox")).toBe("allow-scripts");
    await shot("01-panel");
  });

  it("2. the sandboxed map cannot reach window.kokpit, the app page or storage", async () => {
    // The bridge does exist in the app's own page.
    expect(await page.evaluate(() => typeof (window as unknown as { kokpit?: unknown }).kokpit)).toBe("object");
    await expect.poll(() => mapFrame().locator("#probe").textContent(), { timeout: UI_TIMEOUT_MS }).toBe(ISOLATED);
    const frame = mapFrameHandle();
    expect(frame).toBeTruthy();
    expect(await frame!.evaluate(() => typeof (window as unknown as { kokpit?: unknown }).kokpit)).toBe("undefined");
  });

  it("3. the map frame cannot navigate away from its map page", async () => {
    const frame = mapFrameHandle()!;
    const before = frame.url();
    const health = before.replace(/\/map\/.*$/, "/health");
    await frame.evaluate((url) => {
      window.location.href = url;
    }, health);
    await page.waitForTimeout(1000);
    expect(mapFrameHandle()?.url()).toBe(before);
    expect(await mapFrame().getByText(NEW_MARKER).isVisible()).toBe(true);
  });

  it("4. Tam ekran fills the window and toggles back", async () => {
    await mapPanel().getByRole("button", { name: "Tam ekran" }).click();
    const box = await mapPanel().boundingBox();
    const size = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
    expect(box?.width).toBeGreaterThanOrEqual(size.width - 1);
    expect(box?.height).toBeGreaterThanOrEqual(size.height - 1);
    await expect.poll(() => mapFrame().getByText(NEW_MARKER).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await shot("02-tam-ekran");
    await mapPanel().getByRole("button", { name: "Tam ekrandan çık" }).click();
    await expect.poll(() => mapPanel().getByRole("button", { name: "Tam ekran" }).isVisible()).toBe(true);
  });

  it("5. a project without a map explains it; Haritayı güncelle opens a terminal with the configured command", async () => {
    await selectProject(EMPTY_PROJECT);
    await openPanelHere("Harita");
    await expect.poll(() => mapPanel().getByText(/henüz harita yok/).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await page.locator("iframe.kp-map__frame").count()).toBe(0);
    await shot("03-harita-yok");
    await mapPanel().getByRole("button", { name: "Haritayı güncelle" }).click();
    const terminal = page.locator("section.kp-term").last();
    await expect.poll(() => xtermText(terminal), { timeout: UI_TIMEOUT_MS, interval: 100 }).toMatch(UPDATE_OUTPUT);
    await shot("04-guncelle-terminali");
  });

  it("6. ssh projects have no Harita panel", async () => {
    await selectProject(SSH_PROJECT);
    await page.waitForTimeout(500);
    expect(await mapPanel().count()).toBe(0);
  });
});
