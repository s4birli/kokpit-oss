// Gizli tarayıcı kimliği: a hidden Chrome presents the same identity as the same Chrome with no override — only the
// "Headless" token gone — in JavaScript (navigator.userAgent, userAgentData high-entropy values, also in a worker)
// and in the request headers (User-Agent, Sec-CH-UA-*), on the active tab, a new tab, a popup, the Masaüstü Chrome
// and a Chrome adopted by a restarted engine. Real engine, REAL Chrome in production mode (headless: false) with
// temp profiles and the mock keychain; only a local test site. The reference is a separate headless Chrome of the
// same executable, started by this test with no override.
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserState } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectCdp, type CdpConnection } from "../src/cdp.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 20_000;
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; profilesDirName: string };
};
const CHROME = defaults.browser.chromePath;
const haveChrome = existsSync(CHROME);
const HINTS = ["architecture", "bitness", "model", "platformVersion", "fullVersionList", "wow64"];
/** Every high-entropy hint the site asks for (sent from the next request to the origin on). */
const ACCEPT_CH = "Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-WoW64";

interface Brand {
  brand: string;
  version: string;
}
interface Ident {
  ua: string;
  platform: string;
  hi: { brands: Brand[]; mobile: boolean; platform: string; architecture: string; bitness: string; model: string; platformVersion: string; fullVersionList: Brand[]; wow64: boolean };
}

let root: string;
let dataDir: string;
let configPath: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;
let ref: Ident;
let refChrome: ChildProcess | undefined;
/** path → request headers of every request to it, in order. */
const hits = new Map<string, http.IncomingHttpHeaders[]>();

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

const IDENT = `(async () => ({ ua: navigator.userAgent, platform: navigator.platform, hi: await navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HINTS)}) }))()`;
const WORKER_IDENT = `new Promise((resolve) => { const w = new Worker("/w.js"); w.onmessage = (e) => resolve(e.data); })`;

function psLines(): string[] {
  return execFileSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8" }).split("\n");
}

/** The browser process (not a helper) running `profile`. */
function chromeOf(profile: string): { pid: number; port: number } {
  const line = psLines().find((l) => l.includes(`--user-data-dir=${profile} `) && !l.includes("--type="));
  expect(line, `chrome of ${profile}`).toBeDefined();
  return { pid: Number(line!.trim().split(/\s+/)[0]), port: Number(/--remote-debugging-port=(\d+)/.exec(line!)![1]) };
}
const projectProfile = () => join(dataDir, defaults.browser.profilesDirName, projectId);

function ourChromePids(): number[] {
  return psLines()
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** A page target of the Chrome on `port` whose URL ends with `path`, evaluated in. */
async function evalIn(port: number, path: string, expression: string): Promise<unknown> {
  const page = await until(
    async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { url: string; type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === "page" && t.url.endsWith(path)),
    (t) => t !== undefined,
    `target ${path}`,
  );
  const cdp = await connectCdp(page!.webSocketDebuggerUrl, { timeoutMs: 5000 });
  try {
    await until(
      // Chrome lists the tab's new address before the page commits: wait for the page itself.
      async () =>
        (await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: `location.href.endsWith(${JSON.stringify(path)}) && document.readyState === "complete"`, returnByValue: true }))
          .result.value,
      (v) => v === true,
      `${path} loaded`,
    );
    const r = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    expect(r.exceptionDetails, `evaluate in ${path}`).toBeUndefined();
    return r.result.value;
  } finally {
    cdp.close();
  }
}

const tabs = async (): Promise<BrowserState> => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;

async function visit(path: string): Promise<void> {
  await c.req("browser.navigate", { projectId, url: `${siteUrl}${path}` });
  await until(tabs, (s) => s.tabs.some((t) => t.id === s.activeTabId && t.url.endsWith(path) && t.title !== ""), `page ${path}`);
  await until(() => hits.get(path)?.length ?? 0, (n) => n > 0, `request ${path}`);
}

const fmt = (list: Brand[]) => list.map((b) => `"${b.brand}";v="${b.version}"`).join(", ");
const noHeadless = (list: Brand[]) => list.filter((b) => !b.brand.includes("Headless"));

/** The reference values with only the Headless token gone: what every hidden target must report. */
function expected(): Ident {
  return {
    ua: ref.ua.replace(/HeadlessChrome\//, "Chrome/"),
    platform: ref.platform,
    hi: { ...ref.hi, brands: noHeadless(ref.hi.brands), fullVersionList: noHeadless(ref.hi.fullVersionList) },
  };
}

function expectIdentity(got: Ident, what: string): void {
  const want = expected();
  expect(got.ua, `${what}: User-Agent`).toBe(want.ua);
  expect(got.ua, what).not.toMatch(/Headless/);
  expect(got.platform, `${what}: navigator.platform`).toBe(want.platform);
  expect(got.hi, `${what}: client hints`).toEqual(want.hi);
}

/** The last request to `path` carries the same identity in its headers as JavaScript reports. */
function expectHeaders(path: string, what: string): void {
  const h = hits.get(path)!.at(-1)!;
  const want = expected();
  expect(h["user-agent"], `${what}: User-Agent header`).toBe(want.ua);
  expect(h["sec-ch-ua"], `${what}: Sec-CH-UA`).toBe(fmt(want.hi.brands));
  expect(h["sec-ch-ua"], what).not.toMatch(/Headless/);
  expect(h["sec-ch-ua-arch"], `${what}: Sec-CH-UA-Arch`).toBe(`"${want.hi.architecture}"`);
  expect(h["sec-ch-ua-bitness"], `${what}: Sec-CH-UA-Bitness`).toBe(`"${want.hi.bitness}"`);
  expect(h["sec-ch-ua-platform-version"], `${what}: Sec-CH-UA-Platform-Version`).toBe(`"${want.hi.platformVersion}"`);
  expect(h["sec-ch-ua-full-version-list"], `${what}: Sec-CH-UA-Full-Version-List`).toBe(fmt(want.hi.fullVersionList));
  expect(h["sec-ch-ua-model"], `${what}: Sec-CH-UA-Model`).toBe(`"${want.hi.model}"`);
  expect(h["sec-ch-ua-wow64"], `${what}: Sec-CH-UA-WoW64`).toBe(want.hi.wow64 ? "?1" : "?0");
  expect(h["sec-ch-ua-platform"], `${what}: Sec-CH-UA-Platform`).toBe(`"${want.hi.platform}"`);
}

/** The reference: the same Chrome, headless, no override at all, on the same local site. */
async function probeReference(): Promise<Ident> {
  const profile = join(root, "ref-profile");
  refChrome = spawn(
    CHROME,
    [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--headless=new", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "about:blank"],
    { stdio: "ignore" },
  );
  const active = await until(
    () => {
      try {
        return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
      } catch {
        return null;
      }
    },
    (v) => v !== null && v.length >= 2 && v[1]!.startsWith("/devtools/"),
    "reference DevTools port",
  );
  const cdp: CdpConnection = await connectCdp(`ws://127.0.0.1:${active![0]}${active![1]}`, { timeoutMs: 5000 });
  try {
    // Twice: the second request carries the hints the first answer asked for.
    for (const path of ["/p/ref", "/p/ref"]) await cdp.send("Target.createTarget", { url: `${siteUrl}${path}` });
    const ident = (await evalIn(Number(active![0]), "/p/ref", IDENT)) as Ident;
    await until(() => hits.get("/p/ref")?.length ?? 0, (n) => n >= 2, "reference requests");
    return ident;
  } finally {
    await cdp.send("Browser.close").catch(() => {});
    cdp.close();
  }
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-identity-")));
  dataDir = join(root, "data");
  mkdirSync(join(root, "proj"));
  configPath = join(root, "engine.json");
  const base = 44000 + Math.floor(Math.random() * 20) * 100;
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
      // Production mode (no test headless): hidden = --headless=new; testMode = mock keychain.
      browser: { headless: false, testMode: true, startTimeoutMs: 30000, cdpPortBase: base, cdpPortSpan: 50 },
    }),
  );
  site = http.createServer((req, res) => {
    const path = (req.url ?? "/").replace(/[^a-z0-9/.]/g, "");
    hits.set(path, [...(hits.get(path) ?? []), req.headers]);
    if (path === "/w.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(`navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HINTS)}).then((hi) => postMessage({ ua: navigator.userAgent, platform: navigator.platform, hi }));`);
      return;
    }
    res.setHeader("accept-ch", ACCEPT_CH);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>${path}</title><body>${path}</body>`);
  });
  await new Promise<void>((r) =>
    site.listen(0, "127.0.0.1", () => {
      siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
      r();
    }),
  );
  ref = await probeReference();
  engine = await startEngine(env());
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Kimlik", location: { kind: "local", path: join(root, "proj") } })).project.id;
}, 90_000);

afterAll(async () => {
  if (!haveChrome) return;
  await c?.close();
  await stopEngine(engine);
  if (process.env.KOKPIT_E2E_LOG && engine) writeFileSync(process.env.KOKPIT_E2E_LOG, engine.logs());
  refChrome?.kill("SIGKILL");
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

describe.skipIf(!haveChrome)("Gizli tarayıcı kimliği: a hidden Chrome reports Chrome's own values, without Headless", { timeout: 120_000 }, () => {
  it("the reference (no override) has the real values on this machine", () => {
    expect(ref.ua).toMatch(/Chrome\/\d+/);
    expect(ref.hi.architecture).not.toBe("");
    expect(ref.hi.bitness).not.toBe("");
    expect(ref.hi.platformVersion).not.toBe("");
    expect(ref.hi.fullVersionList.length).toBeGreaterThan(0);
    console.info(`reference identity: ${JSON.stringify(ref)}`);
  });

  it("the active tab: JavaScript and the request headers equal the reference, no Headless anywhere", async () => {
    await c.req("browser.open", { projectId });
    await visit("/p/a");
    await visit("/p/b");
    const { port } = chromeOf(projectProfile());
    const got = (await evalIn(port, "/p/b", IDENT)) as Ident;
    console.info(`hidden project tab: ${JSON.stringify(got)}`);
    expectIdentity(got, "active tab");
    expectHeaders("/p/b", "active tab");
  });

  it("a dedicated worker of the page", async () => {
    const { port } = chromeOf(projectProfile());
    expectIdentity((await evalIn(port, "/p/b", WORKER_IDENT)) as Ident, "worker");
    expect(hits.get("/w.js")!.at(-1)!["user-agent"]).toBe(expected().ua);
  });

  it("a new tab and a popup the page opens, from their first request", async () => {
    await c.req("browser.newTab", { projectId, url: `${siteUrl}/p/tab` });
    const { port } = chromeOf(projectProfile());
    expectIdentity((await evalIn(port, "/p/tab", IDENT)) as Ident, "new tab");
    expectHeaders("/p/tab", "new tab");
    await evalIn(port, "/p/tab", `window.open("/p/pop", "_blank", "popup,width=400,height=300"), true`);
    expectIdentity((await evalIn(port, "/p/pop", IDENT)) as Ident, "popup");
    expectHeaders("/p/pop", "popup");
  });


  it("a Chrome adopted by a restarted engine gets the identity again", async () => {
    const before = chromeOf(projectProfile());
    await c.close();
    engine!.child.kill("SIGKILL");
    await until(() => engine!.child.exitCode !== null || engine!.child.signalCode !== null, (v) => v, "engine killed");
    engine = await startEngine(env());
    c = await Client.connect(engine.port, KEY);
    await c.req("browser.open", { projectId });
    expect(chromeOf(projectProfile()).pid, "the same Chrome, adopted").toBe(before.pid);
    await visit("/p/after");
    await visit("/p/after2");
    expectIdentity((await evalIn(before.port, "/p/after2", IDENT)) as Ident, "adopted");
    expectHeaders("/p/after2", "adopted");
  });
});
