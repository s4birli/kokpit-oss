// End-to-end for İş B developer extensions against the real engine and a REAL Chrome (headless, test mode:
// temp profile root, mock keychain). Branded Chrome ignores --load-extension, so the engine loads unpacked
// extensions through CDP Extensions.loadUnpacked (Chrome started with --enable-unsafe-extension-debugging)
// and loads them again on every start. The fixture's content script marks every page.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserExtension, BrowserState } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectCdp } from "../src/cdp.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const WAIT_MS = 20_000;
const FIXTURE = fileURLToPath(new URL("./fixtures/ext-marker", import.meta.url));
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; profilesDirName: string };
};
const haveChrome = existsSync(defaults.browser.chromePath);

let root: string;
let dataDir: string;
let configPath: string;
let extDir: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;

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

function ourChromePids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** DevTools port of the project's main Chrome process, read from its command line. */
function devtoolsPort(): number {
  const profile = join(dataDir, defaults.browser.profilesDirName, projectId);
  const out = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.includes(`--user-data-dir=${profile}`) && !l.includes("--type="));
  expect(line, "project chrome running").toBeDefined();
  return Number(/--remote-debugging-port=(\d+)/.exec(line!)![1]);
}

/** document.body.dataset.kokpitExt of the active page, read with CDP Runtime.evaluate. */
async function marker(): Promise<string | null> {
  const port = devtoolsPort();
  const { browser } = await c.req<{ browser: BrowserState }>("browser.tabs", { projectId });
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
  const page = list.find((t) => t.id === browser.activeTabId);
  expect(page, "active tab in /json/list").toBeDefined();
  const cdp = await connectCdp(page!.webSocketDebuggerUrl, { timeoutMs: 5000 });
  try {
    const r = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression: "document.body?.dataset.kokpitExt ?? null",
      returnByValue: true,
    });
    return (r.result.value as string | null) ?? null;
  } finally {
    cdp.close();
  }
}

async function visit(path: string): Promise<void> {
  await c.req("browser.navigate", { projectId, url: `${siteUrl}${path}` });
  await until(
    () => c.req<{ browser: BrowserState }>("browser.tabs", { projectId }),
    (r) => r.browser.tabs.some((t) => t.id === r.browser.activeTabId && t.title === path),
    `title ${path}`,
  );
}

const list = async () => (await c.req<{ extensions: BrowserExtension[] }>("browser.extensions.list", { projectId })).extensions;

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-ext-")));
  dataDir = join(root, "data");
  mkdirSync(join(root, "proj"));
  // A folder name with a space, like real paths on this Mac ("Main Disk").
  extDir = join(root, "uzantı klasörü", "marker");
  mkdirSync(join(root, "uzantı klasörü"));
  cpSync(FIXTURE, extDir, { recursive: true });
  configPath = join(root, "engine.json");
  const cdpPortBase = 42000 + Math.floor(Math.random() * 20) * 400;
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
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 400 },
    }),
  );
  site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>${(req.url ?? "/").replace(/[^a-z0-9/]/g, "")}</title><body>sayfa</body>`);
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
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Uzantı", location: { kind: "local", path: join(root, "proj") } }))
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

describe.skipIf(!haveChrome)("İş B: unpacked extensions with a real Chrome", { timeout: 90_000 }, () => {
  it("nothing is remembered at first; bad folders are refused with a Turkish reason", async () => {
    expect(await list()).toEqual([]);
    for (const path of [join(root, "yok"), join(root, "proj"), join(root, "proj", "..", "proj")]) {
      await expect(c.req("browser.extensions.loadUnpacked", { projectId, path })).rejects.toMatchObject({ code: "INVALID" });
    }
    expect(await list()).toEqual([]);
  });

  it("loadUnpacked starts the browser, loads the extension; its content script runs on pages", async () => {
    const r = await c.req<{ extensions: BrowserExtension[] }>("browser.extensions.loadUnpacked", { projectId, path: extDir });
    expect(r.extensions).toEqual([
      { path: extDir, id: expect.stringMatching(/^[a-p]{32}$/), name: "Kokpit test marker", version: "1.0.0", loaded: true },
    ]);
    expect((await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser.running).toBe(true);
    await visit("/bir");
    await until(marker, (m) => m === "1", "marker on /bir");
    // Loading it again changes nothing.
    const again = await c.req<{ extensions: BrowserExtension[] }>("browser.extensions.loadUnpacked", { projectId, path: extDir });
    expect(again.extensions).toHaveLength(1);
  });

  it("browser restart: the remembered extension is loaded again", async () => {
    await c.req("browser.close", { projectId });
    expect(await list()).toEqual([{ path: extDir, loaded: false }]);
    await c.req("browser.open", { projectId });
    await until(list, (l) => l[0]?.loaded === true, "extension loaded after restart");
    await visit("/iki");
    await until(marker, (m) => m === "1", "marker on /iki after restart");
  });

  it("engine restart: the folder list persists and loads with the next browser start", async () => {
    await c.close();
    await stopEngine(engine);
    await until(() => ourChromePids(), (p) => p.length === 0, "chrome gone after engine stop", 15_000);
    engine = await startEngine(env());
    c = await Client.connect(engine.port, KEY);
    expect(await list()).toEqual([{ path: extDir, loaded: false }]);
    await c.req("browser.open", { projectId });
    await visit("/uc");
    await until(marker, (m) => m === "1", "marker on /uc after engine restart");
  });

  it("a remembered folder that disappeared shows its error and does not stop the browser", async () => {
    await c.req("browser.close", { projectId });
    const moved = `${extDir}-tasindi`;
    cpSync(extDir, moved, { recursive: true });
    rmSync(extDir, { recursive: true });
    try {
      const st = await c.req<{ browser: BrowserState }>("browser.open", { projectId });
      expect(st.browser.running).toBe(true);
      const l = await list();
      expect(l).toEqual([{ path: extDir, loaded: false, error: expect.stringMatching(/bulunamadı/) }]);
    } finally {
      cpSync(moved, extDir, { recursive: true });
      rmSync(moved, { recursive: true });
    }
  });

  it("showWindow of a headless browser says there is no window", async () => {
    await expect(c.req("browser.showWindow", { projectId })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("remove unloads and forgets it: new pages are no longer marked", async () => {
    await c.req("browser.extensions.loadUnpacked", { projectId, path: extDir });
    await visit("/dort");
    await until(marker, (m) => m === "1", "marker before remove");
    const r = await c.req<{ extensions: BrowserExtension[] }>("browser.extensions.remove", { projectId, path: extDir });
    expect(r.extensions).toEqual([]);
    await visit("/bes");
    expect(await marker()).toBeNull();
    await c.req("browser.close", { projectId });
    await c.req("browser.open", { projectId });
    expect(await list()).toEqual([]);
  });
});
