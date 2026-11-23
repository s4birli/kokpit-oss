// End-to-end for SPEC-adim-3-6 İş B "Bitti sayılır" 2 and 3 against the real engine and a REAL Chrome
// (config `browser.chromePath`), started by the engine headless (test-only `browser.headless`) under a temp
// dataDir. A local HTTP server provides the pages; a Playwright script run in the project's terminal is the
// agent that drives the same Chrome through KOKPIT_CDP_URL.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserFrameMessage, BrowserState, ServerMessage } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const DIMS = { cols: 120, rows: 30 };
const WAIT_MS = 20_000;
const AGENT_SCRIPT = fileURLToPath(new URL("./fixtures/cdp-agent.mjs", import.meta.url));
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; profilesDirName: string; projectId: string };
};
const CHROME = defaults.browser.chromePath;
const haveChrome = existsSync(CHROME);

let root: string;
let dataDir: string;
let configPath: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectA: string;
let projectB: string;

// Real HOME on purpose: Chrome must never run with a temp HOME (macOS keychain dialog); testMode mocks the keychain.
const env = () => ({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
const profile = (projectId: string) => join(dataDir, defaults.browser.profilesDirName, projectId);
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

/** Chrome processes (main + helpers) whose command line mentions our temp root. */
function ourChromePids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Command lines of the project's main Chrome processes (helpers carry --type=…). */
function mainChromes(projectId: string): string[] {
  const out = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes(`--user-data-dir=${profile(projectId)}`) && !l.includes("--type="));
}

function chromeCommandFor(projectId: string): string | undefined {
  return mainChromes(projectId)[0];
}

function frames(projectId: string): BrowserFrameMessage[] {
  return c.frames.filter((f): f is BrowserFrameMessage => f.type === "browser.frame" && f.projectId === projectId);
}

/** Waits for a frame newer than `afterId` matching `pred`, acking everything on the way (like the app). */
async function nextFrame(projectId: string, afterId: number, pred: (f: BrowserFrameMessage) => boolean = () => true) {
  return until(
    () => {
      const list = frames(projectId).filter((f) => f.frameId > afterId);
      // Ack the newest frame seen at all: an unacked older one would keep Chrome from sending more.
      const last = frames(projectId).at(-1);
      if (last) c.ws.send(JSON.stringify({ type: "browser.ack", projectId, frameId: last.frameId }));
      return list.find(pred);
    },
    (f) => f !== undefined,
    `frame of ${projectId} after ${afterId}`,
  ) as Promise<BrowserFrameMessage>;
}

const lastFrameId = (projectId: string) => frames(projectId).at(-1)?.frameId ?? 0;

async function tabs(projectId: string): Promise<BrowserState> {
  return (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;
}

async function waitTitle(projectId: string, re: RegExp): Promise<BrowserState> {
  return until(
    () => tabs(projectId),
    (s) => s.tabs.some((t) => t.id === s.activeTabId && re.test(t.title)),
    `title ${re} in ${projectId}`,
  );
}

function input(projectId: string, event: Record<string, unknown>): void {
  c.ws.send(JSON.stringify({ type: "browser.input", projectId, event }));
}

function startSite(): Promise<void> {
  site = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/page") {
      res.end(`<!doctype html><title>bekliyor</title><body style="margin:0;background:#fff">
<button id="b" style="position:fixed;inset:0;width:100%;height:100%;font-size:48px;border:0;background:#fff"
 onclick="document.title='clicked';this.textContent='TIKLANDI';this.style.background='rgb(20,160,60)'">tıkla</button></body>`);
      return;
    }
    if (url.pathname === "/set-cookie") {
      const v = (url.searchParams.get("v") ?? "").replace(/[^A-Za-z0-9]/g, "");
      res.setHeader("set-cookie", `sess=${v}; Max-Age=3600; Path=/; SameSite=Lax`);
      res.end(`<!doctype html><title>set ${v}</title>ok`);
      return;
    }
    if (url.pathname === "/title-later") {
      // Only document.title changes, later: no navigation, no load event.
      res.end(`<!doctype html><title>önce</title><body>bekle<script>setTimeout(()=>{document.title="sonra"},2000)</script></body>`);
      return;
    }
    if (url.pathname === "/tab") {
      // Adım 7 İş B: one page per tab, each a different color so frames of different tabs differ.
      const n = Number(url.searchParams.get("n") ?? "0") || 0;
      res.end(`<!doctype html><title>sekme ${n}</title><body style="margin:0;background:hsl(${(n * 37) % 360},70%,50%)"><h1>${n}</h1></body>`);
      return;
    }
    if (url.pathname === "/whoami") {
      const cookie = (req.headers.cookie ?? "").replace(/[^A-Za-z0-9=; ]/g, "");
      res.end(`<!doctype html><title>cookies:${cookie}</title>${cookie}`);
      return;
    }
    res.statusCode = 404;
    res.end("<!doctype html><title>yok</title>");
  });
  return new Promise((r) =>
    site.listen(0, "127.0.0.1", () => {
      siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
      r();
    }),
  );
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-browser-")));
  dataDir = join(root, "data");
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  configPath = join(root, "engine.json");
  // A random DevTools port range, so a parallel test engine never competes for the same preferred port.
  const cdpPortBase = 41000 + Math.floor(Math.random() * 20) * 500;
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
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 500, maxTabs: 20 },
    }),
  );
  await startSite();
  engine = await startEngine(env());
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectA = (await c.req<{ project: { id: string } }>("projects.create", { name: "Web A", location: { kind: "local", path: join(root, "a") } })).project.id;
  projectB = (await c.req<{ project: { id: string } }>("projects.create", { name: "Web B", location: { kind: "local", path: join(root, "b") } })).project.id;
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  await c?.close();
  await stopEngine(engine);
  // Debugging aid: KOKPIT_E2E_LOG=<file> keeps the last engine's log.
  if (process.env.KOKPIT_E2E_LOG && engine) writeFileSync(process.env.KOKPIT_E2E_LOG, engine.logs());
  // Safety net: no Chrome of ours survives the test.
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

describe.skipIf(!haveChrome)("İş B: browser end-to-end with a real Chrome", { timeout: 90_000 }, () => {
  it("the built-in browser project exists with its own folder", async () => {
    const { projects } = await c.req<{ projects: { id: string; builtin?: boolean; location: { path?: string } }[] }>("projects.list", {});
    const bp = projects.find((p) => p.id === defaults.browser.projectId);
    expect(bp?.builtin).toBe(true);
    expect(existsSync(bp!.location.path!)).toBe(true);
  });

  it("opens Chrome for a project: own profile, DevTools on 127.0.0.1 only", async () => {
    const r = await c.req<{ browser: BrowserState }>("browser.open", { projectId: projectA });
    expect(r.browser.running).toBe(true);
    expect(r.browser.tabs.length).toBeGreaterThanOrEqual(1);
    const cmd = chromeCommandFor(projectA);
    expect(cmd).toBeDefined();
    expect(cmd).toContain("--remote-debugging-address=127.0.0.1");
    expect(cmd).toContain("--headless=new");
    expect(cmd).toContain("--use-mock-keychain");
    expect(cmd).toContain("--password-store=basic");
    // Opening again reuses the same Chrome.
    await c.req("browser.open", { projectId: projectA });
    expect(mainChromes(projectA)).toHaveLength(1);
    const port = Number(/--remote-debugging-port=(\d+)/.exec(cmd!)![1]);
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (lan) {
      const reachable = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host: lan, port }, () => {
          s.destroy();
          resolve(true);
        });
        s.on("error", () => resolve(false));
        s.setTimeout(2000, () => {
          s.destroy();
          resolve(false);
        });
      });
      expect(reachable, `DevTools port ${port} must not answer on ${lan}`).toBe(false);
    }
  });

  it("navigates, streams frames, and a click through browser.input changes the page", async () => {
    await c.req("browser.navigate", { projectId: projectA, url: `${siteUrl}/page` });
    await waitTitle(projectA, /^bekliyor$/);
    await c.req("browser.screencast.start", { projectId: projectA, maxWidth: 800, maxHeight: 600, quality: 60 });
    const first = await nextFrame(projectA, 0);
    expect(first.data.length).toBeGreaterThan(100);
    expect(Buffer.from(first.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    expect(first.metadata.deviceWidth).toBeGreaterThan(0);

    const before = await nextFrame(projectA, 0, (f) => f.frameId === lastFrameId(projectA));
    const x = first.metadata.deviceWidth / 2;
    const y = first.metadata.deviceHeight / 2;
    input(projectA, { type: "mouse", action: "move", x, y });
    input(projectA, { type: "mouse", action: "down", x, y, button: "left", clickCount: 1 });
    input(projectA, { type: "mouse", action: "up", x, y, button: "left", clickCount: 1 });
    await waitTitle(projectA, /^clicked$/);
    await nextFrame(projectA, before.frameId, (f) => f.data !== before.data);
  });

  it("an agent in the project's terminal drives the same Chrome via KOKPIT_CDP_URL; the panel sees it", async () => {
    const { terminal } = await c.req<{ terminal: { id: string } }>("terminal.open", { projectId: projectA, ...DIMS, toolId: null });
    c.input(terminal.id, "echo CDP=$KOKPIT_CDP_URL\r");
    const out = await c.waitForOutput(terminal.id, /CDP=http:\/\/127\.0\.0\.1:\d+/, WAIT_MS);
    const cdpUrl = /CDP=(http:\/\/127\.0\.0\.1:\d+)/.exec(out)![1]!;
    expect(chromeCommandFor(projectA)).toContain(`--remote-debugging-port=${new URL(cdpUrl).port}`);

    const before = frames(projectA).at(-1)!;
    c.input(terminal.id, `'${process.execPath}' '${AGENT_SCRIPT}' /page AJAN-YAZDI\r`);
    await c.waitForOutput(terminal.id, /AGENT-OK/, 60_000);
    await waitTitle(projectA, /^AJAN-YAZDI$/);
    const after = await nextFrame(projectA, before.frameId, (f) => f.data !== before.data);
    expect(after.data).not.toBe(before.data);
    await c.req("terminal.close", { terminalId: terminal.id });
  });

  it("a title-only change (no navigation) is announced as browser.changed and shows in the tab list", async () => {
    await c.req("browser.navigate", { projectId: projectA, url: `${siteUrl}/title-later` });
    await waitTitle(projectA, /^önce$/);
    await sleep(300);
    const mark = c.frames.length;
    // No polling of browser.tabs here: only the engine's own event may tell us.
    await until(
      () => c.frames.slice(mark).some((f) => f.type === "event" && f.name === "browser.changed" && f.projectId === projectA),
      Boolean,
      "browser.changed after document.title changed",
      5000,
    );
    await waitTitle(projectA, /^sonra$/);
  });

  it("keyboard input types into a focused field", async () => {
    await c.req("browser.navigate", { projectId: projectA, url: `${siteUrl}/page` });
    await waitTitle(projectA, /^bekliyor$/);
    // Tab focuses the page's only button; Enter (sent as text "\r") presses it.
    input(projectA, { type: "key", action: "down", key: "Tab", code: "Tab", keyCode: 9 });
    input(projectA, { type: "key", action: "up", key: "Tab", code: "Tab", keyCode: 9 });
    input(projectA, { type: "key", action: "down", key: "Enter", code: "Enter", keyCode: 13 });
    input(projectA, { type: "key", action: "up", key: "Enter", code: "Enter", keyCode: 13 });
    await waitTitle(projectA, /^clicked$/);
  });

  it("back/forward/reload and tabs work", async () => {
    await c.req("browser.navigate", { projectId: projectA, url: `${siteUrl}/whoami?n=1` });
    await waitTitle(projectA, /^cookies:/);
    await c.req("browser.back", { projectId: projectA });
    await waitTitle(projectA, /^(bekliyor|clicked)$/);
    await c.req("browser.forward", { projectId: projectA });
    await waitTitle(projectA, /^cookies:/);
    const two = await c.req<{ browser: BrowserState }>("browser.newTab", { projectId: projectA, url: `${siteUrl}/page` });
    expect(two.browser.tabs.length).toBeGreaterThanOrEqual(2);
    await waitTitle(projectA, /^bekliyor$/);
    const first = two.browser.tabs.find((t) => t.id !== two.browser.activeTabId)!;
    const beforeSwitch = lastFrameId(projectA);
    await c.req("browser.selectTab", { projectId: projectA, tabId: first.id });
    await waitTitle(projectA, /^cookies:/);
    // The screencast moves to the selected tab: a new frame arrives for it.
    await nextFrame(projectA, beforeSwitch);
  });

  it("Adım 7: 10 tabs open, switching moves the screencast, closing works, the last tab is replaced by a blank one", async () => {
    const pc = (await c.req<{ project: { id: string } }>("projects.create", { name: "Web C", location: { kind: "local", path: join(root, "a") } })).project.id;
    const opened = await c.req<{ browser: BrowserState }>("browser.open", { projectId: pc });
    const initial = opened.browser.tabs.map((t) => t.id);
    await c.req("browser.screencast.start", { projectId: pc, maxWidth: 400, maxHeight: 300, quality: 50 });
    const ids: string[] = [];
    for (let n = 1; n <= 10; n++) {
      const r = await c.req<{ browser: BrowserState }>("browser.newTab", { projectId: pc, url: `${siteUrl}/tab?n=${n}` });
      ids.push(r.browser.activeTabId!);
    }
    expect(new Set(ids).size).toBe(10);
    const all = await until(
      () => tabs(pc),
      (s) => ids.every((id, i) => s.tabs.find((t) => t.id === id)?.title === `sekme ${i + 1}`),
      "10 tab titles",
    );
    expect(all.tabs.length).toBe(initial.length + 10);
    expect(all.activeTabId).toBe(ids[9]);

    // Switch around: each switch makes the selected tab active and brings a frame different from the last one.
    for (const i of [2, 7, 0, 9, 4]) {
      const before = await nextFrame(pc, 0, (f) => f.frameId === lastFrameId(pc));
      const r = await c.req<{ browser: BrowserState }>("browser.selectTab", { projectId: pc, tabId: ids[i]! });
      expect(r.browser.activeTabId).toBe(ids[i]);
      await nextFrame(pc, before.frameId, (f) => f.data !== before.data);
    }

    // Close the active tab (index 4): it disappears and another tab becomes active.
    const closed = await c.req<{ browser: BrowserState }>("browser.closeTab", { projectId: pc, tabId: ids[4]! });
    expect(closed.browser.tabs.map((t) => t.id)).not.toContain(ids[4]);
    expect(closed.browser.activeTabId).toBeDefined();
    expect(closed.browser.activeTabId).not.toBe(ids[4]);
    // Close a background tab: the active tab stays.
    const active = closed.browser.activeTabId!;
    const bg = ids.find((id) => id !== ids[4] && id !== active)!;
    const closedBg = await c.req<{ browser: BrowserState }>("browser.closeTab", { projectId: pc, tabId: bg });
    expect(closedBg.browser.activeTabId).toBe(active);
    expect(closedBg.browser.tabs.map((t) => t.id)).not.toContain(bg);
    // An unknown tab → NOT_FOUND.
    await expect(c.req("browser.closeTab", { projectId: pc, tabId: ids[4]! })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Close everything: Chrome keeps one blank tab, and it is active.
    let state = closedBg.browser;
    while (state.tabs.length > 1) {
      state = (await c.req<{ browser: BrowserState }>("browser.closeTab", { projectId: pc, tabId: state.tabs[0]!.id })).browser;
    }
    const last = state.tabs[0]!;
    const final = await c.req<{ browser: BrowserState }>("browser.closeTab", { projectId: pc, tabId: last.id });
    expect(final.browser.running).toBe(true);
    expect(final.browser.tabs).toHaveLength(1);
    expect(final.browser.tabs[0]!.id).not.toBe(last.id);
    expect(final.browser.tabs[0]!.url).toBe("about:blank");
    expect(final.browser.activeTabId).toBe(final.browser.tabs[0]!.id);
    // It stays that way (no late event brings the closed tab back or leaves zero pages).
    await sleep(500);
    const settled = await tabs(pc);
    expect(settled.tabs.map((t) => t.id)).toEqual([final.browser.tabs[0]!.id]);
    expect(mainChromes(pc)).toHaveLength(1);
    // Navigation still works on the replacement tab.
    await c.req("browser.navigate", { projectId: pc, url: `${siteUrl}/tab?n=42` });
    await waitTitle(pc, /^sekme 42$/);
  });

  it("Adım 7: the tab count is bounded by config (browser.maxTabs)", async () => {
    const pd = (await c.req<{ project: { id: string } }>("projects.create", { name: "Web D", location: { kind: "local", path: join(root, "b") } })).project.id;
    let s = (await c.req<{ browser: BrowserState }>("browser.open", { projectId: pd })).browser;
    while (s.tabs.length < 20) s = (await c.req<{ browser: BrowserState }>("browser.newTab", { projectId: pd })).browser;
    await expect(c.req("browser.newTab", { projectId: pd })).rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/20/) });
    expect((await tabs(pd)).tabs).toHaveLength(20);
    await c.req("browser.close", { projectId: pd });
  });

  it("two projects' profiles do not share cookies", async () => {
    await c.req("browser.navigate", { projectId: projectA, url: `${siteUrl}/set-cookie?v=PROJEA` });
    await waitTitle(projectA, /^set PROJEA$/);
    await c.req("browser.open", { projectId: projectB });
    await c.req("browser.navigate", { projectId: projectB, url: `${siteUrl}/whoami` });
    const b = await waitTitle(projectB, /^cookies:/);
    expect(b.tabs.find((t) => t.id === b.activeTabId)!.title).toBe("cookies:");
    await c.req("browser.navigate", { projectId: projectA, url: `${siteUrl}/whoami` });
    await waitTitle(projectA, /^cookies:sess=PROJEA$/);
    expect(chromeCommandFor(projectB)).toContain(`--user-data-dir=${profile(projectB)}`);
  });

  it("engine shutdown closes every Chrome; the profile persists across a restart", async () => {
    await c.close();
    await stopEngine(engine);
    await until(() => ourChromePids(), (p) => p.length === 0, "chrome processes gone after engine stop", 15_000);
    expect(existsSync(join(profile(projectA), "Default"))).toBe(true);

    engine = await startEngine(env());
    c = await Client.connect(engine.port, KEY);
    await c.req("browser.open", { projectId: projectA });
    await c.req("browser.navigate", { projectId: projectA, url: `${siteUrl}/whoami` });
    await waitTitle(projectA, /^cookies:sess=PROJEA$/);
  });

  it("browser.close stops that project's Chrome; frames stop; browser.changed is broadcast", async () => {
    const events: ServerMessage[] = [];
    const startIdx = c.frames.length;
    await c.req("browser.close", { projectId: projectA });
    await until(() => chromeCommandFor(projectA), (cmd) => cmd === undefined, "project A chrome gone", 15_000);
    events.push(...c.frames.slice(startIdx));
    await until(
      () => c.frames.slice(startIdx).some((f) => f.type === "event" && f.name === "browser.changed" && f.projectId === projectA),
      Boolean,
      "browser.changed after close",
    );
    expect((await tabs(projectA)).running).toBe(false);
    await expect(c.req("browser.navigate", { projectId: projectA, url: `${siteUrl}/page` })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
