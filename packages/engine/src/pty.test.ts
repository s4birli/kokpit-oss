import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePty from "node-pty";
import type { Card, TerminalInfo } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore as MemoryStateStore } from "../test/fakes/memory-store.ts";
import { EngineError, type DataPaths, type EngineConfig, type LaunchSpec, type Logger, type PtyManager } from "./contracts.ts";
import { createPtyManager, inheritedEnv, type PtyManagerDeps } from "./pty.ts";

// Test timing knobs (production values come from config via main.ts).
const FLUSH_MS = 20;
const GRACE_MS = 300;
const BUFFER_BYTES = 64 * 1024;
const WAIT_MS = 10_000;

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const TEST_SHELL = "/bin/sh";

/** What launch.ts would build for a local terminal: the shell in `cwd`, typing `command` if given. */
function shellLaunch(cwd: string, command?: string): LaunchSpec {
  return {
    file: TEST_SHELL,
    args: [],
    cwd,
    title: command ?? "sh",
    ...(command !== undefined ? { initialInput: command + "\r" } : {}),
  };
}

function openCard(m: PtyManager, card: Card, opts: { cols: number; rows: number; command?: string }): TerminalInfo {
  return m.open({ projectId: card.projectId, cardId: card.id }, shellLaunch(card.worktreePath, opts.command), {
    cols: opts.cols,
    rows: opts.rows,
  });
}

function makeConfig(dataDir: string, over: Partial<EngineConfig> = {}): EngineConfig {
  return {
    configPath: join(dataDir, "config.json"),
    port: 0,
    dataDir,
    bufferBytes: BUFFER_BYTES,
    shell: "/bin/sh",
    shellArgs: [],
    branchPrefix: "kokpit/",
    baseBranch: null,
    authTimeoutMs: 1000,
    tailscaleRescanMs: 1000,
    listenLocalhost: true,
    listenTailscale: false,
    tailscaleCidrs: [],
    key: "test-key",
    projects: [],
    ...over,
  };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = WAIT_MS): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected EngineError(${code})`);
}

// ---------------------------------------------------------------- real node-pty

describe("PtyManager (real pty)", () => {
  let root: string;
  let paths: DataPaths;
  let store: MemoryStateStore;
  let pids: number[];
  let managers: PtyManager[];
  let config: EngineConfig;

  /** Resolve when each spawned process has exited (its onExit may still write a buffer file). */
  let exits: Promise<void>[];

  const trackingSpawn: typeof nodePty.spawn = (file, args, opts) => {
    const p = nodePty.spawn(file, args, opts);
    pids.push(p.pid);
    exits.push(new Promise<void>((r) => p.onExit(() => r())));
    return p;
  };

  function makeCard(id: string): Card {
    const worktreePath = join(root, "worktrees", id);
    mkdirSync(worktreePath, { recursive: true });
    const card: Card = {
      id,
      projectId: "p1",
      name: id,
      branch: `kokpit/${id}`,
      worktreePath,
      createdAt: new Date().toISOString(),
    };
    store.addCard(card);
    return card;
  }

  function manager(over: Partial<EngineConfig> = {}): PtyManager {
    const m = createPtyManager({
      config: { ...config, ...over },
      paths,
      store,
      logger: silentLogger,
      flushIntervalMs: FLUSH_MS,
      killGraceMs: GRACE_MS,
      spawn: trackingSpawn,
    });
    managers.push(m);
    return m;
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-pty-")));
    paths = {
      stateFile: join(root, "state.json"),
      buffersDir: join(root, "buffers"),
      worktreesDir: join(root, "worktrees"),
      reposDir: join(root, "repos"),
    };
    store = new MemoryStateStore();
    pids = [];
    exits = [];
    managers = [];
    config = makeConfig(root);
  });

  afterEach(async () => {
    for (const m of managers) await m.shutdown();
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    // A process that exits after the rm would have its buffer written back, recreating the temp dir.
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, WAIT_MS))]);
    rmSync(root, { recursive: true, force: true });
  });

  it("starts in the card worktree and runs the command option", async () => {
    const m = manager();
    const card = makeCard("c1");
    const t = openCard(m, card, { cols: 80, rows: 24, command: "pwd; echo h''i" });
    expect(t.status).toBe("running");
    expect(t.title).toBe("pwd; echo h''i");
    expect(t.command).toBe("pwd; echo h''i");
    expect(store.getTerminal(t.id)?.status).toBe("running");
    await waitFor(() => /(^|\n)hi\r?\n/.test(m.history(t.id)), "echo hi");
    expect(m.history(t.id)).toContain(card.worktreePath);
  });

  it("title comes from the launch spec; no command without initialInput", () => {
    const m = manager();
    const t = openCard(m, makeCard("c1"), { cols: 80, rows: 24 });
    expect(t.title).toBe("sh");
    expect(t.command).toBeUndefined();
  });

  it("exports TERM, COLORTERM and Kokpit ids to the shell", async () => {
    const m = manager();
    const t = openCard(m, makeCard("c1"), { cols: 80, rows: 24 });
    m.write(t.id, 'echo "[$KOKPIT_PROJECT_ID|$KOKPIT_CARD_ID|$KOKPIT_TERMINAL_ID|$TERM|$COLORTERM]"\r');
    await waitFor(() => m.history(t.id).includes(`[p1|c1|${t.id}|xterm-256color|truecolor]`), "env echo");
  });

  it("streams output to subscribers; after unsubscribe output still lands in history", async () => {
    const m = manager();
    const t = openCard(m, makeCard("c1"), { cols: 80, rows: 24 });
    let seen = "";
    const unsubscribe = m.subscribe(t.id, { onData: (d) => (seen += d), onExit: () => {} });
    m.write(t.id, "echo $((2+3))SUB\r");
    await waitFor(() => seen.includes("5SUB"), "subscriber output");

    unsubscribe(); // app closed
    const before = seen;
    m.write(t.id, "echo $((3+4))AWAY\r");
    await waitFor(() => m.history(t.id).includes("7AWAY"), "output while detached");
    expect(seen).toBe(before);
    expect(m.get(t.id)?.status).toBe("running"); // unsubscribing never touches the process
  });

  it("respects the buffer cap with long output", async () => {
    const cap = 2048;
    const m = manager({ bufferBytes: cap });
    const t = openCard(m, makeCard("c1"), {
      cols: 80,
      rows: 24,
      command: 'i=0; while [ $i -lt 500 ]; do echo "line$i"; i=$((i+1)); done; echo $((1+1))END',
    });
    await waitFor(() => m.history(t.id).includes("2END"), "loop end");
    const h = m.history(t.id);
    expect(Buffer.byteLength(h, "utf8")).toBeLessThanOrEqual(cap);
    expect(h).toContain("line499");
    expect(h).not.toMatch(/(^|\n)line0\r?\n/);
  });

  it("two terminals in two cards never mix output", async () => {
    const m = manager();
    const a = openCard(m, makeCard("ca"), { cols: 80, rows: 24 });
    const b = openCard(m, makeCard("cb"), { cols: 80, rows: 24 });
    let seenA = "";
    let seenB = "";
    m.subscribe(a.id, { onData: (d) => (seenA += d), onExit: () => {} });
    m.subscribe(b.id, { onData: (d) => (seenB += d), onExit: () => {} });
    m.write(a.id, "echo $((100+11))AAA\r");
    m.write(b.id, "echo $((200+22))BBB\r");
    await waitFor(() => seenA.includes("111AAA") && seenB.includes("222BBB"), "both outputs");
    expect(seenA).not.toContain("BBB");
    expect(seenB).not.toContain("AAA");
    expect(m.history(a.id)).not.toContain("BBB");
    expect(m.history(b.id)).not.toContain("AAA");
    expect(m.list({ cardId: "ca" }).map((t) => t.id)).toEqual([a.id]);
    expect(m.list({ cardId: "cb" }).map((t) => t.id)).toEqual([b.id]);
  });

  it("exit sets status and exitCode, notifies subscribers, keeps history", async () => {
    const m = manager();
    const t = openCard(m, makeCard("c1"), { cols: 80, rows: 24 });
    const exits: (number | null)[] = [];
    m.subscribe(t.id, { onData: () => {}, onExit: (c) => exits.push(c) });
    m.write(t.id, "echo $((5+5))BYE; exit 3\r");
    await waitFor(() => m.get(t.id)?.status === "exited", "exit");
    expect(m.get(t.id)?.exitCode).toBe(3);
    expect(store.getTerminal(t.id)?.exitCode).toBe(3);
    expect(exits).toEqual([3]);
    expect(m.history(t.id)).toContain("10BYE");
    expectCode(() => m.write(t.id, "x"), "TERMINAL_EXITED");
    expect(() => m.resize(t.id, 100, 40)).not.toThrow();
  });

  it("engine restart: a new manager shows the old terminal exited, with its history", async () => {
    const m1 = manager();
    const t = openCard(m1, makeCard("c1"), { cols: 80, rows: 24 });
    m1.write(t.id, "echo $((20+1))OLD\r");
    await waitFor(() => m1.history(t.id).includes("21OLD"), "old output");
    await waitFor(() => existsSync(join(paths.buffersDir, `${t.id}.log`)), "buffer persisted");
    await new Promise((r) => setTimeout(r, FLUSH_MS * 3));
    // Simulated crash: m1 never shut down, so the store still says "running".
    expect(store.getTerminal(t.id)?.status).toBe("running");

    const m2 = manager();
    const restored = m2.get(t.id);
    expect(restored?.status).toBe("exited");
    expect(restored?.exitCode).toBeNull();
    expect(store.getTerminal(t.id)?.status).toBe("exited");
    expect(m2.history(t.id)).toContain("21OLD");
    expectCode(() => m2.write(t.id, "x"), "TERMINAL_EXITED");
  });

  it("close kills the process and removes record + buffer file", async () => {
    const m = manager();
    const t = openCard(m, makeCard("c1"), { cols: 80, rows: 24 });
    const pid = pids.at(-1) as number;
    m.write(t.id, "echo $((1+2))X\r");
    const file = join(paths.buffersDir, `${t.id}.log`);
    await waitFor(() => existsSync(file), "buffer file");
    m.close(t.id);
    expect(store.getTerminal(t.id)).toBeUndefined();
    expect(m.get(t.id)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    await waitFor(() => !isAlive(pid), "process gone");
    expect(() => process.kill(pid, 0)).toThrow();
    expectCode(() => m.history(t.id), "NOT_FOUND");
    await new Promise((r) => setTimeout(r, FLUSH_MS * 3));
    expect(existsSync(file)).toBe(false); // no late write resurrects it
  });

  it("closeAllForCard closes only that card's terminals", async () => {
    const m = manager();
    const a1 = openCard(m, makeCard("ca"), { cols: 80, rows: 24 });
    const a2 = openCard(m, store.getCard("ca") as Card, { cols: 80, rows: 24 });
    const b = openCard(m, makeCard("cb"), { cols: 80, rows: 24 });
    m.closeAllForCard("ca");
    expect(m.list({ cardId: "ca" })).toEqual([]);
    expect(m.get(a1.id)).toBeUndefined();
    expect(m.get(a2.id)).toBeUndefined();
    expect(m.get(b.id)?.status).toBe("running");
  });

  it("resize changes stty size", async () => {
    const m = manager();
    const t = openCard(m, makeCard("c1"), { cols: 80, rows: 24 });
    m.resize(t.id, 101, 33);
    m.write(t.id, "stty size\r");
    await waitFor(() => m.history(t.id).includes("33 101"), "stty size");
  });

  it("round-trips unicode and emoji", async () => {
    const m = manager();
    const t = openCard(m, makeCard("c1"), { cols: 80, rows: 24 });
    let seen = "";
    m.subscribe(t.id, { onData: (d) => (seen += d), onExit: () => {} });
    // Octal escapes: the typed command is ASCII, so the glyphs can only come from the output.
    m.write(t.id, "printf '[\\305\\237\\360\\237\\231\\202\\344\\270\\255]\\n'\r");
    await waitFor(() => seen.includes("[ş🙂中]"), "decoded output");
    expect(m.history(t.id)).toContain("[ş🙂中]");
    m.write(t.id, "echo 'ğ👩‍💻'\r");
    await waitFor(() => /\nğ👩‍💻\r?\n/.test(m.history(t.id)), "typed unicode echoed back");
  });

  it("shutdown flushes buffers and kills processes", async () => {
    const m = manager();
    const t = openCard(m, makeCard("c1"), { cols: 80, rows: 24 });
    const pid = pids.at(-1) as number;
    m.write(t.id, "echo $((9+9))FLUSH\r");
    await waitFor(() => m.history(t.id).includes("18FLUSH"), "output");
    await m.shutdown();
    await waitFor(() => !isAlive(pid), "process gone");
    const m2 = manager();
    expect(m2.history(t.id)).toContain("18FLUSH");
  });
});

// ---------------------------------------------------------------- fake spawn

class FakePty {
  static nextPid = 900_000;
  readonly pid = FakePty.nextPid++;
  cols: number;
  rows: number;
  readonly writes: string[] = [];
  readonly kills: (string | undefined)[] = [];
  readonly resizes: [number, number][] = [];
  exited = false;
  /** Signals that make this fake exit. */
  dieOn = new Set(["SIGHUP", "SIGKILL"]);
  #data: ((d: string) => void)[] = [];
  #exit: ((e: { exitCode: number; signal?: number }) => void)[] = [];

  readonly file: string;
  readonly args: string[] | string;
  readonly opts: nodePty.IPtyForkOptions;

  constructor(file: string, args: string[] | string, opts: nodePty.IPtyForkOptions) {
    this.file = file;
    this.args = args;
    this.opts = opts;
    this.cols = opts.cols ?? 0;
    this.rows = opts.rows ?? 0;
  }
  onData(cb: (d: string) => void) {
    this.#data.push(cb);
    return { dispose: () => {} };
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.#exit.push(cb);
    return { dispose: () => {} };
  }
  write(d: string) {
    this.writes.push(d);
  }
  resize(c: number, r: number) {
    if (this.exited) throw new Error("ioctl(2) failed, EBADF");
    this.resizes.push([c, r]);
  }
  kill(signal?: string) {
    this.kills.push(signal);
    if (this.dieOn.has(signal ?? "SIGHUP")) this.emitExit(0);
  }
  emitData(d: string) {
    for (const cb of this.#data) cb(d);
  }
  emitExit(exitCode: number) {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.#exit) cb({ exitCode });
  }
}

describe("PtyManager (fake spawn)", () => {
  let root: string;
  let paths: DataPaths;
  let store: MemoryStateStore;
  let ptys: FakePty[];
  let ids: number;
  let card: Card;
  let errors: string[];

  const fakeSpawn = ((file: string, args: string[] | string, opts: nodePty.IPtyForkOptions) => {
    const p = new FakePty(file, args, opts);
    ptys.push(p);
    return p;
  }) as unknown as typeof nodePty.spawn;

  const logger: Logger = { info() {}, warn() {}, error: (msg) => errors.push(msg) };

  let managers: PtyManager[];

  function manager(over: Partial<EngineConfig> = {}, deps: Partial<PtyManagerDeps> = {}): PtyManager {
    return track(createPtyManager({
      ...deps,
      config: makeConfig(root, { shell: "/usr/bin/fakesh", shellArgs: ["-l"], ...over }),
      paths,
      store,
      logger,
      flushIntervalMs: FLUSH_MS,
      killGraceMs: GRACE_MS,
      spawn: fakeSpawn,
      newId: () => `t${++ids}`,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    }));
  }

  function track(m: PtyManager): PtyManager {
    managers.push(m);
    return m;
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-ptyfake-")));
    paths = { stateFile: join(root, "s.json"), buffersDir: join(root, "buffers"), worktreesDir: join(root, "wt"), reposDir: join(root, "repos") };
    store = new MemoryStateStore();
    ptys = [];
    managers = [];
    ids = 0;
    errors = [];
    const wt = join(root, "wt", "c1");
    mkdirSync(wt, { recursive: true });
    card = { id: "c1", projectId: "p", name: "c1", branch: "b", worktreePath: wt, createdAt: "x" };
    store.addCard(card);
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Pending buffer flushes would otherwise fire after the rm and recreate the temp dir.
    for (const p of ptys) p.emitExit(0);
    for (const m of managers) await m.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  it("spawns launch.file with launch.args in launch.cwd, with name and env; types initialInput", () => {
    const m = manager();
    const t = m.open(
      { projectId: "p", cardId: "c1", toolId: "claude" },
      { file: "/usr/bin/fakesh", args: ["-l"], cwd: card.worktreePath, initialInput: "claude\r", title: "Claude" },
      { cols: 90, rows: 30 },
    );
    const p = ptys[0] as FakePty;
    expect(p.file).toBe("/usr/bin/fakesh");
    expect(p.args).toEqual(["-l"]);
    expect(p.opts.cwd).toBe(card.worktreePath);
    expect(p.opts.name).toBe("xterm-256color");
    expect([p.opts.cols, p.opts.rows]).toEqual([90, 30]);
    expect(p.opts.env?.TERM).toBe("xterm-256color");
    expect(p.opts.env?.COLORTERM).toBe("truecolor");
    expect(p.opts.env?.KOKPIT_PROJECT_ID).toBe("p");
    expect(p.opts.env?.KOKPIT_CARD_ID).toBe("c1");
    expect(p.opts.env?.KOKPIT_TERMINAL_ID).toBe("t1");
    expect(p.opts.env?.PATH).toBe(inheritedEnv(process.env).PATH);
    expect(p.writes).toEqual(["claude\r"]);
    const expected: TerminalInfo = {
      id: "t1",
      projectId: "p",
      cardId: "c1",
      toolId: "claude",
      title: "Claude",
      command: "claude",
      status: "running",
      createdAt: "2026-01-02T03:04:05.000Z",
    };
    expect(t).toEqual(expected);
    expect(store.getTerminal("t1")).toEqual(expected);
  });

  it("never passes inherited KOKPIT_* variables (an engine started inside a Kokpit terminal) nor that terminal's shim dir", () => {
    const names = ["KOKPIT_OPEN_ID", "KOKPIT_OPEN_KEY_IPAD", "KOKPIT_SHIM_DIR", "KOKPIT_TERMINAL_ID", "KOKPIT_PROJECT_ID", "KOKPIT_CARD_ID", "KOKPIT_CDP_URL", "KOKPIT_KEY", "KOKPIT_SCREEN_GRANT"];
    const saved = Object.fromEntries([...names, "PATH"].map((n) => [n, process.env[n]]));
    for (const n of names) process.env[n] = `inherited-${n}`;
    process.env.KOKPIT_SHIM_DIR = "/tmp/parent-terminal/shim";
    process.env.PATH = `/tmp/parent-terminal/shim:${saved.PATH ?? "/usr/bin"}`;
    try {
      const launch: LaunchSpec = { file: "/bin/sh", args: [], cwd: card.worktreePath, title: "sh", env: { KOKPIT_OPEN_ID: "mine" } };
      manager().open({ projectId: "p" }, launch, { cols: 80, rows: 24 });
      const env = ptys[0]!.opts.env!;
      const kokpit = Object.keys(env).filter((k) => k.startsWith("KOKPIT_")).sort();
      // Only what the engine decides for THIS terminal: its project, its id, and what the launch set.
      expect(kokpit).toEqual(["KOKPIT_OPEN_ID", "KOKPIT_PROJECT_ID", "KOKPIT_TERMINAL_ID"]);
      expect([env.KOKPIT_OPEN_ID, env.KOKPIT_PROJECT_ID, env.KOKPIT_TERMINAL_ID]).toEqual(["mine", "p", "t1"]);
      expect(env.PATH!.split(":")).not.toContain("/tmp/parent-terminal/shim");
      expect(env.PATH).toBe(saved.PATH ?? "/usr/bin");
    } finally {
      for (const [n, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });

  it("never passes the engine's inherited ZDOTDIR to a terminal; a configured one is used instead", () => {
    const saved = process.env.ZDOTDIR;
    process.env.ZDOTDIR = "/engine/dev/shell/zdotdir";
    try {
      const launch: LaunchSpec = { file: "/bin/zsh", args: [], cwd: card.worktreePath, title: "zsh" };
      manager().open({ projectId: "p" }, launch, { cols: 80, rows: 24 });
      expect(ptys[0]?.opts.env).not.toHaveProperty("ZDOTDIR");
      expect(ptys[0]?.opts.env?.HOME).toBe(process.env.HOME);
      manager({}, { zdotdir: "/configured/zdotdir" }).open({ projectId: "p" }, launch, { cols: 80, rows: 24 });
      expect(ptys[1]?.opts.env?.ZDOTDIR).toBe("/configured/zdotdir");
    } finally {
      if (saved === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = saved;
    }
  });

  it("İş H: never inherits the engine's CLAUDE_CONFIG_DIR; only the launch's own env sets it", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/engine/own/claude";
    try {
      const launch: LaunchSpec = { file: "/bin/zsh", args: [], cwd: card.worktreePath, title: "zsh" };
      const m = manager();
      m.open({ projectId: "p" }, launch, { cols: 80, rows: 24 });
      expect(ptys[0]?.opts.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      m.open({ projectId: "p" }, { ...launch, env: { CLAUDE_CONFIG_DIR: "/h/.claude-work" } }, { cols: 80, rows: 24 });
      expect(ptys[1]?.opts.env?.CLAUDE_CONFIG_DIR).toBe("/h/.claude-work");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it("ignores config.shell: ssh launches spawn their own file and args", () => {
    const m = manager();
    const args = ["-t", "--", "oracle", "cd '/srv' && exec \"$SHELL\" -l"];
    m.open({ projectId: "p" }, { file: "/usr/bin/ssh", args, cwd: root, title: "oracle" }, { cols: 80, rows: 24 });
    expect(ptys[0]?.file).toBe("/usr/bin/ssh");
    expect(ptys[0]?.args).toEqual(args);
  });

  it("project terminal: no card id in record or env, KOKPIT_PROJECT_ID set", () => {
    const m = manager();
    const t = m.open({ projectId: "p" }, { file: "/bin/sh", args: [], cwd: root, title: "sh" }, { cols: 80, rows: 24 });
    const env = ptys[0]?.opts.env ?? {};
    expect(env.KOKPIT_PROJECT_ID).toBe("p");
    expect("KOKPIT_CARD_ID" in env).toBe(false);
    expect(t).toEqual({ id: "t1", projectId: "p", title: "sh", status: "running", createdAt: "2026-01-02T03:04:05.000Z" });
  });

  it("does not inherit a stale KOKPIT_CARD_ID from the engine's own env", () => {
    process.env.KOKPIT_CARD_ID = "leaked";
    try {
      manager().open({ projectId: "p" }, { file: "/bin/sh", args: [], cwd: root, title: "sh" }, { cols: 80, rows: 24 });
      expect(ptys[0]?.opts.env?.KOKPIT_CARD_ID).toBeUndefined();
    } finally {
      delete process.env.KOKPIT_CARD_ID;
    }
  });

  it("command is initialInput without its trailing carriage return", () => {
    const m = manager();
    const t = m.open(
      { projectId: "p" },
      { file: "/bin/sh", args: [], cwd: root, title: "x", initialInput: "npm i -g x\r" },
      { cols: 80, rows: 24 },
    );
    expect(t.command).toBe("npm i -g x");
    expect(ptys[0]?.writes).toEqual(["npm i -g x\r"]);
  });

  it("list filters by card or project; closeAllForProject closes card and project terminals of that project only", () => {
    const m = manager();
    const sh = (cwd: string): LaunchSpec => ({ file: "/bin/sh", args: [], cwd, title: "sh" });
    const pc = m.open({ projectId: "p", cardId: "c1" }, sh(card.worktreePath), { cols: 80, rows: 24 });
    const pp = m.open({ projectId: "p" }, sh(root), { cols: 80, rows: 24 });
    const q = m.open({ projectId: "q" }, sh(root), { cols: 80, rows: 24 });
    expect(m.list({ cardId: "c1" }).map((t) => t.id)).toEqual([pc.id]);
    expect(m.list({ projectId: "p" }).map((t) => t.id).sort()).toEqual([pc.id, pp.id].sort());
    expect(m.list({ projectId: "q" }).map((t) => t.id)).toEqual([q.id]);
    m.closeAllForProject("p");
    expect(m.list({ projectId: "p" })).toEqual([]);
    expect(ptys[0]?.kills).toEqual(["SIGHUP"]);
    expect(ptys[1]?.kills).toEqual(["SIGHUP"]);
    expect(ptys[2]?.kills).toEqual([]);
    expect(m.get(q.id)?.status).toBe("running");
  });

  it("does not type anything without a command", () => {
    openCard(manager(), card, { cols: 80, rows: 24 });
    expect(ptys[0]?.writes).toEqual([]);
  });

  it("refuses a launch whose cwd is missing", () => {
    const m = manager();
    expectCode(() => openCard(m, { ...card, worktreePath: join(root, "nope") }, { cols: 80, rows: 24 }), "NOT_FOUND");
    expect(ptys).toEqual([]);
  });

  it("unknown terminal ids → NOT_FOUND", () => {
    const m = manager();
    expectCode(() => m.history("zz"), "NOT_FOUND");
    expectCode(() => m.write("zz", "x"), "NOT_FOUND");
    expectCode(() => m.resize("zz", 1, 1), "NOT_FOUND");
    expectCode(() => m.close("zz"), "NOT_FOUND");
    expectCode(() => m.subscribe("zz", { onData() {}, onExit() {} }), "NOT_FOUND");
    expect(m.get("zz")).toBeUndefined();
    expect(m.list({ cardId: "nope" })).toEqual([]);
  });

  it("path-like ids never reach the filesystem", () => {
    const m = manager();
    expectCode(() => m.history("../../etc/passwd"), "NOT_FOUND");
  });

  it("a throwing listener does not break the others", () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    let got = "";
    let exited: number | null | undefined;
    m.subscribe(t.id, {
      onData: () => {
        throw new Error("boom");
      },
      onExit: () => {
        throw new Error("boom");
      },
    });
    m.subscribe(t.id, { onData: (d) => (got += d), onExit: (c) => (exited = c) });
    (ptys[0] as FakePty).emitData("hello");
    (ptys[0] as FakePty).emitExit(7);
    expect(got).toBe("hello");
    expect(exited).toBe(7);
    expect(m.history(t.id)).toBe("hello");
  });

  it("subscribe on an exited terminal is a harmless no-op", () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    (ptys[0] as FakePty).emitExit(0);
    const unsub = m.subscribe(t.id, { onData() {}, onExit() {} });
    expect(() => unsub()).not.toThrow();
  });

  it("unsubscribing twice is fine", () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    const unsub = m.subscribe(t.id, { onData() {}, onExit() {} });
    unsub();
    expect(() => unsub()).not.toThrow();
    expect((ptys[0] as FakePty).kills).toEqual([]);
  });

  it("resize forwards to the pty while running, no-op once exited", () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    m.resize(t.id, 120, 40);
    expect((ptys[0] as FakePty).resizes).toEqual([[120, 40]]);
    (ptys[0] as FakePty).emitExit(0);
    expect(() => m.resize(t.id, 10, 10)).not.toThrow();
    expect((ptys[0] as FakePty).resizes).toEqual([[120, 40]]);
  });

  it("onExit persists status and flushes the buffer immediately", () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    const p = ptys[0] as FakePty;
    p.emitData("last words");
    p.emitExit(2);
    expect(store.getTerminal(t.id)).toMatchObject({ status: "exited", exitCode: 2 });
    expect(manager().history(t.id)).toBe("last words");
  });

  it("output is persisted after the flush interval", async () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    (ptys[0] as FakePty).emitData("abc");
    await waitFor(() => existsSync(join(paths.buffersDir, `${t.id}.log`)), "flush");
    expect(manager().history(t.id)).toBe("abc");
  });

  it("caps history at config.bufferBytes", () => {
    const m = manager({ bufferBytes: 10 });
    const t = openCard(m, card, { cols: 80, rows: 24 });
    (ptys[0] as FakePty).emitData("x".repeat(25));
    expect(m.history(t.id)).toBe("x".repeat(10));
  });

  it("construction marks leftover running terminals exited (exitCode null) and persists", () => {
    store.upsertTerminal({ id: "old", projectId: "p", cardId: "c1", title: "sh", status: "running", createdAt: "x" });
    store.upsertTerminal({ id: "done", projectId: "p", cardId: "c1", title: "sh", status: "exited", exitCode: 4, createdAt: "x" });
    const m = manager();
    expect(store.getTerminal("old")).toMatchObject({ status: "exited", exitCode: null });
    expect(store.getTerminal("done")).toMatchObject({ status: "exited", exitCode: 4 });
    expect(m.history("old")).toBe("");
    expectCode(() => m.write("old", "x"), "TERMINAL_EXITED");
  });

  it("close sends SIGHUP and removes the record", () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    m.close(t.id);
    expect((ptys[0] as FakePty).kills).toEqual(["SIGHUP"]);
    expect(store.getTerminal(t.id)).toBeUndefined();
  });

  it("close escalates to SIGKILL after killGraceMs if SIGHUP is ignored", () => {
    vi.useFakeTimers();
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    const p = ptys[0] as FakePty;
    p.dieOn = new Set(["SIGKILL"]);
    m.close(t.id);
    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(p.kills).toEqual(["SIGHUP"]);
    vi.advanceTimersByTime(1);
    expect(p.kills).toEqual(["SIGHUP", "SIGKILL"]);
  });

  it("close of an exited terminal does not signal, still forgets it", () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    (ptys[0] as FakePty).emitExit(0);
    m.close(t.id);
    expect((ptys[0] as FakePty).kills).toEqual([]);
    expect(m.get(t.id)).toBeUndefined();
  });

  it("close of a restored (dead) terminal removes record and buffer", () => {
    store.upsertTerminal({ id: "old", projectId: "p", cardId: "c1", title: "sh", status: "running", createdAt: "x" });
    mkdirSync(paths.buffersDir, { recursive: true });
    const m = manager();
    m.close("old");
    expect(store.getTerminal("old")).toBeUndefined();
    expect(existsSync(join(paths.buffersDir, "old.log"))).toBe(false);
  });

  it("after close, late output and exit change nothing", () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    const p = ptys[0] as FakePty;
    p.dieOn = new Set();
    m.close(t.id);
    p.emitData("late");
    p.emitExit(0);
    expect(store.getTerminal(t.id)).toBeUndefined();
    expect(existsSync(join(paths.buffersDir, `${t.id}.log`))).toBe(false);
  });

  // İş K: what a launch prepared for its terminal (a temp MCP config, a grant) is released when the process ends.
  it("launch.onExit runs once when the process exits by itself", () => {
    const m = manager();
    let released = 0;
    m.open({ projectId: "p" }, { ...shellLaunch(card.worktreePath), onExit: () => void released++ }, { cols: 80, rows: 24 });
    expect(released).toBe(0);
    (ptys[0] as FakePty).emitExit(0);
    (ptys[0] as FakePty).emitExit(0);
    expect(released).toBe(1);
  });

  it("launch.onExit runs at once when the terminal is closed, even if the process ignores the hangup", () => {
    const m = manager();
    let released = 0;
    const t = m.open({ projectId: "p" }, { ...shellLaunch(card.worktreePath), onExit: () => void released++ }, { cols: 80, rows: 24 });
    const p = ptys[0] as FakePty;
    p.dieOn = new Set();
    m.close(t.id);
    expect(released).toBe(1);
    p.emitExit(0);
    expect(released).toBe(1);
  });

  it("launch.onExit runs when the spawn fails, and a throwing hook breaks nothing", () => {
    let released = 0;
    const failing = (() => {
      throw new Error("spawn failed");
    }) as unknown as typeof nodePty.spawn;
    const bad = track(createPtyManager({ config: makeConfig(root), paths, store, logger, flushIntervalMs: FLUSH_MS, killGraceMs: GRACE_MS, spawn: failing }));
    expectCode(() => bad.open({ projectId: "p" }, { ...shellLaunch(card.worktreePath), onExit: () => void released++ }, { cols: 80, rows: 24 }), "INTERNAL");
    expect(released).toBe(1);
    expectCode(() => bad.open({ projectId: "p" }, { ...shellLaunch(join(root, "yok")), onExit: () => void released++ }, { cols: 80, rows: 24 }), "NOT_FOUND");
    expect(released).toBe(2);

    const m = manager();
    const t = m.open(
      { projectId: "p" },
      {
        ...shellLaunch(card.worktreePath),
        onExit: () => {
          throw new Error("hook failed");
        },
      },
      { cols: 80, rows: 24 },
    );
    expect(() => (ptys[ptys.length - 1] as FakePty).emitExit(3)).not.toThrow();
    expect(store.getTerminal(t.id)).toMatchObject({ status: "exited", exitCode: 3 });
  });

  it("shutdown flushes buffers, then kills, and waits for exit", async () => {
    const m = manager();
    const t = openCard(m, card, { cols: 80, rows: 24 });
    const p = ptys[0] as FakePty;
    p.emitData("keep me");
    await m.shutdown();
    expect(p.kills[0]).toBe("SIGHUP");
    expect(p.exited).toBe(true);
    expect(manager().history(t.id)).toBe("keep me");
  });

  it("shutdown escalates to SIGKILL for stubborn processes", async () => {
    const m = manager();
    openCard(m, card, { cols: 80, rows: 24 });
    const p = ptys[0] as FakePty;
    p.dieOn = new Set(["SIGKILL"]);
    await m.shutdown();
    expect(p.kills).toEqual(["SIGHUP", "SIGKILL"]);
  });

  it("logs, rather than throws, when a background flush fails", async () => {
    const m = createPtyManager({
      config: makeConfig(root),
      paths: { ...paths, buffersDir: "/dev/null/nope" },
      store,
      logger,
      flushIntervalMs: FLUSH_MS,
      killGraceMs: GRACE_MS,
      spawn: fakeSpawn,
      newId: () => "tx",
    });
    openCard(m, card, { cols: 80, rows: 24 });
    (ptys[0] as FakePty).emitData("x");
    await waitFor(() => errors.length > 0, "error logged");
    expect(() => (ptys[0] as FakePty).emitExit(0)).not.toThrow();
  });
});
