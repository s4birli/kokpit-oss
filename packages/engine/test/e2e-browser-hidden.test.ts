// Gizli tarayıcı: a project's Chrome runs hidden by default — no window on the engine Mac's screen, no Dock icon,
// never the frontmost app — while the panel (screencast + input), zoom/viewport, extensions, the agent's DevTools
// port and pages that open windows keep working. Real engine, REAL Chrome in production mode (headless: false)
// with a temp profile and the mock keychain (testMode). The window server is read with JXA (CGWindowList: bounds
// and owner only); without it those checks are skipped with a message.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserExtension, BrowserFrameMessage, BrowserState } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectCdp } from "../src/cdp.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 20_000;
const FIXTURE = fileURLToPath(new URL("./fixtures/ext-marker", import.meta.url));
const WINDOW_LIST = fileURLToPath(new URL("./fixtures/window-list.js", import.meta.url));
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; profilesDirName: string };
};
const haveChrome = existsSync(defaults.browser.chromePath);
/** NSApplicationActivationPolicyRegular: a Dock icon, a menu bar, Cmd-Tab. */
const POLICY_REGULAR = 0;

let root: string;
let dataDir: string;
let configPath: string;
let extDir: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;
let windowServer = true;

const env = () => ({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
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

interface WindowInfo {
  windows: { w: number; h: number; onscreen: boolean }[];
  app: { policy: number; hidden: boolean; active: boolean } | null;
  frontPid: number;
}

function windowsOf(pid: number): WindowInfo | null {
  if (!windowServer) return null;
  try {
    return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", WINDOW_LIST, String(pid)], { encoding: "utf8" })) as WindowInfo;
  } catch (err) {
    windowServer = false;
    console.warn(`window list unavailable to this process; on-screen checks skipped: ${(err as Error).message}`);
    return null;
  }
}

/** Gives the focus back to the app the user had in front (a visible Chrome takes it when it starts). */
function activate(pid: number): void {
  try {
    execFileSync("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions(2); ""`]);
  } catch {
    /* best effort */
  }
}

function psLines(): string[] {
  return execFileSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8" }).split("\n");
}

/** Our Chrome's browser process (not a helper) and its command line. */
function mainChrome(): { pid: number; command: string } {
  const profile = join(dataDir, defaults.browser.profilesDirName, projectId);
  const line = psLines().find((l) => l.includes(`--user-data-dir=${profile} `) && !l.includes("--type="));
  expect(line, "project chrome running").toBeDefined();
  return { pid: Number(line!.trim().split(/\s+/)[0]), command: line! };
}

function ourChromePids(): number[] {
  return psLines()
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Nothing of the Chrome process is on the screen, it has no Dock icon/menu bar, and it is not in front. */
function expectInvisible(what: string): void {
  const { pid } = mainChrome();
  const info = windowsOf(pid);
  if (!info) return;
  expect(info.windows.filter((w) => w.onscreen && w.w > 1 && w.h > 1), `${what}: on-screen windows`).toEqual([]);
  expect(info.app?.policy, `${what}: activation policy`).not.toBe(POLICY_REGULAR);
  expect(info.frontPid, `${what}: frontmost app`).not.toBe(pid);
}

const tabs = async (): Promise<BrowserState> => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;

async function pageEval(expression: string): Promise<unknown> {
  const port = Number(/--remote-debugging-port=(\d+)/.exec(mainChrome().command)![1]);
  const state = await tabs();
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
  const page = list.find((t) => t.id === state.activeTabId);
  expect(page, "active tab in /json/list").toBeDefined();
  const cdp = await connectCdp(page!.webSocketDebuggerUrl, { timeoutMs: 5000 });
  try {
    const r = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true });
    return r.result.value;
  } finally {
    cdp.close();
  }
}

const frames = (): BrowserFrameMessage[] =>
  c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame" && f.projectId === projectId);

/** A frame newer than `afterId` matching `pred`, acking the newest one on the way (as the app does). */
function nextFrame(afterId: number, pred: (f: BrowserFrameMessage) => boolean = () => true): Promise<BrowserFrameMessage> {
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
const lastFrameId = () => frames().at(-1)?.frameId ?? 0;

function input(event: Record<string, unknown>): void {
  c.ws.send(JSON.stringify({ type: "browser.input", projectId, event }));
}

async function visit(path: string): Promise<void> {
  await c.req("browser.navigate", { projectId, url: `${siteUrl}${path}` });
  await until(tabs, (s) => s.tabs.some((t) => t.id === s.activeTabId && t.url.endsWith(path) && t.title !== ""), `page ${path}`);
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-hidden-")));
  dataDir = join(root, "data");
  mkdirSync(join(root, "proj"));
  extDir = join(root, "ext", "marker");
  mkdirSync(join(root, "ext"));
  cpSync(FIXTURE, extDir, { recursive: true });
  configPath = join(root, "engine.json");
  const cdpPortBase = 44000 + Math.floor(Math.random() * 20) * 100;
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
      // Production mode (no test headless): the project's window setting decides; testMode = mock keychain.
      browser: { headless: false, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 100 },
    }),
  );
  site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const path = (req.url ?? "/").replace(/[^a-z0-9/]/g, "");
    res.end(`<!doctype html><title>${path}</title><body style="margin:0">
<button id=b style="position:absolute;left:0;top:0;width:200px;height:100px" onclick="this.dataset.n=(+(this.dataset.n||0)+1)">b</button>
<input id=i style="position:absolute;left:0;top:150px;width:200px;height:40px">
<a id=pop href="#" style="position:absolute;left:0;top:250px;width:200px;height:60px;display:block"
  onclick="event.preventDefault();window.open('/acilan','_blank','popup,width=400,height=300')">aç</a>
<script>window.frames_=0;(function f(){frames_++;requestAnimationFrame(f)})();</script></body>`);
  });
  await new Promise<void>((r) =>
    site.listen(0, "127.0.0.1", () => {
      siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
      r();
    }),
  );
  engine = await startEngine(env());
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Gizli", location: { kind: "local", path: join(root, "proj") } }))
    .project.id;
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  await c?.close();
  await stopEngine(engine);
  if (process.env.KOKPIT_E2E_LOG && engine) writeFileSync(process.env.KOKPIT_E2E_LOG, engine.logs());
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

describe.skipIf(!haveChrome)("Gizli tarayıcı: the project's Chrome never shows on the engine Mac's screen", { timeout: 120_000 }, () => {
  it("a new project's browser starts hidden: headless with the real-keychain flags left alone, a normal User-Agent", async () => {
    await c.req("browser.open", { projectId });
    const { command } = mainChrome();
    expect(command).toContain("--headless=new");
    expect(command).not.toMatch(/HeadlessChrome/);
    await visit("/bir");
    const ua = (await pageEval("navigator.userAgent")) as string;
    expect(ua).toMatch(/ Chrome\/\d+\.0\.0\.0 /);
    expect(ua).not.toMatch(/Headless/);
    expect(await pageEval("String(navigator.webdriver)")).toBe("false");
    // The page runs as in a visible, focused window.
    expect(await pageEval("document.visibilityState")).toBe("visible");
    const raf0 = (await pageEval("frames_")) as number;
    await sleep(500);
    expect(((await pageEval("frames_")) as number) - raf0).toBeGreaterThan(10);
    expectInvisible("after start");
  });

  it("the panel works: frames arrive at the panel's size, zoom applies, a click and typing land", async () => {
    await c.req("browser.zoom.set", { projectId, zoom: 1, mode: "user" });
    await c.req("browser.viewport.set", { projectId, width: 800, height: 500, interaction: true });
    await c.req("browser.screencast.start", { projectId, maxWidth: 800, maxHeight: 500, quality: 60 });
    const f = await nextFrame(0, (x) => x.metadata.deviceWidth === 800 && x.metadata.deviceHeight === 500);
    expect(Buffer.from(f.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(await pageEval("innerWidth + 'x' + innerHeight")).toBe("800x500");
    await c.req("browser.zoom.set", { projectId, zoom: 2, mode: "user" });
    await until(() => pageEval("innerWidth + 'x' + innerHeight"), (v) => v === "400x250", "zoom 2 → 400x250");
    await c.req("browser.zoom.set", { projectId, zoom: 1, mode: "user" });
    await until(() => pageEval("innerWidth"), (v) => v === 800, "zoom back to 1");

    input({ type: "mouse", action: "down", x: 50, y: 50, button: "left", clickCount: 1 });
    input({ type: "mouse", action: "up", x: 50, y: 50, button: "left", clickCount: 1 });
    await until(() => pageEval("b.dataset.n ?? null"), (v) => v === "1", "click landed");
    input({ type: "mouse", action: "down", x: 50, y: 170, button: "left", clickCount: 1 });
    input({ type: "mouse", action: "up", x: 50, y: 170, button: "left", clickCount: 1 });
    await c.req("browser.paste", { projectId, text: "çğış" });
    await until(() => pageEval("i.value"), (v) => v === "çğış", "typed text landed");
    expectInvisible("after input");
  });

  it("an unpacked extension loads and its content script runs", async () => {
    const r = await c.req<{ extensions: BrowserExtension[] }>("browser.extensions.loadUnpacked", { projectId, path: extDir });
    expect(r.extensions[0]?.loaded).toBe(true);
    await visit("/iki");
    await until(() => pageEval("document.body.dataset.kokpitExt ?? null"), (v) => v === "1", "content script ran");
  });

  it("new tabs (panel, link) and a window the page opens stay hidden; nothing comes to the front", async () => {
    const before = (await tabs()).tabs.length;
    await c.req("browser.newTab", { projectId, url: `${siteUrl}/yeni` });
    await c.req("browser.openUrl", { projectId, url: `${siteUrl}/baglanti` });
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/uc` });
    await until(tabs, (s) => s.tabs.some((t) => t.id === s.activeTabId && t.title === "/uc"), "page /uc");
    // The page's own window.open (a pop-up window in a visible Chrome) after a real click.
    input({ type: "mouse", action: "down", x: 50, y: 280, button: "left", clickCount: 1 });
    input({ type: "mouse", action: "up", x: 50, y: 280, button: "left", clickCount: 1 });
    await until(tabs, (s) => s.tabs.some((t) => t.title === "/acilan"), "pop-up listed as a tab");
    expect((await tabs()).tabs.length).toBeGreaterThanOrEqual(before + 3);
    await sleep(500);
    expectInvisible("after new tabs and a page's window.open");
    // Tab switches (Page.bringToFront / Target.activateTarget) bring nothing to the front either.
    for (const t of (await tabs()).tabs.slice(0, 3)) await c.req("browser.selectTab", { projectId, tabId: t.id });
    expectInvisible("after tab switches");
  });

  it("showWindow is refused while hidden (there is no window to bring forward)", async () => {
    await expect(c.req("browser.showWindow", { projectId })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("switching to visible and back restarts Chrome in that mode; tabs come back and the panel keeps its frames", async () => {
    const urls = (s: BrowserState) => s.tabs.map((t) => t.url).sort();
    const want = urls(await tabs());
    const front = windowsOf(process.pid)?.frontPid;
    const hiddenPid = mainChrome().pid;

    await c.req("projects.update", { projectId, browser: { runOn: "engine", window: "visible" } });
    await until(() => psLines().some((l) => l.startsWith(` ${hiddenPid} `) || l.trim().startsWith(`${hiddenPid} `)), (v) => !v, "hidden chrome gone", WAIT_MS);
    await until(tabs, (s) => s.running && urls(s).length === want.length, "visible chrome with its tabs");
    try {
      const visible = mainChrome();
      expect(visible.command).not.toContain("--headless");
      expect(urls(await tabs())).toEqual(want);
      if (windowServer) expect(windowsOf(visible.pid)?.windows.some((w) => w.onscreen)).toBe(true);
      // The panel's screencast carried over to the new Chrome without asking again.
      await nextFrame(lastFrameId());
    } finally {
      if (front !== undefined && front > 0) activate(front);
    }

    const visiblePid = mainChrome().pid;
    await c.req("projects.update", { projectId, browser: { runOn: "engine", window: "hidden" } });
    await until(() => psLines().some((l) => l.trim().startsWith(`${visiblePid} `)), (v) => !v, "visible chrome gone", WAIT_MS);
    await until(tabs, (s) => s.running && urls(s).length === want.length, "hidden chrome with its tabs");
    expect(mainChrome().command).toContain("--headless=new");
    expect(urls(await tabs())).toEqual(want);
    await nextFrame(lastFrameId());
    expectInvisible("back to hidden");
  });
});
