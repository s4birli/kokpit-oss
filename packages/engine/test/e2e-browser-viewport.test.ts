// "Tarayıcı her zaman panele sığsın" end-to-end against the real engine and a REAL headless Chrome (temp profile,
// mock keychain):
// - browser.viewport.set makes the page's layout viewport the app panel's size ÷ zoom, and a frame has exactly the
//   panel's aspect (nothing to crop, nothing to scroll);
// - the size does not depend on Chrome's own window (resized behind Kokpit's back), survives tab switches and a
//   screencast restart, and is what a second CDP client (an agent) sees;
// - zoom steps fired without waiting end on the last one (they used to race: page at 90 %, state at 100 %);
// - a click mapped from the image hits its target at the scaled size.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFrameMessage, BrowserState } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectCdp, type CdpConnection } from "../src/cdp.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 20_000;
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; profilesDirName: string; windowWidth: number; windowHeight: number };
};
const CHROME = defaults.browser.chromePath;
const haveChrome = existsSync(CHROME);
/** The app's panel in these tests (CSS px), on a screen with DPR device px per CSS px (a Retina MacBook). */
const PANEL = { width: 800, height: 500 };
const DPR = 2;
/** Target [left, top, width, height] in page CSS px. */
const TARGET = [300, 200, 120, 60] as const;

let root: string;
let dataDir: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = () => join(dataDir, defaults.browser.profilesDirName, projectId);

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string, timeoutMs = WAIT_MS): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    await sleep(100);
  }
}

function ourChromePids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function devtoolsPort(): number {
  const out = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.includes(`--user-data-dir=${profile()}`) && !l.includes("--type="));
  return Number(/--remote-debugging-port=(\d+)/.exec(line ?? "")?.[1]);
}

const frames = () => c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame" && f.projectId === projectId);
const lastFrameId = () => frames().at(-1)?.frameId ?? 0;

async function nextFrame(afterId: number, pred: (f: BrowserFrameMessage) => boolean = () => true): Promise<BrowserFrameMessage> {
  return until(
    () => {
      const last = frames().at(-1);
      if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
      return frames().find((f) => f.frameId > afterId && pred(f));
    },
    (f) => f !== undefined,
    `frame after ${afterId}`,
  ) as Promise<BrowserFrameMessage>;
}

const tabs = async () => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;
const activeTitle = async () => {
  const s = await tabs();
  return s.tabs.find((t) => t.id === s.activeTabId)?.title ?? "";
};
const input = (event: Record<string, unknown>) => c.ws.send(JSON.stringify({ type: "browser.input", projectId, event }));

/** A second CDP client (like an agent's Playwright): runs `fn` with a session on the active tab. */
async function withAgent<T>(fn: (cdp: CdpConnection, sessionId: string, targetId: string) => Promise<T>): Promise<T> {
  const version = (await (await fetch(`http://127.0.0.1:${devtoolsPort()}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const cdp = await connectCdp(version.webSocketDebuggerUrl, { timeoutMs: 15_000 });
  try {
    const { activeTabId } = await tabs();
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: activeTabId, flatten: true });
    return await fn(cdp, sessionId, activeTabId!);
  } finally {
    cdp.close();
  }
}

/** What the agent sees in the active tab. */
function pageEval<T>(expression: string): Promise<T> {
  return withAgent(async (cdp, sessionId) => {
    const r = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  });
}
const pageSize = () => pageEval<string>("innerWidth + 'x' + innerHeight");
const waitPageSize = (want: string) => until(pageSize, (s) => s === want, `page viewport ${want}`);

/** Pixel size of a JPEG frame, and the centroid (image px) of the red target. */
function decode(frame: BrowserFrameMessage): Promise<{ width: number; height: number; red: { x: number; y: number } | null }> {
  return pageEval(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(frame.data)}), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < bmp.height; y++) for (let x = 0; x < bmp.width; x++) {
      const i = (y * bmp.width + x) * 4;
      if (px[i] > 190 && px[i + 1] < 70 && px[i + 2] < 70) { sx += x; sy += y; n++; }
    }
    return { width: bmp.width, height: bmp.height, red: n > 20 ? { x: sx / n, y: sy / n } : null };
  })()`);
}

let clicks = 0;
/** Finds the red target in a fresh frame, maps it like the app's toPagePoint and clicks it. */
async function clickTarget(): Promise<void> {
  const before = lastFrameId();
  await startCast();
  const frame = await nextFrame(before, (x) => x.metadata.deviceWidth === 1000);
  const img = await decode(frame);
  expect(img.red).not.toBeNull();
  // The image is the 1000 px wide viewport: the target's centre is where the page put it.
  expect(img.width).toBe(1000);
  expect(img.red!.x).toBeCloseTo(TARGET[0] + TARGET[2] / 2, -1);
  const x = (img.red!.x * frame.metadata.deviceWidth) / img.width;
  const y = (img.red!.y * frame.metadata.deviceHeight) / img.height - (frame.metadata.offsetTop || 0);
  input({ type: "mouse", action: "move", x, y });
  input({ type: "mouse", action: "down", x, y, button: "left", clickCount: 1 });
  input({ type: "mouse", action: "up", x, y, button: "left", clickCount: 1 });
  clicks++;
  await until(activeTitle, (t) => t === `clicked${clicks}`, `click ${clicks} reached the target`);
}

const startCast = () =>
  c.req("browser.screencast.start", { projectId, maxWidth: PANEL.width * DPR, maxHeight: PANEL.height * DPR, quality: 80 });

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-viewport-")));
  dataDir = join(root, "data");
  mkdirSync(join(root, "p"));
  mkdirSync(join(root, "p2"));
  const configPath = join(root, "engine.json");
  const cdpPortBase = 45000 + Math.floor(Math.random() * 20) * 100;
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 100 },
    }),
  );
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><title>sayfa</title><body style="margin:0;background:#fff"><button id="t" style="position:absolute;left:${TARGET[0]}px;top:${TARGET[1]}px;` +
        `width:${TARGET[2]}px;height:${TARGET[3]}px;border:0;padding:0;background:rgb(230,30,30)" onclick="window.n=(window.n||0)+1;document.title='clicked'+window.n"></button></body>`,
    );
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Görüş", location: { kind: "local", path: join(root, "p") } })).project.id;
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  await c?.close();
  await stopEngine(engine);
  for (const pid of ourChromePids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await new Promise<void>((r) => site?.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!haveChrome)("Tarayıcı panele sığar: page viewport = panel ÷ zoom, with a real Chrome", { timeout: 120_000 }, () => {
  it("a size sent before the browser runs is applied when it starts; a frame has the panel's aspect", async () => {
    await c.req("browser.zoom.set", { projectId, zoom: 0.8, mode: "user" });
    await c.req("browser.viewport.set", { projectId, ...PANEL });
    await c.req("browser.open", { projectId });
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/` });
    await until(activeTitle, (t) => t === "sayfa", "page title");
    await waitPageSize("1000x625");
    await startCast();
    const f = await nextFrame(0, (x) => x.metadata.deviceWidth === 1000);
    expect([f.metadata.deviceWidth, f.metadata.deviceHeight]).toEqual([1000, 625]);
    const img = await decode(f);
    // The whole viewport, at this Chrome's own scale factor (1 in headless): exactly the panel's aspect.
    expect([img.width, img.height]).toEqual([1000, 625]);
  });

  it("the panel is resized: the page follows, and a frame is never larger than the panel's device pixels", async () => {
    await c.req("browser.viewport.set", { projectId, width: 640, height: 300 });
    await waitPageSize("800x375");
    // A 1x screen: the screencast is bounded by the panel's 640x300 device px.
    const before = lastFrameId();
    await c.req("browser.screencast.start", { projectId, maxWidth: 640, maxHeight: 300, quality: 80 });
    const img = await decode(await nextFrame(before, (x) => x.metadata.deviceWidth === 800));
    expect([img.width, img.height]).toEqual([640, 300]);
    await c.req("browser.viewport.set", { projectId, ...PANEL });
    await waitPageSize("1000x625");
  });

  it("Chrome's own window changes size behind Kokpit's back: the page keeps the panel's size", async () => {
    // Keep acking so frames keep coming while nothing restarts the screencast.
    await nextFrame(lastFrameId() - 1);
    const before = lastFrameId();
    await withAgent(async (cdp, _sid, targetId) => {
      const { windowId } = await cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId });
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: defaults.browser.windowWidth + 400, height: defaults.browser.windowHeight + 300 } });
    });
    await sleep(500);
    expect(await pageSize()).toBe("1000x625");
    // Chrome resized the page's view to its window: frames of the wrong size (1680 px wide, the page in a corner)
    // reach the engine, which asserts the panel's size again by itself — no restart, no request from the app.
    await nextFrame(before, (f) => f.metadata.deviceWidth === 1000);
    await sleep(700);
    expect(frames().at(-1)!.metadata).toMatchObject({ deviceWidth: 1000, deviceHeight: 625 });
    expect(await pageSize()).toBe("1000x625");
    await clickTarget();
    // Stopping and starting the screencast (the panel was hidden and shown) asserts it again and changes nothing.
    await c.req("browser.screencast.stop", { projectId });
    await startCast();
    expect(await pageSize()).toBe("1000x625");
  });

  it("zoom steps sent without waiting end on the last one, with no error", async () => {
    const results = await Promise.allSettled([
      c.req("browser.zoom.set", { projectId, zoom: 0.9, mode: "user" }),
      c.req("browser.zoom.set", { projectId, zoom: 1, mode: "user" }),
      c.req("browser.zoom.set", { projectId, zoom: 1.1, mode: "user" }),
      c.req("browser.zoom.set", { projectId, zoom: 1, mode: "user" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    await waitPageSize("800x500");
    await sleep(300);
    expect(await pageSize()).toBe("800x500");
    await c.req("browser.zoom.set", { projectId, zoom: 0.8, mode: "user" });
    await waitPageSize("1000x625");
  });

  it("a new tab and a switch back keep the size", async () => {
    const first = (await tabs()).activeTabId!;
    await c.req("browser.newTab", { projectId, url: `${siteUrl}/` });
    await until(async () => (await tabs()).activeTabId, (id) => id !== first, "new tab active");
    await waitPageSize("1000x625");
    await c.req("browser.selectTab", { projectId, tabId: first });
    await waitPageSize("1000x625");
  });

  it("a click mapped from the scaled image hits its target", async () => {
    await clickTarget();
  });

  it("with no panel size known (no app ever reported one) quick zoom steps still end on the last one", async () => {
    await c.req("browser.close", { projectId });
    const other = (await c.req<{ project: { id: string } }>("projects.create", { name: "Panelsiz", location: { kind: "local", path: join(root, "p2") } })).project.id;
    projectId = other;
    await c.req("browser.open", { projectId });
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/` });
    await until(activeTitle, (t) => t === "sayfa", "page title");
    // No panel: Chrome's window ÷ zoom. At 100 % that is the window itself.
    await c.req("browser.zoom.set", { projectId, zoom: 1, mode: "user" });
    const natural = await until(() => pageEval<number>("innerWidth"), (w) => Math.abs(w - defaults.browser.windowWidth) <= 1, "window at 100 %");
    const results = await Promise.allSettled([0.8, 0.9, 1, 0.9, 0.8, 0.9, 1].map((zoom) => c.req("browser.zoom.set", { projectId, zoom, mode: "user" })));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    await sleep(500);
    expect(await pageEval<number>("innerWidth")).toBe(natural);
    await c.req("browser.zoom.set", { projectId, zoom: 0.8, mode: "user" });
    await until(() => pageEval<number>("innerWidth"), (w) => Math.abs(w - Math.round(natural / 0.8)) <= 1, "window / 0.8");
  });
});
