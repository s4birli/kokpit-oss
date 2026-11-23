// Closing tabs, one after the other, as fast as the engine answers: every close takes exactly ONE tab away — the
// one asked for — and the blank replacement appears only when the last tab goes. Real engine + REAL headless Chrome
// (temp profile, mock keychain), with a viewer subscribed like the app's panel (so closing the active tab takes the
// real path: the neighbour is attached, sized and screencast before the tab is closed). Chrome's own page list
// (its DevTools HTTP endpoint) is the witness, not only what the engine says.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserState } from "@kokpit/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string };
};
const haveChrome = existsSync(defaults.browser.chromePath);
/** Tabs opened (and then closed) per round. */
const TABS = 8;
const PANEL = { width: 644, height: 380 };
const BLANK = "about:blank";
const LOOPBACK = "127.0.0.1";
/** The engine's log messages about tabs (src/browser.ts, TAB_LOG). */
const LOG = { closeAsked: "browser tab close asked", destroyed: "browser tab destroyed", chromeStarted: "chrome started" };

let root: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
/** A second connection that keeps asking for the tab list while tabs close (the app refetches on every change). */
let watcher: Client;
let projectId: string;

function ourChromePids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

type LogLine = { msg: string; projectId?: string; tabId?: string; port?: number; pid?: number };
function logLines(msg: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of engine!.logs().split("\n")) {
    if (!line.includes(`"${msg}"`)) continue;
    try {
      const entry = JSON.parse(line) as LogLine;
      if (entry.msg === msg && entry.projectId === projectId) out.push(entry);
    } catch {
      /* a partial line */
    }
  }
  return out;
}

const ids = (s: BrowserState): string[] => s.tabs.map((t) => t.id);
const state = async (who: Client = c): Promise<BrowserState> => (await who.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;
const closeTab = async (tabId: string): Promise<BrowserState> => (await c.req<{ browser: BrowserState }>("browser.closeTab", { projectId, tabId })).browser;

/** The pages Chrome itself has right now (ids), asked from Chrome — not from the engine. */
async function chromePages(): Promise<string[]> {
  const port = logLines(LOG.chromeStarted).at(-1)!.port!;
  const res = await fetch(`http://${LOOPBACK}:${port}/json/list`);
  const list = (await res.json()) as { id: string; type: string }[];
  return list.filter((t) => t.type === "page").map((t) => t.id);
}

/** Waits until Chrome's own page list is `want` (any order); closing is asynchronous on Chrome's side. */
async function chromeHas(want: string[], what: string): Promise<void> {
  const sorted = [...want].sort();
  await expect.poll(async () => (await chromePages()).sort(), { timeout: 10_000, message: what }).toEqual(sorted);
}

/** Opens the project's Chrome with TABS tabs (the first blank, the others on a page), a viewer watching. Returns their ids in order. */
async function openTabs(name: string): Promise<string[]> {
  // A project (and so a Chrome profile) of its own: nothing restored from an earlier round.
  mkdirSync(join(root, name));
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name, location: { kind: "local", path: join(root, name) } })).project.id;
  await c.req("browser.viewport.set", { projectId, ...PANEL, interaction: true });
  await c.req("browser.open", { projectId });
  await c.req("browser.screencast.start", { projectId, maxWidth: PANEL.width * 2, maxHeight: PANEL.height * 2, quality: 70 });
  // Chrome's own first tab stays blank; the others are opened on their page ("+" with a URL).
  for (let n = 2; n <= TABS; n++) await c.req("browser.newTab", { projectId, url: `${siteUrl}/?n=${n}` });
  const opened = await state();
  expect(opened.tabs).toHaveLength(TABS);
  await chromeHas(ids(opened), "all tabs open in Chrome");
  return ids(opened);
}

/**
 * Keeps asking for the tab list until `stop()`; every answer is checked against what had been asked by the time it
 * arrived: no tab that nobody asked to close is ever missing, and a tab that is not one of ours (the blank
 * replacement) is listed only once the last close was asked.
 */
function watch(original: string[], asked: Set<string>): { stop: () => Promise<string[]> } {
  const bad: string[] = [];
  let run = true;
  const loop = (async () => {
    while (run) {
      const seen = ids(await state(watcher));
      const missing = original.filter((id) => !asked.has(id) && !seen.includes(id));
      const extra = seen.filter((id) => !original.includes(id));
      if (missing.length > 0) bad.push(`after ${asked.size} closes asked, ${missing.length} un-asked tab(s) missing: ${missing.join(",")}`);
      if (extra.length > 0 && asked.size < original.length) bad.push(`a tab nobody opened is listed after only ${asked.size} closes: ${extra.join(",")}`);
      if (extra.length > 1) bad.push(`more than one replacement tab: ${extra.join(",")}`);
    }
  })();
  return {
    stop: async () => {
      run = false;
      await loop;
      return bad;
    },
  };
}

/** After every tab of ours is closed: one blank tab, in the engine and in Chrome; returns it. */
async function onlyBlankLeft(original: string[]): Promise<string> {
  const end = await state();
  expect(end.tabs).toHaveLength(1);
  expect(original).not.toContain(end.tabs[0]!.id);
  expect(end.tabs[0]!.url).toBe(BLANK);
  expect(end.activeTabId).toBe(end.tabs[0]!.id);
  await chromeHas(ids(end), "only the blank tab is left in Chrome");
  return end.tabs[0]!.id;
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-tab-close-")));
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
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 100 },
    }),
  );
  site = http.createServer((req, res) => {
    const n = new URL(req.url ?? "/", "http://x").searchParams.get("n") ?? "0";
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Sekme ${Number(n) || 0}</title><body style="margin:0;background:#bfdbfe"><h1>${Number(n) || 0}</h1></body>`);
  });
  await new Promise<void>((r) => site.listen(0, LOOPBACK, () => r()));
  siteUrl = `http://${LOOPBACK}:${(site.address() as net.AddressInfo).port}`;
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY });
  c = await Client.connect(engine.port, KEY);
  // Like the app's panel: every frame is acknowledged as soon as it arrives (the engine sends the next one then).
  c.ws.on("message", (data) => {
    const text = data.toString();
    if (!text.includes('"browser.frame"')) return;
    const frame = JSON.parse(text) as { type?: string; projectId?: string; frameId?: number };
    if (frame.type === "browser.frame") c.ws.send(JSON.stringify({ type: "browser.ack", projectId: frame.projectId, frameId: frame.frameId }));
  });
  watcher = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  await watcher?.close();
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

/** How much of the engine's log a failed step prints (its tail: tab lines, warnings, errors). */
const FAILURE_LOG_TAIL_CHARS = 6_000;

describe.skipIf(!haveChrome)("Tarayıcı sekmelerini art arda kapatma: her istek tam bir sekme kapatır", { timeout: 120_000 }, () => {
  afterEach((ctx) => {
    if (ctx.task.result?.state !== "fail" || !engine) return;
    console.warn(`[e2e] "${ctx.task.name}" failed; engine log tail:\n${engine.logs().slice(-FAILURE_LOG_TAIL_CHARS)}`);
  });

  /** Closes `original` one by one in the order `pick` chooses, checking after each close. */
  async function closeOneByOne(original: string[], pick: (s: BrowserState) => string): Promise<void> {
    const asked = new Set<string>();
    const watching = watch(original, asked);
    const bad: string[] = [];
    try {
      let now = await state();
      while (asked.size < original.length) {
        const id = pick(now);
        const wasActive = now.activeTabId === id;
        const at = ids(now).indexOf(id);
        const rest = ids(now).filter((t) => t !== id);
        asked.add(id);
        const after = await closeTab(id);
        const step = `close ${asked.size} of ${original.length} (${wasActive ? "active" : "background"} tab)`;
        if (rest.length === 0) break;
        // The answer, a fresh list and Chrome itself: exactly that one tab is gone, nothing was added.
        if (ids(after).join() !== rest.join()) bad.push(`${step}: the answer lists [${ids(after).join()}], expected [${rest.join()}]`);
        const fresh = await state();
        if (ids(fresh).join() !== rest.join()) bad.push(`${step}: the engine lists [${ids(fresh).join()}], expected [${rest.join()}]`);
        await chromeHas(rest, `${step}: Chrome's pages`);
        // As in Chrome: the tab to the right of a closed active tab takes over, else the one to the left.
        const heir = wasActive ? (ids(now)[at + 1] ?? ids(now)[at - 1]) : now.activeTabId;
        if (after.activeTabId !== heir) bad.push(`${step}: active is ${after.activeTabId}, expected ${heir}`);
        now = fresh;
      }
    } finally {
      bad.push(...(await watching.stop()));
    }
    expect(bad).toEqual([]);
  }

  it(`closing ${TABS} tabs from the front: one tab per close; the blank tab only after the last`, async () => {
    const original = await openTabs("bastan");
    const before = { asked: logLines(LOG.closeAsked).length, destroyed: logLines(LOG.destroyed).length };
    const chrome = logLines(LOG.chromeStarted);
    expect(chrome).toHaveLength(1);
    await closeOneByOne(original, (s) => s.tabs[0]!.id);
    await onlyBlankLeft(original);
    // One close asked and one tab destroyed per tab — the engine's own account of it.
    expect(logLines(LOG.closeAsked).slice(before.asked).map((l) => l.tabId)).toEqual(original);
    expect(logLines(LOG.destroyed).slice(before.destroyed).map((l) => l.tabId)).toEqual(original);
    // The same Chrome is still running: started once, and alive.
    expect(logLines(LOG.chromeStarted)).toEqual(chrome);
    expect(() => process.kill(chrome[0]!.pid!, 0)).not.toThrow();
    await c.req("browser.close", { projectId });
  });

  it(`closing the ACTIVE tab ${TABS} times: the neighbour takes over each time, nothing else goes`, async () => {
    const original = await openTabs("etkin");
    // Start in the middle, so the takeover goes right first and left once the right side is used up.
    await c.req("browser.selectTab", { projectId, tabId: original[Math.floor(TABS / 2)]! });
    await closeOneByOne(original, (s) => s.activeTabId!);
    await onlyBlankLeft(original);
    await c.req("browser.close", { projectId });
  });

  it(`${TABS} closes sent at once (no waiting for answers): every tab closes once, one blank tab is left`, async () => {
    const original = await openTabs("toplu");
    const before = logLines(LOG.destroyed).length;
    const asked = new Set<string>(original);
    const watching = watch(original, asked);
    const answers = await Promise.allSettled(original.map((id) => closeTab(id)));
    const bad = await watching.stop();
    expect(answers.map((a) => a.status)).toEqual(original.map(() => "fulfilled"));
    expect(bad).toEqual([]);
    await onlyBlankLeft(original);
    expect(
      logLines(LOG.destroyed)
        .slice(before)
        .map((l) => l.tabId)
        .sort(),
    ).toEqual([...original].sort());
    await c.req("browser.close", { projectId });
  });

  it("the same tab closed twice at once (a double click on ×): one tab goes, not two", async () => {
    const original = await openTabs("cift");
    // Once on the active tab (the slow path: the neighbour is brought to the front first), once on a background one.
    const active = (await state()).activeTabId!;
    const background = original[0]!;
    expect(background).not.toBe(active);
    for (const id of [active, background]) {
      const rest = ids(await state()).filter((t) => t !== id);
      // Both get the same answer (no error for the second click), and it is "that one tab is gone".
      const answers = await Promise.all([closeTab(id), closeTab(id)]);
      expect(answers.map(ids)).toEqual([rest, rest]);
      expect(ids(await state())).toEqual(rest);
      await chromeHas(rest, "Chrome's pages after a double close");
    }
    // And the last tab, twice: still exactly one replacement.
    const left = ids(await state());
    for (const id of left.slice(1)) await closeTab(id);
    const [first, second] = await Promise.all([closeTab(left[0]!), closeTab(left[0]!)]);
    expect(first.tabs.map((t) => t.url)).toEqual([BLANK]);
    expect(ids(second)).toEqual(ids(first));
    await onlyBlankLeft(original);
    // A tab that is gone is still "not found" afterwards — only a close under way is joined.
    await expect(closeTab(left[0]!)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await c.req("browser.close", { projectId });
  });
});
