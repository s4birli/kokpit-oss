// Shared harness for end-to-end tests: start the real engine (`node src/main.ts`) as a child
// process and drive it over WebSocket like the app does.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { parseServerMessage, type HelloOkFrame, type ServerMessage } from "@kokpit/shared";
import { authenticate } from "../src/ws-auth-client.ts";

const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const STARTUP_TIMEOUT_MS = 15000;
const POLL_MS = 20;
const DEFAULT_WAIT_MS = 10000;
const DEFAULT_HOST = "127.0.0.1";
/** Background-agent polling is off unless a test turns it on: no test may run the real `claude agents`. */
const BG_AGENTS_OFF = { KOKPIT_BG_AGENTS_POLL_MS: "0" };

export interface EngineProc {
  child: ChildProcess;
  /** First address the engine listens on (loopback unless the test's config turns `listenLocalhost` off). */
  host: string;
  port: number;
  /** Everything the engine wrote to stdout/stderr (for leak checks). */
  logs(): string;
  /** Empty ZDOTDIR the engine gives its terminal shells: zsh never loads the user's real rc files in tests. */
  zdotdir: string;
}

/**
 * Adım 9 İş T: the engine sweeps (deletes old files in) its Playwright MCP output folder at startup. No test engine
 * may do that to — or hand terminals — the user's real `$TMPDIR/kokpit-playwright-mcp`: every engine gets its own
 * temp parent dir. A test that names the parent in its config file (`browser.playwrightMcpOutputParentDir`)
 * passes this variable as "" (the engine ignores an empty value).
 */
export const PLAYWRIGHT_OUTPUT_PARENT_ENV = "KOKPIT_PLAYWRIGHT_MCP_OUTPUT_PARENT_DIR";

/**
 * Engine child env: the test's, plus an empty temp ZDOTDIR for terminal shells and a temp Playwright MCP output
 * parent dir (both removed when the engine exits).
 */
function engineEnv(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; zdotdir: string; cleanup: () => void } {
  const own: string[] = [];
  const temp = (prefix: string): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    own.push(dir);
    return dir;
  };
  const zdotdir = env.KOKPIT_TERMINAL_ZDOTDIR || temp("kokpit-e2e-zdotdir-");
  const outputParent = env[PLAYWRIGHT_OUTPUT_PARENT_ENV] ?? temp("kokpit-e2e-pw-output-");
  return {
    env: { ...process.env, ...BG_AGENTS_OFF, ...env, KOKPIT_TERMINAL_ZDOTDIR: zdotdir, [PLAYWRIGHT_OUTPUT_PARENT_ENV]: outputParent },
    zdotdir,
    cleanup: () => {
      for (const dir of own) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function startEngine(env: NodeJS.ProcessEnv): Promise<EngineProc> {
  return new Promise((resolve, reject) => {
    const e = engineEnv(env);
    const child = spawn(process.execPath, ["src/main.ts"], {
      cwd: ENGINE_DIR,
      env: e.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("exit", e.cleanup);
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`engine did not start:\n${out}\n${err}`)), STARTUP_TIMEOUT_MS);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`engine exited early (${code}):\n${out}\n${err}`));
    };
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      for (const line of out.split("\n")) {
        if (!line.includes('"listening"')) continue;
        try {
          const entry = JSON.parse(line) as { addresses?: { host: string; port: number }[] };
          if (!entry.addresses) continue;
          clearTimeout(timer);
          child.off("exit", onExit);
          resolve({ child, host: entry.addresses[0]!.host, port: entry.addresses[0]!.port, logs: () => out + err, zdotdir: e.zdotdir });
          return;
        } catch {
          /* partial line */
        }
      }
    });
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    child.on("exit", onExit);
  });
}

export async function stopEngine(proc: EngineProc | undefined): Promise<void> {
  const child = proc?.child;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

/** A minimal app-like client: hello, requests with ids, collected server frames. */
export class Client {
  readonly frames: ServerMessage[] = [];
  readonly raw: string[] = [];
  readonly ws: WebSocket;
  /** The engine's verified `hello.ok` (set by connect). */
  hello: HelloOkFrame | undefined;
  private nextId = 1;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const text = data.toString();
      this.raw.push(text);
      const r = parseServerMessage(text);
      if (r.ok) this.frames.push(r.value);
    });
  }

  /** `host`: an IP literal the engine listens on; default IPv4 loopback. */
  static async connect(port: number, key: string, host: string = DEFAULT_HOST): Promise<Client> {
    const ws = new WebSocket(`ws://${host.includes(":") ? `[${host}]` : host}:${port}`);
    const c = new Client(ws);
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });
    // Mutual handshake: the key never crosses the wire; the engine proves it holds it too.
    c.hello = await authenticate(ws, key);
    return c;
  }

  async req<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    const res = (await this.waitFor((f) => f.type === "res" && f.id === id, 60000)) as Extract<ServerMessage, { type: "res" }>;
    if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    return res.result as T;
  }

  input(terminalId: string, data: string): void {
    this.ws.send(JSON.stringify({ type: "input", terminalId, data }));
  }

  output(terminalId: string): string {
    return this.frames
      .filter((f): f is Extract<ServerMessage, { type: "output" }> => f.type === "output" && f.terminalId === terminalId)
      .map((f) => f.data)
      .join("");
  }

  async waitFor(pred: (f: ServerMessage) => boolean, timeoutMs = DEFAULT_WAIT_MS): Promise<ServerMessage> {
    const start = Date.now();
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for frame");
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  async waitForOutput(terminalId: string, re: RegExp, timeoutMs = DEFAULT_WAIT_MS): Promise<string> {
    const start = Date.now();
    for (;;) {
      const out = this.output(terminalId);
      if (re.test(out)) return out;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${re} in:\n${out}`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  close(): Promise<void> {
    return new Promise((res) => {
      if (this.ws.readyState === WebSocket.CLOSED) return res();
      this.ws.once("close", () => res());
      this.ws.close();
    });
  }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
