// Bağlantılar: `browser.openUrl` — a link the user chose in a terminal opens in the project's Chrome. Real engine +
// REAL headless Chrome (temp profile, mock keychain) against a local test server: the browser is started when it
// is not running, the address gets a tab of its own and that tab is the active one, nothing already open is
// replaced, and only http(s) is ever opened. The request answers once the tab exists; the page loads afterwards. Chrome's own page list and the test server's request log are the
// witnesses, not only what the engine says.
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
const BLANK = "about:blank";
const LOOPBACK = "127.0.0.1";
const WAIT_MS = 15_000;
/** Must never show up in the engine's log. */
const SECRET = "GIZLI_BELIRTEC_7f3a";
const LOG = { chromeStarted: "chrome started", linkOpened: "browser link opened" };
const FAILURE_LOG_TAIL_CHARS = 6_000;

let root: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let sitePort: number;
/** `host path` of every request the test page server got. */
const hits: string[] = [];
let c: Client;
/** The first step's project: its Chrome is up and has loaded pages, so later steps need not wait for a fresh one. */
let firstProject: string;

function ourChromePids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

type LogLine = { msg: string; projectId?: string; port?: number; origin?: string };
function logLines(msg: string, projectId: string): LogLine[] {
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

/** The pages Chrome itself has right now, asked from Chrome — not from the engine. */
async function chromePages(projectId: string): Promise<{ id: string; url: string }[]> {
  const port = logLines(LOG.chromeStarted, projectId).at(-1)!.port!;
  const res = await fetch(`http://${LOOPBACK}:${port}/json/list`);
  const list = (await res.json()) as { id: string; type: string; url: string }[];
  return list.filter((t) => t.type === "page").map((t) => ({ id: t.id, url: t.url }));
}

async function project(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  mkdirSync(join(root, name));
  return (await c.req<{ project: { id: string } }>("projects.create", { name, location: { kind: "local", path: join(root, name) }, ...extra })).project.id;
}
const state = async (projectId: string): Promise<BrowserState> => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;
const openUrl = async (projectId: string, url: string): Promise<BrowserState> => (await c.req<{ browser: BrowserState }>("browser.openUrl", { projectId, url })).browser;
const urls = (s: BrowserState): string[] => s.tabs.map((t) => t.url);
const activeUrl = (s: BrowserState): string | undefined => s.tabs.find((t) => t.id === s.activeTabId)?.url;
/** Waits until the engine reports the active tab at `url` (a navigation takes a moment to show in the tab list). */
async function activeIs(projectId: string, url: string): Promise<BrowserState> {
  let last: BrowserState | undefined;
  await expect.poll(async () => activeUrl((last = await state(projectId))), { timeout: WAIT_MS, message: `active tab at ${url}` }).toBe(url);
  return last!;
}
/** The test page server was asked for `path` with this Host header (the page really loaded, from where it should). */
const loaded = (host: string, path: string): Promise<void> => expect.poll(() => hits.includes(`${host} ${path}`), { timeout: WAIT_MS, message: `${host} ${path} requested` }).toBe(true);
const refusal = async (work: Promise<unknown>): Promise<string | undefined> =>
  work.then(
    () => undefined,
    (err: unknown) => (err as { code?: string }).code,
  );

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-open-url-")));
  const configPath = join(root, "engine.json");
  const cdpPortBase = 52000 + Math.floor(Math.random() * 20) * 100;
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
    hits.push(`${req.headers.host ?? ""} ${req.url ?? ""}`);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Sayfa ${req.url ?? ""}</title><body><h1>${(req.url ?? "").replace(/[<>&]/g, "")}</h1></body>`);
  });
  await new Promise<void>((r) => site.listen(0, LOOPBACK, () => r()));
  sitePort = (site.address() as net.AddressInfo).port;
  siteUrl = `http://${LOOPBACK}:${sitePort}`;
  mkdirSync(join(root, "home"));
  // A HOME of its own: the engine under test never reads the user's ~/.claude or ~/.ssh.
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home") });
  c = await Client.connect(engine.port, KEY);
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

describe.skipIf(!haveChrome)("Bağlantılar: browser.openUrl gerçek Chrome'da", { timeout: 120_000 }, () => {
  afterEach((ctx) => {
    if (ctx.task.result?.state !== "fail" || !engine) return;
    console.warn(`[e2e] "${ctx.task.name}" failed; engine log tail:\n${engine.logs().slice(-FAILURE_LOG_TAIL_CHARS)}`);
  });

  it("starts the project's Chrome and shows the link in its only tab; a second link gets a tab of its own", async () => {
    const projectId = (firstProject = await project("ilk"));
    expect((await state(projectId)).running).toBe(false);

    const first = await openUrl(projectId, `${siteUrl}/bir`);
    expect(first.running).toBe(true);
    const afterFirst = await activeIs(projectId, `${siteUrl}/bir`);
    // The blank tab of the Chrome this request started is gone: no empty tab is left behind.
    expect(urls(afterFirst)).toEqual([`${siteUrl}/bir`]);
    await loaded(`${LOOPBACK}:${sitePort}`, "/bir");

    await openUrl(projectId, `${siteUrl}/iki?x=1&belirtec=${SECRET}#parca`);
    const afterSecond = await activeIs(projectId, `${siteUrl}/iki?x=1&belirtec=${SECRET}#parca`);
    // The first page is still there, untouched, and is no longer the active one.
    expect(urls(afterSecond)).toEqual([`${siteUrl}/bir`, `${siteUrl}/iki?x=1&belirtec=${SECRET}#parca`]);
    expect(afterSecond.activeTabId).toBe(afterSecond.tabs[1]!.id);
    await expect.poll(async () => (await chromePages(projectId)).map((p) => p.url).sort(), { timeout: WAIT_MS }).toEqual([`${siteUrl}/bir`, `${siteUrl}/iki?x=1&belirtec=${SECRET}#parca`].sort());
  });

  it("a Chrome that was already open keeps its tabs — a blank one too — and the link becomes the active tab", async () => {
    const projectId = await project("acik");
    const opened = (await c.req<{ browser: BrowserState }>("browser.open", { projectId })).browser;
    expect(urls(opened)).toEqual([BLANK]);
    await c.req("browser.navigate", { projectId, url: `${siteUrl}/kullanicinin-sayfasi` });
    await activeIs(projectId, `${siteUrl}/kullanicinin-sayfasi`);

    await openUrl(projectId, `${siteUrl}/baglanti`);
    const after = await activeIs(projectId, `${siteUrl}/baglanti`);
    expect(urls(after)).toEqual([`${siteUrl}/kullanicinin-sayfasi`, `${siteUrl}/baglanti`]);

    // A running Chrome with nothing but a blank tab: the blank tab may be an agent's, it is not taken.
    const blankId = await project("bos");
    await c.req("browser.open", { projectId: blankId });
    await openUrl(blankId, `${siteUrl}/bos-yanina`);
    const blankAfter = await activeIs(blankId, `${siteUrl}/bos-yanina`);
    expect(urls(blankAfter)).toEqual([BLANK, `${siteUrl}/bos-yanina`]);
  });

  it("a dev server's localhost address opens on the engine machine's Chrome", async () => {
    const projectId = await project("yerel");
    await openUrl(projectId, `http://localhost:${sitePort}/yerel`);
    await activeIs(projectId, `http://localhost:${sitePort}/yerel`);
    await loaded(`localhost:${sitePort}`, "/yerel");
  });

  it("two links at once on a closed browser: one Chrome, both pages, nothing lost", async () => {
    const projectId = await project("ayni-anda");
    await Promise.all([openUrl(projectId, `${siteUrl}/a`), openUrl(projectId, `${siteUrl}/b`)]);
    await expect.poll(async () => urls(await state(projectId)).sort(), { timeout: WAIT_MS }).toEqual([`${siteUrl}/a`, `${siteUrl}/b`]);
    expect(logLines(LOG.chromeStarted, projectId)).toHaveLength(1);
    await expect.poll(async () => (await chromePages(projectId)).map((p) => p.url).sort(), { timeout: WAIT_MS }).toEqual([`${siteUrl}/a`, `${siteUrl}/b`]);
    // Chrome shows a tab's URL before its request reaches the server; wait for both requests so they cannot land in
    // the next test's "nothing was requested" window.
    await loaded(`${LOOPBACK}:${sitePort}`, "/a");
    await loaded(`${LOOPBACK}:${sitePort}`, "/b");
  });

  it("nothing but http(s) is opened: the request is refused and the tabs stay as they were", async () => {
    const projectId = firstProject;
    const before = await state(projectId);
    expect(before.tabs.length).toBeGreaterThan(0);
    const hitsBefore = hits.length;
    for (const url of ["javascript:document.title='x'", "file:///etc/hosts", "about:blank", "chrome://version", "data:text/html,<p>x</p>", "vscode://file/x", `http://u:p@${LOOPBACK}:${sitePort}/kimlikli`, `${siteUrl}/bos luk`]) {
      expect(await refusal(openUrl(projectId, url)), url).toBe("INVALID");
    }
    const after = await state(projectId);
    expect(after.tabs.map((t) => [t.id, t.url])).toEqual(before.tabs.map((t) => [t.id, t.url]));
    expect(after.activeTabId).toBe(before.activeTabId);
    expect(hits.slice(hitsBefore).filter((h) => !h.endsWith(" /favicon.ico"))).toEqual([]);
    expect((await chromePages(projectId)).map((p) => p.url).sort()).toEqual(urls(before).sort());
  });

  it("a project whose browser opens on the app's machine is refused, and no Chrome is started for it", async () => {
    const projectId = await project("istemci", { browser: { runOn: "client" } });
    expect(await refusal(openUrl(projectId, `${siteUrl}/istemci`))).toBe("INVALID");
    expect((await state(projectId)).running).toBe(false);
    expect(logLines(LOG.chromeStarted, projectId)).toEqual([]);
    expect(hits.some((h) => h.endsWith(" /istemci"))).toBe(false);
  });

  it("the engine's log names the origin of an opened link, never its path or query", () => {
    const log = engine!.logs();
    expect(log).toContain(`"${LOG.linkOpened}"`);
    expect(log).toContain(`"origin":"${siteUrl}"`);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain("/kullanicinin-sayfasi");
    expect(log).not.toContain("/baglanti");
  });
});
