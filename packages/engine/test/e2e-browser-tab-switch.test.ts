// "Sekmeler arasında geçiş çalışmıyor — öbür sekme yüklenmiyor ya da tıklama gitmiyor." Live, a tab whose page runs
// no script (an expired file preview: the engine's 404 page is served with CSP `sandbox`) held EVERY switch to it
// for cdpTimeoutMs (15 s): the engine waited for the page to paint by evaluating a promise IN the page, and in a
// page without scripts its timers never run. Clicks on other tabs queued behind it; a click on the tab being closed
// meanwhile failed half-way and left the engine on a detached CDP session ("Session with given id not found" for
// zoom, viewport, screencast and every input) until the next successful switch.
// Real engine + REAL headless Chrome (temp profile, mock keychain), local pages only, a viewer subscribed like the
// app's panel. Chrome itself (its DevTools HTTP endpoint, a second CDP client) is the witness.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFrameMessage, BrowserState } from "@kokpit/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectCdp } from "../src/cdp.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; cdpTimeoutMs: number; zoomPaintWaitMs: number; tabStepTimeoutMs: number };
};
const haveChrome = existsSync(defaults.browser.chromePath);
/**
 * Longest a tab switch or close may take here: every step that waits on the page is bounded by tabStepTimeoutMs or
 * zoomPaintWaitMs; a few of those, never the 15 s CDP timeout.
 */
const SWITCH_BOUND_MS = 3 * Math.max(defaults.browser.tabStepTimeoutMs, defaults.browser.zoomPaintWaitMs);
const WAIT_MS = 15_000;
const PANEL = { width: 640, height: 400 };
const ZOOM = 1.1;
const LOOPBACK = "127.0.0.1";
/** What the engine logs when it used a CDP session Chrome no longer has. */
const STALE = ["Session with given id not found", "No session with given id", "No target with given id found"];

let root: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** The DevTools port of the current project's Chrome (from the engine's own "chrome started" line). */
function devtoolsPort(): number {
  for (const line of engine!.logs().split("\n").reverse()) {
    if (!line.includes('"chrome started"')) continue;
    const entry = JSON.parse(line) as { projectId?: string; port?: number };
    if (entry.projectId === projectId && entry.port) return entry.port;
  }
  throw new Error("no chrome started line");
}

/** Engine log lines (text) written since `from` chars. */
const logSince = (from: number): string => engine!.logs().slice(from);
const staleIn = (text: string): string[] => text.split("\n").filter((l) => STALE.some((s) => l.includes(s)));

const ids = (s: BrowserState): string[] => s.tabs.map((t) => t.id);
const state = async (): Promise<BrowserState> => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;
const titleOf = async (tabId: string): Promise<string> => (await state()).tabs.find((t) => t.id === tabId)?.title ?? "";

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}
const selectTab = (tabId: string) => c.req<{ browser: BrowserState }>("browser.selectTab", { projectId, tabId }).then((r) => r.browser);
const closeTab = (tabId: string) => c.req<{ browser: BrowserState }>("browser.closeTab", { projectId, tabId }).then((r) => r.browser);
const newTab = (url: string) => c.req<{ browser: BrowserState }>("browser.newTab", { projectId, url }).then((r) => r.browser);

/** The pages Chrome itself has (ids), from its DevTools HTTP endpoint. */
async function chromePages(): Promise<string[]> {
  const res = await fetch(`http://${LOOPBACK}:${devtoolsPort()}/json/list`);
  return ((await res.json()) as { id: string; type: string }[]).filter((t) => t.type === "page").map((t) => t.id);
}

/** Runs `expression` in `tabId` from a second CDP client (like an agent): what the page itself says. */
async function inTab<T>(tabId: string, expression: string): Promise<T> {
  const version = (await (await fetch(`http://${LOOPBACK}:${devtoolsPort()}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const cdp = await connectCdp(version.webSocketDebuggerUrl, { timeoutMs: WAIT_MS });
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: tabId, flatten: true });
    const r = await cdp.send<{ result: { value: T } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    return r.result.value;
  } finally {
    cdp.close();
  }
}

const framesOf = () => c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame" && f.projectId === projectId);
const lastFrameId = () => framesOf().at(-1)?.frameId ?? 0;
const nextFrame = (after: number) => until(() => framesOf().find((f) => f.frameId > after), (f) => f !== undefined, `a frame after ${after}`);

/** Background colour (r,g,b) at the centre of a frame, decoded in a page that runs scripts. */
function centreColour(decoderTab: string, frame: BrowserFrameMessage): Promise<[number, number, number]> {
  return inTab(decoderTab, `(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(frame.data)}), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const p = ctx.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data;
    return [p[0], p[1], p[2]];
  })()`);
}
const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 24);

/** A click in the panel at page CSS px (like the app: press + release). */
function click(x: number, y: number): void {
  for (const action of ["down", "up"] as const) {
    c.ws.send(JSON.stringify({ type: "browser.input", projectId, event: { type: "mouse", action, x, y, button: "left", clickCount: 1 } }));
  }
}

/** Page colours by tab number (distinct, and far from the 404 page's white). */
const COLOURS: [number, number, number][] = [
  [220, 40, 40],
  [40, 160, 60],
  [40, 80, 220],
  [230, 160, 20],
  [150, 40, 180],
  [20, 170, 170],
  [120, 120, 40],
  [200, 80, 140],
];
const hex = (rgb: readonly number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const pageUrl = (n: number) => `${siteUrl}/p?n=${n}`;
const SANDBOX_URL = () => `${siteUrl}/gone`;
const BEFOREUNLOAD_URL = () => `${siteUrl}/bu`;

/** A project with its Chrome, a viewer subscribed at PANEL and the user's zoom, and `urls` as its tabs (in order). */
async function openTabs(name: string, urls: string[]): Promise<string[]> {
  mkdirSync(join(root, name));
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name, location: { kind: "local", path: join(root, name) } })).project.id;
  await c.req("browser.viewport.set", { projectId, ...PANEL, interaction: true });
  await c.req("browser.zoom.set", { projectId, zoom: ZOOM, mode: "user" });
  const first = (await c.req<{ browser: BrowserState }>("browser.open", { projectId })).browser;
  await c.req("browser.screencast.start", { projectId, maxWidth: PANEL.width * 2, maxHeight: PANEL.height * 2, quality: 70 });
  for (const url of urls) await newTab(url);
  // Chrome's own blank first tab is not one of ours.
  await closeTab(first.tabs[0]!.id);
  const s = await state();
  expect(s.tabs.map((t) => t.url)).toEqual(urls);
  return ids(s);
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-tab-switch-")));
  const configPath = join(root, "engine.json");
  const cdpPortBase = 50000 + Math.floor(Math.random() * 20) * 100;
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
      // The production CDP timeout: the bug was a step that waited all of it.
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 100, cdpTimeoutMs: defaults.browser.cdpTimeoutMs },
    }),
  );
  site = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/gone") {
      // Exactly how the engine refuses an expired preview: a plain-text 404 that may run no script at all.
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff" });
      res.end("Önizleme adresi geçersiz ya da süresi doldu.\n");
      return;
    }
    const n = Number(u.searchParams.get("n")) || 0;
    const bu = u.pathname === "/bu";
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><title>Sekme ${bu ? "bu" : n} tık 0</title><body style="margin:0;height:100vh;background:${hex(COLOURS[n % COLOURS.length]!)}">` +
        // A click is counted in the title (the witness) and on the page (so it repaints: a new screencast frame).
        `<b id="k" style="font:12px sans-serif">0</b>` +
        `<script>let k = 0; addEventListener("mousedown", () => { document.title = "Sekme ${bu ? "bu" : n} tık " + ++k; document.getElementById("k").textContent = String(k); });` +
        (bu ? `addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });` : "") +
        `</script></body>`,
    );
  });
  await new Promise<void>((r) => site.listen(0, LOOPBACK, () => r()));
  siteUrl = `http://${LOOPBACK}:${(site.address() as net.AddressInfo).port}`;
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
  c = await Client.connect(engine.port, KEY);
  // Like the app's panel: every frame is acknowledged as soon as it arrives.
  c.ws.on("message", (data) => {
    const text = data.toString();
    if (!text.includes('"browser.frame"')) return;
    const frame = JSON.parse(text) as { type?: string; projectId?: string; frameId?: number };
    if (frame.type === "browser.frame") c.ws.send(JSON.stringify({ type: "browser.ack", projectId: frame.projectId, frameId: frame.frameId }));
  });
  await c.req("settings.update", { defaultToolId: null });
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

const FAILURE_LOG_TAIL_CHARS = 6_000;

describe.skipIf(!haveChrome)("Tarayıcı sekmeleri arasında geçiş: hiçbir sayfa geçişi bekletmez, görüntü ve tıklama etkin sekmeye gider", { timeout: 180_000 }, () => {
  afterEach((ctx) => {
    if (ctx.task.result?.state !== "fail" || !engine) return;
    console.warn(`[e2e] "${ctx.task.name}" failed; engine log tail:\n${engine.logs().slice(-FAILURE_LOG_TAIL_CHARS)}`);
  });

  it("the bound is meaningful: far below the CDP timeout the bug waited for", () => {
    expect(SWITCH_BOUND_MS * 2).toBeLessThan(defaults.browser.cdpTimeoutMs);
  });

  /** After a switch to `tabId` (a page of colour `n`): a frame of it arrives, and a click lands in it. */
  async function showsAndClicks(tabId: string, n: number, decoder: string): Promise<void> {
    const before = lastFrameId();
    // The page repaints on the click; the frame after it is the page as it is now.
    const clicks = Number(/tık (\d+)/.exec(await titleOf(tabId))?.[1] ?? 0);
    click(40, 40);
    await until(() => titleOf(tabId), (t) => t.endsWith(`tık ${clicks + 1}`), `the click landed in tab ${n}`);
    const frame = (await nextFrame(before))!;
    const colour = await until(async () => centreColour(decoder, framesOf().at(-1) ?? frame), (rgb) => near(rgb, COLOURS[n]!), `frames show tab ${n}`);
    expect(near(colour, COLOURS[n]!)).toBe(true);
  }

  it("a page that runs no script (expired preview) as the active tab: switching to and from it, and closing it, are quick", async () => {
    const tabs = await openTabs("betiksiz", [pageUrl(1), SANDBOX_URL(), pageUrl(3), pageUrl(4), pageUrl(5), pageUrl(6)]);
    const [t1, gone, t3, t4] = tabs as [string, string, string, string];
    const logFrom = engine!.logs().length;

    const toGone = await timed(() => selectTab(gone));
    expect(toGone.value.activeTabId).toBe(gone);
    expect(toGone.ms).toBeLessThan(SWITCH_BOUND_MS);
    const back = await timed(() => selectTab(t4));
    expect(back.ms).toBeLessThan(SWITCH_BOUND_MS);
    await showsAndClicks(t4, 4, t1);

    // Close it while it is the active tab: the neighbour on its right takes over at once.
    await selectTab(gone);
    const closed = await timed(() => closeTab(gone));
    expect(closed.ms).toBeLessThan(SWITCH_BOUND_MS);
    expect(ids(closed.value)).toEqual(tabs.filter((t) => t !== gone));
    expect(closed.value.activeTabId).toBe(t3);
    await until(chromePages, (p) => !p.includes(gone), "Chrome closed the tab");
    await showsAndClicks(t3, 3, t1);

    // Zoom still applies to the new tab: its layout viewport is the panel ÷ zoom.
    const want = `${Math.round(PANEL.width / ZOOM)}x${Math.round(PANEL.height / ZOOM)}`;
    await until(() => inTab<string>(t3, "innerWidth + 'x' + innerHeight"), (s) => s === want, "the zoomed viewport on the new tab");
    expect(staleIn(logSince(logFrom))).toEqual([]);
    await c.req("browser.close", { projectId });
  });

  it("clicks on other tabs while the active one is closing: the last click wins, the tab being closed answers NOT_FOUND, nothing goes stale", async () => {
    const tabs = await openTabs("yarisan", [pageUrl(1), SANDBOX_URL(), pageUrl(3), pageUrl(4), pageUrl(5)]);
    const [t1, gone, , t4, t5] = tabs as [string, string, string, string, string];
    await selectTab(gone);
    const logFrom = engine!.logs().length;
    // The user's clicks during the close, without waiting: another tab, the closing tab itself, then t5.
    const closing = closeTab(gone);
    const clicks = await Promise.allSettled([selectTab(t4), selectTab(gone), selectTab(t4), selectTab(t5)]);
    await closing;
    // Clicking the closing tab is a clean "not found", never a CDP error.
    for (const r of clicks) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "NOT_FOUND" });
    const end = await state();
    expect(ids(end)).toEqual(tabs.filter((t) => t !== gone));
    expect(end.activeTabId).toBe(t5);
    await showsAndClicks(t5, 5, t1);
    // Zoom, size and screencast requests all work on the tab now shown.
    await c.req("browser.zoom.set", { projectId, zoom: 1, mode: "user" });
    await c.req("browser.viewport.set", { projectId, ...PANEL, interaction: true });
    await c.req("browser.screencast.start", { projectId, maxWidth: PANEL.width * 2, maxHeight: PANEL.height * 2, quality: 70 });
    await c.req("browser.zoom.set", { projectId, zoom: ZOOM, mode: "user" });
    await showsAndClicks(t5, 5, t1);
    expect(staleIn(logSince(logFrom))).toEqual([]);
    await c.req("browser.close", { projectId });
  });

  it("a page with a beforeunload handler (and a user gesture) as the active tab: closing it is quick, no dialog holds it", async () => {
    const tabs = await openTabs("beforeunload", [pageUrl(1), BEFOREUNLOAD_URL(), pageUrl(3)]);
    const [t1, bu, t3] = tabs as [string, string, string];
    await selectTab(bu);
    // Sticky user activation: from now on the page may ask "leave site?".
    click(40, 40);
    await until(() => titleOf(bu), (t) => t.endsWith("tık 1"), "the click landed in the beforeunload page");
    const logFrom = engine!.logs().length;
    const closed = await timed(() => closeTab(bu));
    expect(closed.ms).toBeLessThan(SWITCH_BOUND_MS);
    expect(closed.value.activeTabId).toBe(t3);
    await until(chromePages, (p) => !p.includes(bu), "Chrome closed the beforeunload tab");
    await showsAndClicks(t3, 3, t1);
    expect(staleIn(logSince(logFrom))).toEqual([]);
    await c.req("browser.close", { projectId });
  });

  it("monkey: random select / close / new over 6–8 tabs, partly without waiting — the end state is consistent and live", async () => {
    let seed = 20261120;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const urls = [pageUrl(1), SANDBOX_URL(), pageUrl(2), BEFOREUNLOAD_URL(), pageUrl(3), pageUrl(4)];
    await openTabs("maymun", urls);
    const logFrom = engine!.logs().length;
    const bad: string[] = [];
    const fired: Promise<unknown>[] = [];
    const check = (p: Promise<unknown>, what: string) =>
      p.catch((err: { code?: string; message?: string }) => {
        if (err.code !== "NOT_FOUND" && !(err.code === "INVALID" && /En fazla/.test(err.message ?? ""))) bad.push(`${what}: ${err.code} ${err.message}`);
      });
    for (let step = 0; step < 60; step++) {
      const now = ids(await state());
      const r = rnd();
      let op: Promise<unknown>;
      let what: string;
      if (r < 0.5 && now.length > 0) {
        const id = pick(now);
        what = `select ${id.slice(0, 6)}`;
        op = selectTab(id);
      } else if (r < 0.75 && now.length > 6) {
        const id = pick(now);
        what = `close ${id.slice(0, 6)}`;
        op = closeTab(id);
      } else if (now.length < 8) {
        const url = pick([pageUrl(Math.floor(rnd() * COLOURS.length)), SANDBOX_URL(), BEFOREUNLOAD_URL()]);
        what = `new ${url.slice(siteUrl.length)}`;
        op = newTab(url);
      } else {
        const id = pick(now);
        what = `close ${id.slice(0, 6)}`;
        op = closeTab(id);
      }
      const checked = check(op, what);
      // About half of the actions are not waited for: the next click comes while this one is still under way.
      if (rnd() < 0.5) fired.push(checked);
      else await checked;
    }
    await Promise.all(fired);
    expect(bad).toEqual([]);

    // Consistent: the engine's list is Chrome's pages; the active tab is one of them.
    const end = await state();
    await until(async () => (await chromePages()).sort(), (p) => p.join() === [...ids(end)].sort().join(), "Chrome's pages are the engine's tabs");
    expect(ids(end)).toContain(end.activeTabId);
    // Live: switch to a page of known colour (ours, scripts on) and the picture and a click follow it.
    const target = await newTab(pageUrl(2));
    const shown = target.activeTabId!;
    const decoder = ids(target).find((id) => id !== shown && target.tabs.find((t) => t.id === id)!.url.includes("/p?"));
    expect(decoder).toBeDefined();
    await showsAndClicks(shown, 2, decoder!);
    expect(staleIn(logSince(logFrom))).toEqual([]);
    await c.req("browser.close", { projectId });
  });
});
