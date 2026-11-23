// End-to-end for İş A (ajan özeti) against the real engine: a fake `claude` on PATH prints what
// Claude Code prints when it asks for permission, then works, then goes silent.
// The real `claude` is never started: PATH starts with the fake, and the global default tool is off.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, TerminalActivity, TerminalInfo } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const DIMS = { cols: 100, rows: 30 };
const WINDOW_MS = 600;
const STATE_TIMEOUT_MS = 15_000;

/** Claude Code's permission prompt as the TUI draws it (bold, cursor moves, ❯ marker), then a blocking read. */
const FAKE_CLAUDE = `#!/bin/sh
printf '\\033[2K\\033[1G\\033[1mBash command\\033[0m\\r\\n\\033[1mDo\\033[1Cyou want to proceed?\\033[0m\\r\\n\\033[36m\\342\\235\\257 1. Yes\\033[39m\\r\\n  2. No, and tell Claude what to do differently (esc)\\r\\n'
read answer
i=0
while [ $i -lt 40 ]; do echo "working $i"; i=$((i+1)); sleep 0.1; done
echo "all done"
exec sleep 600
`;

let root: string;
let engine: EngineProc | undefined;
let c: Client;

type Activity = TerminalActivity;

async function activityOf(terminalId: string): Promise<Activity | undefined> {
  const { projects } = await c.req<{ projects: { projectId: string; terminals: TerminalInfo[] }[] }>("agents.summary", {});
  return projects.flatMap((p) => p.terminals).find((t) => t.id === terminalId)?.activity;
}

async function waitForState(terminalId: string, state: Activity["state"]): Promise<Activity> {
  const start = Date.now();
  for (;;) {
    const a = await activityOf(terminalId);
    if (a?.state === state) return a;
    if (Date.now() - start > STATE_TIMEOUT_MS) throw new Error(`timeout waiting for ${state}, last: ${JSON.stringify(a)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function activityEvents(terminalId: string) {
  return c.frames.filter(
    (f): f is Extract<ServerMessage, { name: "terminal.activity" }> =>
      f.type === "event" && f.name === "terminal.activity" && f.terminalId === terminalId,
  );
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-agents-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const configPath = join(root, "engine.json");
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
      activityWindowMs: WINDOW_MS,
      activityDebounceMs: 50,
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
}, 30_000);

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("İş A end-to-end", () => {
  it("the built-in claude tool ships with waiting patterns", async () => {
    const { tools } = await c.req<{ tools: { id: string; waitingPatterns?: string[] }[] }>("tools.list", {});
    expect(tools.find((t) => t.id === "claude")?.waitingPatterns?.length).toBeGreaterThan(0);
  });

  it("Claude asking for permission → waiting; answering → running; silence → idle", async () => {
    const { terminal } = await c.req<{ terminal: TerminalInfo }>("terminal.open", { projectId: "mac-mini", toolId: "claude", ...DIMS });
    expect(terminal.activity?.state).toBeDefined();
    await c.waitForOutput(terminal.id, /1\. Yes/);

    const waiting = await waitForState(terminal.id, "waiting");
    expect(waiting.summary).toMatch(/No, and tell Claude/);
    // It stays waiting while the prompt is on screen, long after output stopped.
    await new Promise((r) => setTimeout(r, WINDOW_MS * 2));
    expect((await activityOf(terminal.id))?.state).toBe("waiting");
    // Every client hears about it.
    await c.waitFor((f) => f.type === "event" && f.name === "terminal.activity" && f.terminalId === terminal.id && f.activity.state === "waiting");
    expect(activityEvents(terminal.id).at(-1)).toMatchObject({ projectId: "mac-mini" });

    c.input(terminal.id, "1\r");
    const running = await waitForState(terminal.id, "running");
    expect(running.summary).toMatch(/working \d+/);
    const idle = await waitForState(terminal.id, "idle");
    expect(idle.summary).toBe("all done");
    await c.req("terminal.close", { terminalId: terminal.id });
  }, 30_000);

  it("a terminal that keeps printing is running the whole time", async () => {
    const { terminal } = await c.req<{ terminal: TerminalInfo }>("terminal.open", {
      projectId: "mac-mini",
      command: "i=0; while [ $i -lt 30 ]; do echo tick $i; i=$((i+1)); sleep 0.1; done",
      ...DIMS,
    });
    await waitForState(terminal.id, "running");
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 300));
      expect((await activityOf(terminal.id))?.state).toBe("running");
    }
    await c.req("terminal.close", { terminalId: terminal.id });
  }, 30_000);

  it("a bell after the user's command → waiting; an exited terminal → exited", async () => {
    const { terminal } = await c.req<{ terminal: TerminalInfo }>("terminal.open", { projectId: "mac-mini", toolId: null, ...DIMS });
    c.input(terminal.id, "printf 'ready\\a'\r");
    await waitForState(terminal.id, "waiting");
    c.input(terminal.id, "exit\r");
    await waitForState(terminal.id, "exited");
  }, 30_000);

  it("agents.summary groups terminals by project; closed terminals disappear", async () => {
    const { terminal } = await c.req<{ terminal: TerminalInfo }>("terminal.open", { projectId: "mac-mini", toolId: null, ...DIMS });
    const { projects } = await c.req<{ projects: { projectId: string; terminals: TerminalInfo[] }[] }>("agents.summary", {});
    expect(projects.map((p) => p.projectId)).toEqual(["mac-mini"]);
    expect(projects[0]!.terminals.some((t) => t.id === terminal.id)).toBe(true);
    await c.req("terminal.close", { terminalId: terminal.id });
    expect(await activityOf(terminal.id)).toBeUndefined();
  }, 30_000);
});
