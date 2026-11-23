// "Tarayıcıda yakınlaştırma Chrome'daki gibi" end-to-end: the built app against a real engine with a real
// (headless, test-only) Chrome and a local test page. Cmd+= / Cmd++ / Cmd+− / Cmd+0 / keypad + on the page view and a
// trackpad pinch (Chromium: ctrlKey wheel events) or Ctrl + mouse wheel change the project's engine-owned zoom; the
// page is re-laid out for panel ÷ zoom; none of those keys or wheels reach the page; a "%80 − + Sıfırla" bubble shows
// for a while; a click on the picture still lands exactly.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultUiConfig } from "../src/renderer/ui/config.ts";
import { ENGINE_DIR, engineRequest, launchApp, SCREENSHOT_DIR, sleep, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { diagnoseFailures } from "./diagnostics.ts";

const KEY = randomBytes(32).toString("hex");
const UI_TIMEOUT_MS = 30_000;
const engineDefaults = JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as { browser: { projectName: string } };
const FIRST = engineDefaults.browser.projectName;
/** The click target of the test page: [left, top, width, height] in page CSS px — small, so a miss shows. */
const TARGET = [220, 130, 60, 30] as const;
/** Slack for whole-pixel rounding (CSS px). */
const PX = 1.5;

const cfg = defaultUiConfig;
const ZOOM = cfg.browserZoom;
const zoomStep = (from: number, n: number): number => {
  const levels = cfg.browserZoomLevels;
  return levels[Math.min(levels.length - 1, Math.max(0, levels.indexOf(from) + n))]!;
};
const percent = (z: number): string => `%${Math.round(z * 100)}`;

let root: string;
let engine: EngineHandle | undefined;
let app: ElectronApplication | undefined;
let page: Page;
let server: http.Server;
let port: number;
let firstId: string;

diagnoseFailures("browser-zoom-gestures", () => ({ app, page, engine }));

const rail = (): Locator => page.getByRole("navigation", { name: "Kokpit" });
const browser = (): Locator => page.locator("section.kp-browser");
const canvas = (): Locator => browser().locator("canvas");
const bubble = (): Locator => browser().getByRole("group", { name: "Yakınlaştırma" });
const frames = async (): Promise<number> => Number((await canvas().getAttribute("data-frames")) ?? "0");
const shownZoom = async (): Promise<number> => Number(await browser().locator(".kp-browser__view").getAttribute("data-zoom"));

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `browser-zoom-gestures-${name}.png`) });
}

interface PageInfo {
  width: number;
  height: number;
  clicks: number;
  /** wheel events the page got */
  wheels: number;
  /** keydown + keyup events of non-modifier keys the page got (the modifiers alone reach a page in Chrome too) */
  keys: number;
}
/** The project's zoom in the engine and what the page reports in its title. */
async function engineState(): Promise<{ zoom: number; page: PageInfo | null }> {
  const { browser: s } = (await engineRequest(engine!.url, KEY, "browser.tabs", { projectId: firstId })) as {
    browser: { zoom: number; activeTabId?: string; tabs: { id: string; title: string }[] };
  };
  const m = /^(\d+)x(\d+) c(\d+) w(\d+) k(\d+)$/.exec(s.tabs.find((t) => t.id === s.activeTabId)?.title ?? "");
  return {
    zoom: s.zoom,
    page: m ? { width: Number(m[1]), height: Number(m[2]), clicks: Number(m[3]), wheels: Number(m[4]), keys: Number(m[5]) } : null,
  };
}
const pageInfo = async (): Promise<PageInfo> => (await engineState()).page!;

/** The picture area and the canvas (CSS px). */
const measure = () =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".kp-browser__canvas")!;
    const v = c.parentElement!.getBoundingClientRect();
    const r = c.getBoundingClientRect();
    // The page size the drawn picture shows: a click is mapped against it.
    const [fw, fh] = (c.getAttribute("data-frame-size") ?? "0x0").split("x").map(Number);
    return { view: { width: v.width, height: v.height }, canvas: { x: r.x, y: r.y, width: r.width, height: r.height }, frame: { width: fw!, height: fh! } };
  });

/** [] when the engine, the panel and the page all agree on `zoom` and the page is laid out for the panel ÷ zoom. */
async function zoomProblems(zoom: number): Promise<string[]> {
  const { zoom: engineZoom, page: p } = await engineState();
  const shown = await shownZoom();
  const { view, frame } = await measure();
  const out: string[] = [];
  if (engineZoom !== zoom) out.push(`engine zoom ${engineZoom}`);
  if (shown !== zoom) out.push(`panel shows ${shown}`);
  if (!p) out.push("the page reports nothing");
  else if (Math.abs(p.width - view.width / zoom) > PX || Math.abs(p.height - view.height / zoom) > PX)
    out.push(`page ${p.width}x${p.height}, area ${Math.round(view.width)}x${Math.round(view.height)}`);
  // …and the picture on screen already shows the page at that size. The page re-lays out (and its title says so)
  // a moment before its new frame is drawn; a click in between is mapped against the old picture (measured: after
  // ⌘− then ⌘0, the click went to 334,194 of a 1334 px wide frame while the page was already 996 px wide).
  else if (Math.abs(frame.width - p.width) > PX || Math.abs(frame.height - p.height) > PX) out.push(`picture shows ${frame.width}x${frame.height}, page ${p.width}x${p.height}`);
  return out;
}
async function expectZoom(zoom: number, label: string): Promise<void> {
  await expect.poll(() => zoomProblems(zoom), { timeout: UI_TIMEOUT_MS, message: label }).toEqual([]);
}

/** Clicks the page's target through the picture: page px → canvas px, as a user aiming at it would. */
async function clickTarget(): Promise<void> {
  const { canvas: c } = await measure();
  const p = await pageInfo();
  const x = c.x + ((TARGET[0] + TARGET[2] / 2) * c.width) / p.width;
  const y = c.y + ((TARGET[1] + TARGET[3] / 2) * c.height) / p.height;
  await page.mouse.click(x, y);
  await expect.poll(async () => (await pageInfo()).clicks, { timeout: UI_TIMEOUT_MS, message: `click at ${Math.round(x)},${Math.round(y)}` }).toBe(p.clicks + 1);
}

/**
 * A trackpad pinch as Chromium delivers it to a page: a burst of small `wheel` events with ctrlKey (deltaY < 0 =
 * fingers apart), each a few ms apart, over the picture.
 */
async function pinchOnPicture(totalDeltaY: number, frames: number): Promise<void> {
  await page.evaluate(
    async ({ total, n }) => {
      const c = document.querySelector<HTMLCanvasElement>(".kp-browser__canvas")!;
      const r = c.getBoundingClientRect();
      for (let i = 0; i < n; i++) {
        c.dispatchEvent(
          new WheelEvent("wheel", { deltaY: total / n, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }),
        );
        await new Promise((res) => setTimeout(res, 8));
      }
    },
    { total: totalDeltaY, n: frames },
  );
}

function processes(needle: string): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(needle) && !l.includes("ps -ax"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-app-e2e-zoomgest-")));
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // The title carries the layout viewport (live), the clicks on the target and every wheel / key the page got.
    res.end(`<!doctype html><meta charset="utf-8"><title>…</title>
<body style="margin:0;height:100vh;box-sizing:border-box;border:6px solid #c00;background:linear-gradient(135deg,#fde68a,#86efac);font:32px sans-serif">
<h1 style="margin:16px">Kokpit yakınlaştırma</h1>
<button id="t" style="position:absolute;left:${TARGET[0]}px;top:${TARGET[1]}px;width:${TARGET[2]}px;height:${TARGET[3]}px;border:0;padding:0;background:#1d4ed8"></button>
<script>let c=0,w=0,k=0;const t=()=>{document.title=innerWidth+"x"+innerHeight+" c"+c+" w"+w+" k"+k};t();addEventListener("resize",t);
const mod=new Set(["Meta","Shift","Control","Alt"]);const key=(e)=>{if(!mod.has(e.key)){k++;t()}};
addEventListener("wheel",()=>{w++;t()},{passive:true});addEventListener("keydown",key);addEventListener("keyup",key);
document.getElementById("t").addEventListener("click",()=>{c++;t()});</script></body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;

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
  engine = await startEngine(configPath, KEY);
  await engineRequest(engine.url, KEY, "settings.update", { defaultToolId: null });
  const { projects } = (await engineRequest(engine.url, KEY, "projects.list", {})) as { projects: { id: string; name: string }[] };
  firstId = projects.find((p) => p.name === FIRST)!.id;
  const userDataDir = join(root, "user-data");
  mkdirSync(userDataDir, { recursive: true });
  app = await launchApp({ KOKPIT_USER_DATA_DIR: userDataDir });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await stopEngine(engine);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (root) {
    for (const pid of processes(root)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Tarayıcıda yakınlaştırma Chrome'daki gibi", () => {
  it("0. open the browser on the test page: default zoom, no bubble", async () => {
    await page.getByLabel("Motor adresi").fill(engine!.url);
    await page.getByLabel("Anahtar").fill(KEY);
    await page.getByRole("button", { name: "Bağlan" }).click();
    await expect.poll(() => rail().getByRole("button", { name: FIRST, exact: true }).isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    await rail().getByRole("button", { name: FIRST, exact: true }).click();
    await browser().getByRole("button", { name: "Tarayıcıyı aç" }).click();
    await expect.poll(frames, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    const address = browser().getByLabel("Adres");
    await address.fill(`http://127.0.0.1:${port}/`);
    await address.press("Enter");
    await expect.poll(async () => (await engineState()).page !== null, { timeout: UI_TIMEOUT_MS }).toBe(true);
    await expectZoom(ZOOM, "default");
    expect(await bubble().count()).toBe(0);
  });

  it("1. Cmd+= / Cmd++ / Cmd+− / Cmd+0 / Cmd+keypad+ on the page view zoom (engine, page width, bubble); no key reaches the page", async () => {
    await canvas().focus();
    const keysBefore = (await pageInfo()).keys;
    await page.keyboard.press("Meta+Equal");
    await expectZoom(zoomStep(ZOOM, 1), "Cmd+=");
    await expect.poll(() => bubble().textContent(), { timeout: UI_TIMEOUT_MS }).toContain(percent(zoomStep(ZOOM, 1)));
    await shot("01-cmd-equal-bubble");
    // Cmd++ (Shift+= on a US keyboard)
    await page.keyboard.press("Meta+Shift+Equal");
    await expectZoom(zoomStep(ZOOM, 2), "Cmd++");
    await page.keyboard.press("Meta+Minus");
    await expectZoom(zoomStep(ZOOM, 1), "Cmd+−");
    await page.keyboard.press("Meta+0");
    await expectZoom(ZOOM, "Cmd+0");
    await page.keyboard.press("Meta+NumpadAdd");
    await expectZoom(zoomStep(ZOOM, 1), "Cmd+keypad +");
    await page.keyboard.press("Meta+0");
    await expectZoom(ZOOM, "Cmd+0 again");
    await sleep(300);
    expect((await pageInfo()).keys).toBe(keysBefore);
  });

  it("2. the bubble hides by itself after the configured time", async () => {
    await expect.poll(() => bubble().count(), { timeout: cfg.browserZoomBubbleMs + UI_TIMEOUT_MS }).toBe(0);
  });

  it("3. a pinch (ctrlKey wheel burst) zooms in steps; no wheel reaches the page; the bubble shows the new %", async () => {
    const wheelsBefore = (await pageInfo()).wheels;
    const keysBefore = (await pageInfo()).keys;
    // fingers apart by a little over two steps, in 24 small frames
    await pinchOnPicture(-2.5 * cfg.browserPinchStepDelta, 24);
    await expectZoom(zoomStep(ZOOM, 2), "after a pinch out");
    await expect.poll(() => bubble().textContent(), { timeout: UI_TIMEOUT_MS }).toContain(percent(zoomStep(ZOOM, 2)));
    await shot("03-pinch-bubble");
    // fingers together by one step
    await pinchOnPicture(1.2 * cfg.browserPinchStepDelta, 10);
    await expectZoom(zoomStep(ZOOM, 1), "after a pinch in");
    await sleep(300);
    const after = await pageInfo();
    expect(after.wheels).toBe(wheelsBefore);
    expect(after.keys).toBe(keysBefore);
  });

  it("4. a click after the pinch lands exactly on a small target", async () => {
    await clickTarget();
  });

  it("5. Ctrl + a real mouse wheel notch is one step; an ordinary wheel still goes to the page", async () => {
    const { canvas: c } = await measure();
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    const before = await pageInfo();
    // What the app's window gets: one notch should be one wheel event.
    await page.evaluate(() => {
      const w = window as unknown as { seenWheels: string[] };
      w.seenWheels = [];
      addEventListener("wheel", (e) => w.seenWheels.push(`${e.ctrlKey ? "ctrl " : ""}${e.deltaY}/${e.deltaMode}`), { capture: true, passive: true });
    });
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 100);
    await page.keyboard.up("Control");
    const seen = await page.evaluate(() => (window as unknown as { seenWheels: string[] }).seenWheels);
    await expectZoom(ZOOM, `Ctrl + wheel down (wheel events: ${seen.join(", ")})`);
    await sleep(300);
    expect((await pageInfo()).wheels).toBe(before.wheels);
    await page.mouse.wheel(0, 100);
    await expect.poll(async () => (await pageInfo()).wheels, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(before.wheels);
    await clickTarget();
  });

  it("6. the bubble's buttons zoom; Sıfırla goes back to the default", async () => {
    await canvas().focus();
    await page.keyboard.press("Meta+Equal");
    await expect.poll(() => bubble().count(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    const z = await shownZoom();
    await bubble().getByRole("button", { name: "Yakınlaştır" }).click();
    await expectZoom(zoomStep(z, 1), "bubble +");
    await bubble().getByRole("button", { name: "Uzaklaştır" }).click();
    await expectZoom(z, "bubble −");
    await bubble().getByRole("button", { name: "Sıfırla" }).click();
    await expectZoom(ZOOM, "bubble Sıfırla");
    // the page view kept the focus: the keys still zoom
    await page.keyboard.press("Meta+Minus");
    await expectZoom(zoomStep(ZOOM, -1), "Cmd+− after the bubble");
    await page.keyboard.press("Meta+0");
    await expectZoom(ZOOM, "back to default");
    await clickTarget();
  });
});
