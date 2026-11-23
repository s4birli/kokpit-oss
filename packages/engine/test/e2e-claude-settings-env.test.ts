// Adım 9 İş A: background Claude agents (`claude agents`) run under the shared `claude daemon`, which does not
// carry the Kokpit terminal's environment. The engine therefore writes the browser env into the project's Claude
// settings file, which Claude Code applies to every session of the project and to the MCP servers it starts
// (contract: test/fakes/fake-claude-session.mjs). Real engine, REAL headless Chrome (temp profile, mock keychain),
// the pinned @playwright/mcp devDependency started with no args and WITHOUT the terminal's env, local pages only.
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserState, Project } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const DIMS = { cols: 200, rows: 30 };
const WAIT_MS = 30_000;
const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const MCP_CLI = join(ENGINE_DIR, "node_modules", "@playwright", "mcp", "cli.js");
const FAKE_SESSION = fileURLToPath(new URL("./fakes/fake-claude-session.mjs", import.meta.url));
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string; playwrightMcpCdpEndpointEnv: string[]; playwrightMcpOutputDirEnv: string[]; claudeSettingsPath: string[] };
};
const haveChrome = existsSync(defaults.browser.chromePath);
const CDP_ENV = defaults.browser.playwrightMcpCdpEndpointEnv[0]!;
const OUT_ENV = defaults.browser.playwrightMcpOutputDirEnv[0]!;
const SETTINGS_PATH = defaults.browser.claudeSettingsPath;
const KOKPIT_CDP = "KOKPIT_CDP_URL";
/** What the user already had in the file: must survive everything the engine does. */
const USER_SETTINGS = { permissions: { allow: ["Bash(ls:*)"] }, env: { MINE: "1" }, enableAllProjectMcpServers: false };

let root: string;
let projDir: string;
let settingsFile: string;
let configPath: string;
let engineEnv: NodeJS.ProcessEnv;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;
let mcp: ChildProcessWithoutNullStreams | undefined;
let blocker: net.Server | undefined;

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

/** Command lines of the Chromes this test's engine started (main process only: it carries the port switch). */
function ourChromes(): { pid: number; command: string }[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir="))
    .map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), command: l }))
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

/** Every Chrome-ish process whose command line is not ours: the MCP must not start one. */
function foreignChromeCount(): number {
  const out = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  return out.split("\n").filter((l) => /ms-playwright|chrome-headless-shell/i.test(l) && !l.includes(root)).length;
}

function mcpClient(proc: ChildProcessWithoutNullStreams) {
  let buf = "";
  let id = 0;
  const pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  proc.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (m.id !== undefined) pending.get(m.id)?.(m);
      } catch {
        /* not JSON-RPC */
      }
    }
  });
  const write = (m: object) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const call = (method: string, params: object) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
      const myId = ++id;
      const t = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), WAIT_MS);
      pending.set(myId, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      write({ id: myId, method, params });
    });
  return { call, notify: (method: string) => write({ method }) };
}

/** The environment a daemon-spawned session has: nothing of the Kokpit terminal's. */
function daemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, npm_config_offline: "true" };
  for (const k of Object.keys(env)) if (/^(KOKPIT_|PLAYWRIGHT_MCP_)/.test(k)) delete env[k];
  return env;
}

const browserState = async () => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;
const readSettings = () => JSON.parse(readFileSync(settingsFile, "utf8")) as { env?: Record<string, string> } & Record<string, unknown>;
const portOf = (url: string | undefined) => Number(new URL(url ?? "http://invalid").port);

async function connectEngine(): Promise<void> {
  engine = await startEngine(engineEnv);
  c = await Client.connect(engine.port, KEY);
}

/** The three browser variables as a NEW terminal of the project gets them. */
async function terminalEnv(): Promise<Record<string, string>> {
  const { terminal } = await c.req<{ terminal: { id: string } }>("terminal.open", { projectId, ...DIMS, toolId: null });
  c.input(terminal.id, `echo "CDP=[$${CDP_ENV}] OUT=[$${OUT_ENV}] K=[$${KOKPIT_CDP}]"\r`);
  const out = await c.waitForOutput(terminal.id, /CDP=\[http[^\]]*\] OUT=\[[^\]]+\] K=\[http[^\]]*\]/, WAIT_MS);
  const m = /CDP=\[(http[^\]]*)\] OUT=\[([^\]]+)\] K=\[(http[^\]]*)\]/.exec(out)!;
  await c.req("terminal.close", { terminalId: terminal.id });
  return { [CDP_ENV]: m[1]!, [OUT_ENV]: m[2]!, [KOKPIT_CDP]: m[3]! };
}

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-claude-settings-")));
  projDir = join(root, "proj");
  settingsFile = join(projDir, ...SETTINGS_PATH);
  mkdirSync(join(settingsFile, ".."), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(USER_SETTINGS, null, 2) + "\n");
  mkdirSync(join(root, "tmp"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  // Fake claude for the terminal: says so and stays; the real claude is never started.
  writeFileSync(join(binDir, "claude"), "#!/bin/sh\necho FAKE-CLAUDE-UP\nexec sleep 600\n");
  chmodSync(join(binDir, "claude"), 0o755);
  configPath = join(root, "engine.json");
  const cdpPortBase = 46000 + Math.floor(Math.random() * 20) * 100;
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
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Arka plan ajanı buraya geldi</title><body><h1>Kokpit Chrome</h1></body>`);
  });
  await new Promise<void>((r) =>
    site.listen(0, "127.0.0.1", () => {
      siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}/ajan`;
      r();
    }),
  );
  engineEnv = { KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, TMPDIR: join(root, "tmp"), PATH: `${binDir}:${process.env.PATH ?? ""}` };
  await connectEngine();
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Acme", location: { kind: "local", path: projDir } })).project.id;
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  mcp?.kill("SIGKILL");
  blocker?.close();
  await c?.close();
  await stopEngine(engine);
  for (const { pid } of ourChromes()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await new Promise<void>((r) => site?.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!haveChrome)("background agents reach the project's Chrome through the project's Claude settings file", { timeout: 180_000 }, () => {
  let firstPort: number;

  it("nothing is written before the project's browser exists", async () => {
    expect((await browserState()).running).toBe(false);
    expect(readSettings()).toEqual(USER_SETTINGS);
  });

  it("`claude agents` in a terminal starts the browser; the settings file then carries the terminal's browser env, the user's content intact", async () => {
    const { terminal } = await c.req<{ terminal: { id: string } }>("terminal.open", { projectId, ...DIMS, command: "claude agents --dangerously-skip-permissions" });
    await c.waitForOutput(terminal.id, /FAKE-CLAUDE-UP/, WAIT_MS);
    await until(async () => (await browserState()).running, Boolean, "browser started for claude agents");
    await until(readSettings, (s) => s.env?.[CDP_ENV] !== undefined, "settings file written");
    await c.req("terminal.close", { terminalId: terminal.id });

    const fromTerminal = await terminalEnv();
    const s = readSettings();
    expect(s).toEqual({ ...USER_SETTINGS, env: { ...USER_SETTINGS.env, ...fromTerminal } });
    expect(Object.keys(s)).toEqual(Object.keys(USER_SETTINGS));
    expect(s.env![CDP_ENV]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    firstPort = portOf(s.env![CDP_ENV]);

    // DevTools still listens on loopback only, on exactly that port.
    const chrome = ourChromes().find((p) => p.command.includes("--remote-debugging-port="));
    expect(chrome?.command).toContain("--remote-debugging-address=127.0.0.1");
    expect(chrome?.command).toContain(`--remote-debugging-port=${firstPort} `);
  });

  it("a session WITHOUT the terminal's env (as under the daemon) in the project folder: its no-args Playwright MCP drives the project's Chrome", async () => {
    const env = daemonEnv();
    expect(Object.keys(env).filter((k) => /^(KOKPIT_|PLAYWRIGHT_MCP_)/.test(k))).toEqual([]);
    const before = foreignChromeCount();
    mcp = spawn(process.execPath, [FAKE_SESSION, SETTINGS_PATH.join("/"), process.execPath, MCP_CLI], { cwd: projDir, env, stdio: "pipe" });
    const client = mcpClient(mcp);
    const init = await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kokpit-e2e", version: "0" } });
    expect(init.error).toBeUndefined();
    client.notify("notifications/initialized");
    const nav = await client.call("tools/call", { name: "browser_navigate", arguments: { url: siteUrl } });
    expect(nav.error).toBeUndefined();
    expect(JSON.stringify(nav.result)).toContain("Arka plan ajanı buraya geldi");
    await until(browserState, (s) => s.tabs.some((t) => t.title === "Arka plan ajanı buraya geldi"), "engine sees the agent's navigation");
    expect(foreignChromeCount()).toBe(before);
    mcp.kill();
    expect(existsSync(join(projDir, ".playwright-mcp"))).toBe(false);
  });

  it("the port is the project's for good: same after the browser restarts and after the engine restarts", async () => {
    await c.req("browser.close", { projectId });
    await until(async () => (await browserState()).running, (r) => !r, "browser closed");
    // Closing leaves the file alone: a session started meanwhile must not silently launch its own Chrome.
    expect(portOf(readSettings().env?.[CDP_ENV])).toBe(firstPort);
    await c.req("browser.open", { projectId });
    expect(portOf((await terminalEnv())[CDP_ENV])).toBe(firstPort);

    await c.close();
    await stopEngine(engine);
    await until(() => ourChromes().length, (n) => n === 0, "chrome gone with the engine");
    await connectEngine();
    expect(portOf(readSettings().env?.[CDP_ENV])).toBe(firstPort);
    await c.req("browser.open", { projectId });
    expect(portOf((await terminalEnv())[CDP_ENV])).toBe(firstPort);
    expect(ourChromes().some((p) => p.command.includes(`--remote-debugging-port=${firstPort} `))).toBe(true);
  });

  it("a busy port is replaced, and the settings file is corrected", async () => {
    await c.req("browser.close", { projectId });
    await until(async () => (await browserState()).running, (r) => !r, "browser closed");
    await until(() => ourChromes().length, (n) => n === 0, "chrome process gone");
    blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker!.once("error", reject);
      blocker!.listen({ host: "127.0.0.1", port: firstPort, exclusive: true }, () => resolve());
    });
    await c.req("browser.open", { projectId });
    const s = await until(readSettings, (v) => portOf(v.env?.[CDP_ENV]) !== firstPort, "settings file corrected");
    const env = await terminalEnv();
    expect(s.env).toEqual({ ...USER_SETTINGS.env, ...env });
    expect(portOf(env[CDP_ENV])).not.toBe(firstPort);
    expect(ourChromes().some((p) => p.command.includes(`--remote-debugging-port=${portOf(env[CDP_ENV])} `))).toBe(true);
    await new Promise<void>((r) => blocker!.close(() => r()));
    blocker = undefined;
  });

  it("turning the project option off removes exactly the engine's keys; on again (browser running) writes them back", async () => {
    const off = await c.req<{ project: Project }>("projects.update", { projectId, claudeBrowserEnv: false });
    expect(off.project.claudeBrowserEnv).toBe(false);
    expect(readSettings()).toEqual(USER_SETTINGS);
    // Terminals keep their env: only the settings file follows the option.
    expect((await terminalEnv())[CDP_ENV]).toMatch(/^http:/);

    await c.req("projects.update", { projectId, claudeBrowserEnv: true });
    expect(readSettings().env).toEqual({ ...USER_SETTINGS.env, ...(await terminalEnv()) });
  });

  it("deleting the project removes the engine's keys and leaves the user's file", async () => {
    await c.req("projects.delete", { projectId });
    expect(readSettings()).toEqual(USER_SETTINGS);
  });
});
