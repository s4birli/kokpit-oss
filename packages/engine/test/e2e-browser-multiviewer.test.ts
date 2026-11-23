// "Tarayıcıda yakınlaştırıyorum, sonra kendiliğinden uzaklaşıyor": two apps (a MacBook and a second one left open on
// the engine machine) show ONE project's Chrome in panels of different sizes. End-to-end against the real engine
// and a REAL headless Chrome (temp profile, mock keychain), with two connections playing the two apps:
// - the zoom is the project's, owned by the engine: reported in the state (also while closed), announced to the
//   other app, persisted across an engine restart; an app that re-sends a copy of its own (what apps did on every
//   mount and reconnect) can no longer change it, and a stored copy is handed over only when nobody chose a zoom;
// - only ONE viewer drives the page's viewport — the one whose panel the user last used. The other's size reports
//   (mount, reconnect, focus, resize, re-subscribe) are ignored: two idle viewers never resize the page, and the
//   self-heal goes to the owner's size;
// - a passive viewer's click lands exactly (mapped from the owner-sized frame) and is delivered BEFORE the page is
//   resized for the viewer who thereby becomes the owner;
// - monkey: random zoom / size / interaction / reconnect sequences from both — the engine's zoom is always the last
//   user zoom action and the page is always the owner's panel ÷ zoom.
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
  browser: { chromePath: string; profilesDirName: string; windowWidth: number; windowHeight: number; defaultZoom: number; viewportHealIntervalMs: number };
};
const CHROME = defaults.browser.chromePath;
const haveChrome = existsSync(CHROME);
const DEFAULT_ZOOM = defaults.browser.defaultZoom;
/** The two apps' panels (CSS px): the MacBook's and the one left open on the engine machine. */
const PANEL_A = { width: 900, height: 600 };
const PANEL_B = { width: 700, height: 420 };
/** Target [left, top, width, height] in page CSS px. */
const TARGET = [300, 200, 120, 60] as const;
/** How long "nothing happens" is watched: several self-heal intervals. */
const IDLE_MS = 5 * defaults.browser.viewportHealIntervalMs;

let root: string;
let dataDir: string;
let configPath: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let a: Client;
let b: Client;
let projectId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = (id = projectId) => join(dataDir, defaults.browser.profilesDirName, id);

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

function killOurChromes(): void {
  for (const pid of ourChromePids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

function devtoolsPort(id = projectId): number {
  const out = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.includes(`--user-data-dir=${profile(id)}`) && !l.includes("--type="));
  return Number(/--remote-debugging-port=(\d+)/.exec(line ?? "")?.[1]);
}

const state = async (c: Client, id = projectId) => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId: id })).browser;
const activeTitle = async () => {
  const s = await state(a);
  return s.tabs.find((t) => t.id === s.activeTabId)?.title ?? "";
};
const framesOf = (c: Client) => c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame" && f.projectId === projectId);
const ack = (c: Client) => {
  const last = framesOf(c).at(-1);
  if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
};
function nextFrame(c: Client, afterId: number, pred: (f: BrowserFrameMessage) => boolean = () => true): Promise<BrowserFrameMessage> {
  return until(
    () => {
      ack(c);
      return framesOf(c).find((f) => f.frameId > afterId && pred(f));
    },
    (f) => f !== undefined,
    `frame after ${afterId}`,
  ) as Promise<BrowserFrameMessage>;
}
const lastFrameId = (c: Client) => framesOf(c).at(-1)?.frameId ?? 0;
const cast = (c: Client, panel: { width: number; height: number }) =>
  c.req("browser.screencast.start", { projectId, maxWidth: panel.width, maxHeight: panel.height, quality: 80 });
const send = (c: Client, msg: Record<string, unknown>) => c.ws.send(JSON.stringify(msg));
const input = (c: Client, event: Record<string, unknown>) => send(c, { type: "browser.input", projectId, event });

/** What a size report answers: whether the engine used it. */
const size = async (c: Client, panel: { width: number; height: number }, interaction?: boolean, id = projectId) =>
  (await c.req<{ applied: boolean }>("browser.viewport.set", { projectId: id, ...panel, ...(interaction === undefined ? {} : { interaction }) })).applied;
const userZoom = (c: Client, zoom: number | null, id = projectId) =>
  c.req<{ zoom: number; applied: boolean }>("browser.zoom.set", { projectId: id, zoom, mode: "user" });

/** A second CDP client (like an agent's Playwright): runs `fn` with a session on the active tab. */
async function withAgent<T>(fn: (cdp: CdpConnection, sessionId: string, targetId: string) => Promise<T>): Promise<T> {
  const version = (await (await fetch(`http://127.0.0.1:${devtoolsPort()}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const cdp = await connectCdp(version.webSocketDebuggerUrl, { timeoutMs: 15_000 });
  try {
    const { activeTabId } = await state(a);
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
/** The page's layout viewport for a panel at a zoom, as the engine rounds it. */
const sizeFor = (panel: { width: number; height: number }, zoom: number) => `${Math.round(panel.width / zoom)}x${Math.round(panel.height / zoom)}`;
/** How often the page was resized since `resetResizes()`: the page counts its own `resize` events. */
const resizes = () => pageEval<number>("window.__resizes");
const resetResizes = () => pageEval<number>("(window.__resizes = 0)");

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

async function boot(): Promise<void> {
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
  a = await Client.connect(engine.port, KEY);
  b = await Client.connect(engine.port, KEY);
}

/** Stops the engine (its Chromes close with it) and starts it again on the same data; both apps reconnect. */
async function restartEngine(): Promise<void> {
  await a.close();
  await b.close();
  await stopEngine(engine);
  killOurChromes();
  await boot();
}

/** Opens the project's browser on the test page; nobody has reported a panel yet. */
async function openOnSite(id = projectId): Promise<void> {
  await a.req("browser.open", { projectId: id });
  await a.req("browser.navigate", { projectId: id, url: `${siteUrl}/` });
  await until(async () => (await state(a, id)).tabs.some((t) => t.title === "sayfa" || t.title.startsWith("clicked")), (ok) => ok, "page title");
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-multiviewer-")));
  dataDir = join(root, "data");
  for (const dir of ["p", "p2", "p3"]) mkdirSync(join(root, dir));
  configPath = join(root, "engine.json");
  const cdpPortBase = 47000 + Math.floor(Math.random() * 20) * 100;
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
        `width:${TARGET[2]}px;height:${TARGET[3]}px;border:0;padding:0;background:rgb(230,30,30)" onclick="window.n=(window.n||0)+1;document.title='clicked'+window.n"></button>` +
        `<script>window.__resizes=0;addEventListener("resize",()=>{window.__resizes++})</script></body>`,
    );
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  await boot();
  await a.req("settings.update", { defaultToolId: null });
  projectId = (await a.req<{ project: { id: string } }>("projects.create", { name: "İki izleyici", location: { kind: "local", path: join(root, "p") } })).project.id;
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  await a?.close();
  await b?.close();
  await stopEngine(engine);
  killOurChromes();
  await new Promise<void>((r) => site?.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!haveChrome)("İki uygulama, tek tarayıcı: zoom is the engine's, one viewer drives the viewport", { timeout: 180_000 }, () => {
  it("the zoom is the project's: the configured default until a user chooses one, reported while the browser is closed too", async () => {
    for (const c of [a, b]) expect(await state(c)).toMatchObject({ running: false, zoom: DEFAULT_ZOOM });
  });

  it("A (the MacBook) opens the page, uses its panel and zooms in: A drives the viewport and B learns the zoom", async () => {
    await openOnSite();
    expect(await size(a, PANEL_A, true)).toBe(true);
    const events = b.frames.length;
    expect(await userZoom(a, 1)).toEqual({ zoom: 1, applied: true });
    await waitPageSize(sizeFor(PANEL_A, 1));
    expect(await state(a)).toMatchObject({ running: true, zoom: 1, viewportOwner: true });
    // The other app is told (browser.changed) and reads the same zoom; it does not drive the viewport.
    await until(() => b.frames.slice(events).some((f) => f.type === "event" && f.name === "browser.changed" && f.projectId === projectId), (ok) => ok, "B hears browser.changed");
    expect(await state(b)).toMatchObject({ running: true, zoom: 1, viewportOwner: false });
  });

  it("B's panel starts (mount): its size report and its screencast change nothing; it gets A-sized frames", async () => {
    await cast(a, PANEL_A);
    expect(await size(b, PANEL_B)).toBe(false);
    await cast(b, PANEL_B);
    const frame = await nextFrame(b, 0);
    expect([frame.metadata.deviceWidth, frame.metadata.deviceHeight]).toEqual([PANEL_A.width, PANEL_A.height]);
    expect(await pageSize()).toBe(sizeFor(PANEL_A, 1));
    expect(await state(b)).toMatchObject({ zoom: 1, viewportOwner: false });
  });

  it("an old app re-sends its own zoom copy (what every mount and reconnect did): refused, the zoom stays", async () => {
    await expect(b.req("browser.zoom.set", { projectId, zoom: DEFAULT_ZOOM })).rejects.toMatchObject({ code: "INVALID" });
    // The same value as the project's is harmless.
    expect(await b.req("browser.zoom.set", { projectId, zoom: 1 })).toEqual({ zoom: 1, applied: false });
    // A stored copy is handed over only when nobody chose a zoom — A did.
    expect(await b.req("browser.zoom.set", { projectId, zoom: 0.8, mode: "adopt" })).toEqual({ zoom: 1, applied: false });
    expect(await state(a)).toMatchObject({ zoom: 1 });
    expect(await pageSize()).toBe(sizeFor(PANEL_A, 1));
  });

  it("B reconnects, is focused and resized without the user touching it: still nothing changes", async () => {
    await b.close();
    b = await Client.connect(engine!.port, KEY);
    // Reconnect: the panel reports its size and subscribes again; window focus and a resize report it again.
    expect(await size(b, PANEL_B)).toBe(false);
    await cast(b, PANEL_B);
    expect(await size(b, PANEL_B, false)).toBe(false);
    expect(await size(b, { width: PANEL_B.width + 40, height: PANEL_B.height - 20 })).toBe(false);
    expect(await state(b)).toMatchObject({ zoom: 1, viewportOwner: false });
    expect(await state(a)).toMatchObject({ zoom: 1, viewportOwner: true });
    expect(await pageSize()).toBe(sizeFor(PANEL_A, 1));
  });

  it("two idle viewers: the page is never resized (no ping-pong), whatever the passive one keeps reporting", async () => {
    await resetResizes();
    const until_ = Date.now() + IDLE_MS;
    let round = 0;
    while (Date.now() < until_) {
      ack(a);
      ack(b);
      // The passive app's panel re-asserts (focus, reconnect, a hidden panel shown again); the owner's too.
      if (round % 3 === 0) expect(await size(b, PANEL_B)).toBe(false);
      if (round % 3 === 1) await cast(b, PANEL_B);
      if (round % 3 === 2) expect(await size(a, PANEL_A)).toBe(true);
      round++;
      await sleep(100);
    }
    expect(round).toBeGreaterThan(6);
    expect(await resizes()).toBe(0);
    expect(await pageSize()).toBe(sizeFor(PANEL_A, 1));
  });

  it("Chrome's own window changes: the self-heal goes to the owner's size, with both viewers watching", async () => {
    await nextFrame(a, lastFrameId(a) - 1);
    const before = lastFrameId(b);
    await withAgent(async (cdp, _sid, targetId) => {
      const { windowId } = await cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId });
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: defaults.browser.windowWidth + 400, height: defaults.browser.windowHeight + 300 } });
    });
    await nextFrame(b, before, (f) => f.metadata.deviceWidth === PANEL_A.width);
    ack(a);
    await sleep(IDLE_MS);
    expect(framesOf(b).at(-1)!.metadata).toMatchObject({ deviceWidth: PANEL_A.width, deviceHeight: PANEL_A.height });
    expect(await pageSize()).toBe(sizeFor(PANEL_A, 1));
    expect(await state(a)).toMatchObject({ viewportOwner: true });
  });

  it("the passive viewer clicks: the click lands (mapped from the A-sized frame) before the page becomes B's size", async () => {
    const before = lastFrameId(b);
    await cast(b, PANEL_B);
    const frame = await nextFrame(b, before, (f) => f.metadata.deviceWidth === PANEL_A.width);
    const img = await decode(frame);
    expect(img.red).not.toBeNull();
    // B gets the owner's whole page (the owner's shape; B's panel letterboxes it), and B's smaller panel did not
    // make the shared picture coarser for A: one screencast, bounded by the largest viewer.
    expect([img.width, img.height]).toEqual([PANEL_A.width, PANEL_A.height]);
    const x = (img.red!.x * frame.metadata.deviceWidth) / img.width;
    const y = (img.red!.y * frame.metadata.deviceHeight) / img.height - (frame.metadata.offsetTop || 0);
    // Exactly what the app sends, without waiting in between: the press, the release, then the claim.
    input(b, { type: "mouse", action: "move", x, y });
    input(b, { type: "mouse", action: "down", x, y, button: "left", clickCount: 1 });
    input(b, { type: "mouse", action: "up", x, y, button: "left", clickCount: 1 });
    expect(await size(b, PANEL_B, true)).toBe(true);
    await until(activeTitle, (t) => t === "clicked1", "the passive viewer's click reached the target");
    await waitPageSize(sizeFor(PANEL_B, 1));
    expect(await state(b)).toMatchObject({ viewportOwner: true });
    expect(await state(a)).toMatchObject({ viewportOwner: false });
    // Now A is the passive one: its reports are ignored until its user uses its panel again.
    expect(await size(a, PANEL_A)).toBe(false);
    expect(await pageSize()).toBe(sizeFor(PANEL_B, 1));
    expect(await size(a, PANEL_A, true)).toBe(true);
    await waitPageSize(sizeFor(PANEL_A, 1));
  });

  it("the owner goes away (app closed, or its panel no longer shows the browser): the next viewer to report drives", async () => {
    // A stops watching (its panel shows another project): the page keeps its size until someone reports one.
    await a.req("browser.screencast.stop", { projectId });
    await sleep(300);
    expect(await pageSize()).toBe(sizeFor(PANEL_A, 1));
    expect(await state(a)).toMatchObject({ viewportOwner: false });
    expect(await size(b, PANEL_B)).toBe(true);
    await waitPageSize(sizeFor(PANEL_B, 1));
    // B's connection drops (app quit / machine asleep): A, back on the page, takes over without a claim.
    await b.close();
    await cast(a, PANEL_A);
    expect(await size(a, PANEL_A)).toBe(true);
    await waitPageSize(sizeFor(PANEL_A, 1));
    b = await Client.connect(engine!.port, KEY);
    expect(await size(b, PANEL_B)).toBe(false);
  });

  it("quick zoom steps from the owner end on the last one; a reset goes back to the configured default", async () => {
    const results = await Promise.all([0.9, 1, 1.1, 1.25].map((zoom) => userZoom(a, zoom)));
    expect(results.at(-1)).toEqual({ zoom: 1.25, applied: true });
    await waitPageSize(sizeFor(PANEL_A, 1.25));
    await sleep(300);
    expect(await pageSize()).toBe(sizeFor(PANEL_A, 1.25));
    expect(await state(b)).toMatchObject({ zoom: 1.25 });
    expect(await userZoom(b, null)).toEqual({ zoom: DEFAULT_ZOOM, applied: true });
    await waitPageSize(sizeFor(PANEL_A, DEFAULT_ZOOM));
    expect(await state(a)).toMatchObject({ zoom: DEFAULT_ZOOM, viewportOwner: true });
    expect(await userZoom(a, 1.25)).toEqual({ zoom: 1.25, applied: true });
  });

  it("the engine restarts: the zoom is still the user's before any app says anything, and no stale copy can replace it", async () => {
    await restartEngine();
    for (const c of [a, b]) expect(await state(c)).toMatchObject({ running: false, zoom: 1.25 });
    // The app left open on the engine machine reconnects first, with its old copy and its own size.
    await expect(b.req("browser.zoom.set", { projectId, zoom: DEFAULT_ZOOM })).rejects.toMatchObject({ code: "INVALID" });
    expect(await b.req("browser.zoom.set", { projectId, zoom: DEFAULT_ZOOM, mode: "adopt" })).toEqual({ zoom: 1.25, applied: false });
    await openOnSite();
    // Nobody reported a panel yet: Chrome's window ÷ the project's zoom.
    await until(() => pageEval<number>("innerWidth"), (w) => Math.abs(w - Math.round(defaults.browser.windowWidth / 1.25)) <= 1, "window ÷ 1.25");
    expect(await size(a, PANEL_A)).toBe(true);
    await waitPageSize(sizeFor(PANEL_A, 1.25));
    expect(await size(b, PANEL_B)).toBe(false);
    expect(await pageSize()).toBe(sizeFor(PANEL_A, 1.25));
  });

  it("a chosen default is a choice too: after a reset an app's old stored zoom is not adopted, also across a restart", async () => {
    expect(await userZoom(a, null)).toEqual({ zoom: DEFAULT_ZOOM, applied: true });
    expect(await b.req("browser.zoom.set", { projectId, zoom: 1.5, mode: "adopt" })).toEqual({ zoom: DEFAULT_ZOOM, applied: false });
    await restartEngine();
    expect(await b.req("browser.zoom.set", { projectId, zoom: 1.5, mode: "adopt" })).toEqual({ zoom: DEFAULT_ZOOM, applied: false });
    expect(await state(a)).toMatchObject({ zoom: DEFAULT_ZOOM });
  });

  it("hand-over: a project nobody ever zoomed adopts the first app's stored zoom, once", async () => {
    const other = (await a.req<{ project: { id: string } }>("projects.create", { name: "Devir", location: { kind: "local", path: join(root, "p2") } })).project.id;
    expect(await state(a, other)).toMatchObject({ running: false, zoom: DEFAULT_ZOOM });
    expect(await a.req("browser.zoom.set", { projectId: other, zoom: 1.1, mode: "adopt" })).toEqual({ zoom: 1.1, applied: true });
    // The second app's copy (and an old app's) comes too late.
    expect(await b.req("browser.zoom.set", { projectId: other, zoom: 0.8, mode: "adopt" })).toEqual({ zoom: 1.1, applied: false });
    await expect(b.req("browser.zoom.set", { projectId: other, zoom: 0.8 })).rejects.toMatchObject({ code: "INVALID" });
    expect(await state(b, other)).toMatchObject({ zoom: 1.1 });
    await restartEngine();
    expect(await state(b, other)).toMatchObject({ zoom: 1.1 });
    // A deleted project's zoom is forgotten with it.
    await a.req("projects.delete", { projectId: other });
    expect(JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")).browserZooms ?? {}).not.toHaveProperty(other);
  });

  it("monkey: random zoom / size / interaction / reconnect sequences from two apps keep the invariant", async () => {
    const id = (await a.req<{ project: { id: string } }>("projects.create", { name: "Maymun", location: { kind: "local", path: join(root, "p3") } })).project.id;
    projectId = id;
    await openOnSite();
    let seed = 20261117;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
    const clients = { a: () => a, b: () => b };
    type Who = keyof typeof clients;
    const model: { zoom: number; chosen: boolean; owner: Who | null; view: { width: number; height: number } | null } = { zoom: DEFAULT_ZOOM, chosen: false, owner: null, view: null };
    const log: string[] = [];
    const check = async (settled: boolean): Promise<void> => {
      for (const who of ["a", "b"] as const) {
        const s = await state(clients[who]());
        expect([s.zoom, s.viewportOwner], `${who} after ${log.join(" · ")}`).toEqual([model.zoom, model.owner === who]);
      }
      if (settled && model.view) {
        const want = sizeFor(model.view, model.zoom);
        await until(pageSize, (s) => s === want, `page ${want} after ${log.join(" · ")}`);
      }
    };
    for (let i = 0; i < 60; i++) {
      const who: Who = rnd(2) === 0 ? "a" : "b";
      const c = clients[who]();
      const op = rnd(10);
      if (op <= 1) {
        const zoom = LEVELS[rnd(LEVELS.length)]!;
        log.push(`${who} zoom ${zoom}`);
        expect(await userZoom(c, zoom)).toEqual({ zoom, applied: true });
        model.zoom = zoom;
        model.chosen = true;
      } else if (op === 2) {
        log.push(`${who} reset`);
        expect(await userZoom(c, null)).toEqual({ zoom: DEFAULT_ZOOM, applied: true });
        model.zoom = DEFAULT_ZOOM;
        model.chosen = true;
      } else if (op === 3) {
        // An app's stored copy / an old app's re-assert: only ever used when nobody chose a zoom.
        const zoom = LEVELS[rnd(LEVELS.length)]!;
        const legacy = rnd(2) === 0;
        log.push(`${who} ${legacy ? "old" : "adopt"} ${zoom}`);
        const applies = !model.chosen;
        const r = c.req<{ zoom: number; applied: boolean }>("browser.zoom.set", { projectId, zoom, ...(legacy ? {} : { mode: "adopt" }) });
        if (applies) {
          expect(await r).toEqual({ zoom, applied: true });
          model.zoom = zoom;
          model.chosen = true;
        } else if (legacy && zoom !== model.zoom) await expect(r).rejects.toMatchObject({ code: "INVALID" });
        else expect(await r).toEqual({ zoom: model.zoom, applied: false });
      } else if (op <= 7) {
        const panel = { width: 400 + rnd(900), height: 300 + rnd(500) };
        const interaction = rnd(3) === 0;
        log.push(`${who} size ${panel.width}x${panel.height}${interaction ? " (used)" : ""}`);
        const applies = interaction || model.owner === null || model.owner === who;
        expect(await size(c, panel, interaction), log.join(" · ")).toBe(applies);
        if (applies) {
          model.owner = who;
          model.view = panel;
        }
      } else if (op === 8) {
        log.push(`${who} reconnects`);
        await c.close();
        if (who === "a") a = await Client.connect(engine!.port, KEY);
        else b = await Client.connect(engine!.port, KEY);
        if (model.owner === who) model.owner = null;
      } else {
        // The panel goes away and comes back (project tab switch): it stops watching, then watches again.
        log.push(`${who} leaves and returns`);
        await cast(c, PANEL_B);
        await c.req("browser.screencast.stop", { projectId });
        if (model.owner === who) model.owner = null;
        await cast(c, PANEL_B);
      }
      await check(i % 6 === 5);
    }
    await check(true);
    // A burst from one app, nothing awaited in between: the last zoom and the last size win.
    const c = a;
    expect(await size(c, PANEL_A, true)).toBe(true);
    const burst = [userZoom(c, 0.9), size(c, PANEL_B), userZoom(c, 1.1), size(c, { width: 640, height: 480 }), userZoom(c, 0.8), size(c, PANEL_A), userZoom(c, 1)];
    expect((await Promise.allSettled(burst)).filter((r) => r.status === "rejected")).toEqual([]);
    await waitPageSize(sizeFor(PANEL_A, 1));
    await sleep(IDLE_MS);
    expect(await pageSize()).toBe(sizeFor(PANEL_A, 1));
    for (const who of [a, b]) expect(await state(who)).toMatchObject({ zoom: 1 });
  });
});
