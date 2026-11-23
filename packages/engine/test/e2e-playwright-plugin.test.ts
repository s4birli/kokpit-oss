// A user's own global Playwright MCP plugin (`npx @playwright/mcp@latest`, NO args) started by plain `claude` in a
// project terminal must drive Kokpit's project Chrome (not launch its own) and must not write `.playwright-mcp/`
// into the repo. Real engine, REAL headless Chrome (temp profile, mock keychain), the pinned @playwright/mcp
// devDependency started with no args and only the terminal's env, a fake `claude` on PATH, local pages only.
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserState } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, PLAYWRIGHT_OUTPUT_PARENT_ENV, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const DIMS = { cols: 160, rows: 30 };
const WAIT_MS = 30_000;
const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const MCP_CLI = join(ENGINE_DIR, "node_modules", "@playwright", "mcp", "cli.js");
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: {
    chromePath: string;
    playwrightMcpCdpEndpointEnv: string[];
    playwrightMcpOutputDirEnv: string[];
    playwrightMcpOutputDirName: string;
    playwrightMcpOutputRetentionDays: number;
  };
};
const DAY_MS = 24 * 60 * 60 * 1000;
const haveChrome = existsSync(defaults.browser.chromePath);
const CDP_ENV = defaults.browser.playwrightMcpCdpEndpointEnv[0]!;
const OUT_ENV = defaults.browser.playwrightMcpOutputDirEnv[0]!;

let root: string;
let projDir: string;
let engineTmp: string;
/** Adım 9 İş T: the engine's Playwright MCP output base (`<configured parent>/<name>`), inside this test's temp root. */
let outputBase: string;
let outsideDir: string;
let seeded: { oldFile: string; oldNested: string; freshFile: string; outsideOld: string; oldLink: string };
let engine: EngineProc | undefined;
let site: http.Server;
let siteUrl: string;
let c: Client;
let projectId: string;
let mcp: ChildProcessWithoutNullStreams | undefined;
/** The browser env a project terminal carries (read from a real terminal in the navigate test). */
let mcpEnv: Record<string, string> | undefined;

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

/** Our Chrome's browser process (not its renderer/GPU/utility children, which come and go with pages). */
function ourChromeMainPids(): number[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes(root) && l.includes("--user-data-dir=") && !l.includes("--type="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
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

const browserState = async () => (await c.req<{ browser: BrowserState }>("browser.tabs", { projectId })).browser;

beforeAll(async () => {
  if (!haveChrome) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-pw-plugin-")));
  projDir = join(root, "proj");
  mkdirSync(projDir);
  engineTmp = join(root, "tmp");
  mkdirSync(engineTmp);
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  // Fake claude: says so and stays (like the real one would); the real claude is never started.
  writeFileSync(join(binDir, "claude"), "#!/bin/sh\necho FAKE-CLAUDE-UP\nexec sleep 600\n");
  chmodSync(join(binDir, "claude"), 0o755);
  // Output from "earlier sessions", older and newer than the retention limit, plus an old file outside the base
  // that an old symlink inside points at: the engine's startup sweep must take exactly the old ones inside.
  const outputParent = join(root, "pw-output");
  outputBase = join(outputParent, defaults.browser.playwrightMcpOutputDirName);
  outsideDir = join(root, "outside");
  mkdirSync(join(outputBase, "eski-proje", "nested"), { recursive: true });
  mkdirSync(outsideDir);
  const oldSec = (Date.now() - (defaults.browser.playwrightMcpOutputRetentionDays + 1) * DAY_MS) / 1000;
  seeded = {
    oldFile: join(outputBase, "eski-proje", "gizli-sayfa-old.png"),
    oldNested: join(outputBase, "eski-proje", "nested", "old.yml"),
    freshFile: join(outputBase, "eski-proje", "fresh.png"),
    outsideOld: join(outsideDir, "old-but-outside.txt"),
    oldLink: join(outputBase, "eski-proje", "escape"),
  };
  for (const f of [seeded.oldFile, seeded.oldNested, seeded.freshFile, seeded.outsideOld]) writeFileSync(f, "x");
  for (const f of [seeded.oldFile, seeded.oldNested, seeded.outsideOld]) utimesSync(f, oldSec, oldSec);
  symlinkSync(outsideDir, seeded.oldLink);
  lutimesSync(seeded.oldLink, oldSec, oldSec);

  const configPath = join(root, "engine.json");
  const cdpPortBase = 44000 + Math.floor(Math.random() * 20) * 100;
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
      browser: { headless: true, testMode: true, startTimeoutMs: 30000, cdpPortBase, cdpPortSpan: 100, playwrightMcpOutputParentDir: outputParent },
    }),
  );
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Eklenti buraya geldi</title><body><h1>Kokpit Chrome</h1></body>`);
  });
  await new Promise<void>((r) =>
    site.listen(0, "127.0.0.1", () => {
      siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}/eklenti`;
      r();
    }),
  );
  // TMPDIR = the engine user's per-user temp dir (isolated here). The output parent comes from the config file
  // above ("" = the harness adds no env override), so nothing here can reach the real per-user output folder.
  engine = await startEngine({
    KOKPIT_CONFIG: configPath,
    KOKPIT_KEY: KEY,
    TMPDIR: engineTmp,
    [PLAYWRIGHT_OUTPUT_PARENT_ENV]: "",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Acme", location: { kind: "local", path: projDir } })).project.id;
}, 60_000);

afterAll(async () => {
  if (!haveChrome) return;
  mcp?.kill("SIGKILL");
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

describe.skipIf(!haveChrome)("a no-args Playwright MCP from a project terminal drives Kokpit's Chrome", { timeout: 120_000 }, () => {
  it("at startup the engine deletes output older than the retention limit — only inside its own folder, links not followed", async () => {
    const gone = (p: string) => {
      try {
        lstatSync(p);
        return false;
      } catch {
        return true;
      }
    };
    await until(() => gone(seeded.oldFile) && gone(seeded.oldNested) && gone(seeded.oldLink), Boolean, "old output swept");
    expect(existsSync(seeded.freshFile)).toBe(true);
    expect(existsSync(seeded.outsideOld)).toBe(true);
    expect(readdirSync(outsideDir)).toEqual(["old-but-outside.txt"]);
    // The emptied subfolder went too; the project folder still holds the fresh file.
    expect(existsSync(join(outputBase, "eski-proje", "nested"))).toBe(false);
    const line = await until(
      () => engine!.logs().split("\n").find((l) => l.includes('"deletedFiles"')),
      (l) => l !== undefined,
      "sweep logged",
    );
    expect(JSON.parse(line!)).toMatchObject({ level: "info", deletedFiles: 3, deletedDirs: 1, errors: 0 });
    // Counts only: no file or project folder name in the log.
    expect(engine!.logs()).not.toMatch(/gizli-sayfa|eski-proje|old\.yml/);
  });

  it("plain `claude` in a terminal starts the project's browser; the terminal env points Playwright MCP at it", async () => {
    expect((await browserState()).running).toBe(false);
    const { terminal } = await c.req<{ terminal: { id: string } }>("terminal.open", { projectId, ...DIMS, command: "claude" });
    await c.waitForOutput(terminal.id, /FAKE-CLAUDE-UP/, WAIT_MS);
    await until(async () => (await browserState()).running, Boolean, "browser started for claude");
    await c.req("terminal.close", { terminalId: terminal.id });
  });

  it("browser_navigate of a no-args @playwright/mcp with the terminal's env lands in the project's Chrome; no .playwright-mcp in the repo", async () => {
    const { terminal } = await c.req<{ terminal: { id: string } }>("terminal.open", { projectId, ...DIMS, toolId: null });
    c.input(terminal.id, `echo "CDP=[$${CDP_ENV}] OUT=[$${OUT_ENV}] K=[$KOKPIT_CDP_URL]"\r`);
    const out = await c.waitForOutput(terminal.id, /CDP=\[http[^\]]*\] OUT=\[[^\]]+\] K=\[http[^\]]*\]/, WAIT_MS);
    const m = /CDP=\[(http[^\]]*)\] OUT=\[([^\]]+)\] K=\[(http[^\]]*)\]/.exec(out)!;
    const [, cdp, outDir, kokpit] = m;
    expect(cdp).toBe(kokpit);
    expect(cdp).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Adım 9 İş T: the project's own folder under the configured parent — inside this test's temp root.
    expect(outDir).toBe(join(outputBase, projectId));
    expect(outDir!.startsWith(root + "/")).toBe(true);
    await c.req("terminal.close", { terminalId: terminal.id });

    const before = foreignChromeCount();
    // Exactly what the user's plugin runs: the CLI with no arguments, from the project folder, terminal env.
    mcp = spawn(process.execPath, [MCP_CLI], {
      cwd: projDir,
      env: { ...process.env, [CDP_ENV]: cdp!, [OUT_ENV]: outDir!, npm_config_offline: "true" },
      stdio: "pipe",
    });
    const client = mcpClient(mcp);
    const init = await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kokpit-e2e", version: "0" } });
    expect(init.error).toBeUndefined();
    client.notify("notifications/initialized");
    const nav = await client.call("tools/call", { name: "browser_navigate", arguments: { url: siteUrl } });
    expect(nav.error).toBeUndefined();
    expect(JSON.stringify(nav.result)).toContain("Eklenti buraya geldi");
    await until(browserState, (s) => s.tabs.some((t) => t.title === "Eklenti buraya geldi"), "engine sees the plugin's navigation");
    // It used Kokpit's Chrome: no browser of its own was launched.
    expect(foreignChromeCount()).toBe(before);
    const snap = await client.call("tools/call", { name: "browser_snapshot", arguments: {} });
    expect(snap.error).toBeUndefined();
    mcp.kill();
    expect(existsSync(join(projDir, ".playwright-mcp"))).toBe(false);
    mcpEnv = { [CDP_ENV]: cdp!, [OUT_ENV]: outDir! };
  });

  // T-BGTAR-11: however an agent's session ends its Playwright MCP, the project's Chrome and the page the agent
  // left open stay (a CDP-attached Playwright only drops its connection; it never sends Browser.close).
  const MCP_ENDINGS: [string, ((proc: ChildProcessWithoutNullStreams) => void) | null][] = [
    ["SIGTERM", (proc) => void proc.kill("SIGTERM")],
    ["stdin kapanması", (proc) => void proc.stdin.end()],
    ["browser_close aracı", null],
  ];
  it.each(MCP_ENDINGS)("the MCP ending by %s leaves Kokpit's Chrome running with the agent's page still open", async (_name, end) => {
    expect(mcpEnv).toBeDefined();
    const chromeBefore = ourChromeMainPids();
    expect(chromeBefore).toHaveLength(1);
    const url = `${siteUrl}?bitis=${encodeURIComponent(_name)}`;
    const proc = spawn(process.execPath, [MCP_CLI], { cwd: projDir, env: { ...process.env, ...mcpEnv, npm_config_offline: "true" }, stdio: "pipe" });
    mcp = proc;
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    const client = mcpClient(proc);
    expect((await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kokpit-e2e", version: "0" } })).error).toBeUndefined();
    client.notify("notifications/initialized");
    expect((await client.call("tools/call", { name: "browser_navigate", arguments: { url } })).error).toBeUndefined();
    await until(browserState, (s) => s.tabs.some((t) => t.url === url), "engine sees the agent's page");

    if (end) end(proc);
    else {
      expect((await client.call("tools/call", { name: "browser_close", arguments: {} })).error).toBeUndefined();
      // The tool only detaches; the server process is then ended like a session's last step.
      proc.stdin.end();
    }
    await exited;
    // Chrome is asked directly (CDP round trip through the engine), after the MCP process is gone.
    const after = await browserState();
    expect(after.running).toBe(true);
    expect(after.tabs.some((t) => t.url === url)).toBe(true);
    expect(ourChromeMainPids()).toEqual(chromeBefore);
    expect(engine!.logs()).not.toContain('"browser gone"');
    expect(existsSync(join(projDir, ".playwright-mcp"))).toBe(false);
  });
});
