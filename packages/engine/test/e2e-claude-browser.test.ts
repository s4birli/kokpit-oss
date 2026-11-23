// End-to-end for "Claude + browser" against the real engine and a REAL Chrome (headless, test mode), WITHOUT
// the real claude: a fake `claude` first on PATH records the argv the tool's wrapper gives it. The test then
// runs the MCP server exactly as that --mcp-config describes (Playwright MCP, installed as a devDependency so
// npx resolves it offline) and calls a tool over MCP stdio; the change shows up in the engine's browser.
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserState } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const DIMS = { cols: 120, rows: 30 };
const WAIT_MS = 30_000;
const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const TOOL_ID = "claude-tarayici";
const MCP_SERVER = "kokpit-tarayici";
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: { chromePath: string };
};
const haveChrome = existsSync(defaults.browser.chromePath);

let root: string;
let configPath: string;
let binDir: string;
let argvFile: string;
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;
let mcp: ChildProcessWithoutNullStreams | undefined;

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

/** Minimal MCP client over stdio (newline-delimited JSON-RPC). */
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
        /* not a JSON-RPC line */
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

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-claude-browser-")));
  mkdirSync(join(root, "proj"));
  // The project resolves the pinned Playwright MCP devDependency, so npx needs no network; Playwright MCP
  // writes its snapshots into the project folder (cwd), which is this temp dir.
  symlinkSync(join(ENGINE_DIR, "node_modules"), join(root, "proj", "node_modules"));
  binDir = join(root, "bin");
  mkdirSync(binDir);
  argvFile = join(root, "claude-argv.json");
  // Fake claude: records argv, says so, exits. The real claude is never started.
  const fake = join(root, "fake-claude.mjs");
  writeFileSync(
    fake,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log("FAKE-CLAUDE-OK");\n`,
  );
  writeFileSync(join(binDir, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`);
  chmodSync(join(binDir, "claude"), 0o755);
  configPath = join(root, "engine.json");
  const cdpPortBase = 43000 + Math.floor(Math.random() * 20) * 400;
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
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 400 },
    }),
  );
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>MCP ile açıldı</title><body><h1>Kokpit MCP sayfası</h1></body>`);
  });
  await new Promise<void>((r) =>
    site.listen(0, "127.0.0.1", () => {
      siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}/mcp`;
      r();
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, PATH: `${binDir}:${process.env.PATH ?? ""}` });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Ajan", location: { kind: "local", path: join(root, "proj") } }))
    .project.id;
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  mcp?.kill("SIGKILL");
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

describe.skipIf(!haveChrome)("Claude + browser end-to-end (fake claude, real Playwright MCP, real Chrome)", { timeout: 120_000 }, () => {
  it("the tool exists after seeding", async () => {
    const { tools } = await c.req<{ tools: { id: string; opensBrowser?: boolean }[] }>("tools.list", {});
    expect(tools.find((t) => t.id === TOOL_ID)).toMatchObject({ opensBrowser: true });
  });

  it("opening a terminal with it starts the project's browser and claude gets Playwright MCP on KOKPIT_CDP_URL; an MCP call drives that browser", async () => {
    expect((await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser.running).toBe(false);
    const { terminal } = await c.req<{ terminal: { id: string } }>("terminal.open", { projectId, ...DIMS, toolId: TOOL_ID });
    await until(
      async () => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser.running,
      Boolean,
      "browser started by terminal.open",
    );
    const out = await c.waitForOutput(terminal.id, /FAKE-CLAUDE-OK/, WAIT_MS);
    expect(out).not.toMatch(/Tarayıcı panelinden/);
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(argv.at(-2)).toBe("--mcp-config");
    const config = JSON.parse(argv.at(-1)!) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const server = config.mcpServers[MCP_SERVER]!;
    // The endpoint is the terminal's KOKPIT_CDP_URL, i.e. this project's Chrome.
    c.input(terminal.id, "echo CDP=$KOKPIT_CDP_URL\r");
    const cdpUrl = /CDP=(http:\/\/127\.0\.0\.1:\d+)/.exec(await c.waitForOutput(terminal.id, /CDP=http:\/\/127\.0\.0\.1:\d+/, WAIT_MS))![1]!;
    expect(server.args).toEqual([
      "-y",
      expect.stringMatching(/^@playwright\/mcp@\d+\.\d+\.\d+$/),
      "--cdp-endpoint",
      cdpUrl,
      "--output-dir",
      // Adım 9 İş T: the project's own folder, under the harness's temp parent — never the real per-user folder.
      expect.stringMatching(/\/kokpit-e2e-pw-output-[^/]+\/kokpit-playwright-mcp\/[^/]+$/),
    ]);
    expect(server.args.at(-1)!.endsWith(`/${projectId}`)).toBe(true);

    // Run the server exactly as configured, from the project folder like claude would.
    mcp = spawn(server.command, server.args, { cwd: join(root, "proj"), env: { ...process.env, npm_config_offline: "true" }, stdio: "pipe" });
    const client = mcpClient(mcp);
    const init = await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kokpit-e2e", version: "0" } });
    expect(init.error).toBeUndefined();
    client.notify("notifications/initialized");
    const nav = await client.call("tools/call", { name: "browser_navigate", arguments: { url: siteUrl } });
    expect(nav.error).toBeUndefined();
    expect(JSON.stringify(nav.result)).toContain("MCP ile açıldı");
    // The engine's panel state shows the page the agent opened.
    await until(
      () => c.req<{ browser: BrowserState }>("browser.tabs", { projectId }),
      (r) => r.browser.tabs.some((t) => t.title === "MCP ile açıldı"),
      "engine sees the MCP navigation",
    );
    const snap = await client.call("tools/call", { name: "browser_snapshot", arguments: {} });
    expect(JSON.stringify(snap.result)).toContain("Kokpit MCP sayfası");
    mcp.kill();
    await c.req("terminal.close", { terminalId: terminal.id });
  });
});
