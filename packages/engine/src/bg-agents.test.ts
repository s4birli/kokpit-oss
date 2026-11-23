// İş A (Adım 7) — arka plan ajanları: parser, cwd → project/card mapping, state mapping, polling, actions.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BgAgentSessionSchema, type Card, type Project } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineError, type Logger } from "./contracts.ts";
import {
  buildTargets,
  createBgAgentsService,
  mapSession,
  matchTarget,
  parseAgents,
  type BgAgentsOptions,
  type RawAgent,
} from "./bg-agents.ts";
import type { RunResult } from "./exec-runner.ts";

const FIXTURE = fileURLToPath(new URL("../test/fixtures/claude-agents/agents-all.json", import.meta.url));
const fixtureText = (): string => readFileSync(FIXTURE, "utf8");
const silent: Logger = { info() {}, warn() {}, error() {} };
const identity = (p: string): string => p;

const project = (id: string, path: string, extra: Partial<Project> = {}): Project => ({
  id,
  name: id,
  location: { kind: "local", path },
  ...extra,
});
const card = (id: string, projectId: string, worktreePath: string): Card => ({
  id,
  projectId,
  name: id,
  branch: `kokpit/${id}`,
  worktreePath,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("parseAgents", () => {
  it("parses the sanitized real fixture, ignoring extra fields", () => {
    const agents = parseAgents(fixtureText());
    const raw = JSON.parse(fixtureText()) as unknown[];
    expect(agents).toHaveLength(raw.length);
    expect(agents[0]).toEqual({
      id: "9e3779b1",
      name: "Alfa testlerini düzelt",
      cwd: "/Users/ornek/projeler/alfa",
      kind: "background",
      state: "done",
      startedAt: "2026-10-21T16:26:40.000Z",
    });
    expect(agents.some((a) => a.status === "busy")).toBe(true);
  });

  it("skips malformed entries but keeps good ones", () => {
    const text = JSON.stringify([
      { id: "ok-1", cwd: "/a", state: "busy" },
      { id: "-rf", cwd: "/a", state: "busy" },
      { id: "a b", cwd: "/a", state: "busy" },
      { id: 5, cwd: "/a", state: "busy" },
      { id: "no-cwd", state: "busy" },
      null,
      "x",
      { id: "ok-2", cwd: "/b", state: "idle", startedAt: "nonsense", name: 3 },
    ]);
    expect(parseAgents(text).map((a) => a.id)).toEqual(["ok-1", "ok-2"]);
    expect(parseAgents(text)[1]!.startedAt).toBeUndefined();
    expect(parseAgents(text)[1]!.name).toBe("ok-2");
  });

  it("accepts ISO string start times", () => {
    const [a] = parseAgents(JSON.stringify([{ id: "x", cwd: "/", state: "done", startedAt: "2026-11-16T10:00:00Z" }]));
    expect(a!.startedAt).toBe("2026-11-16T10:00:00.000Z");
  });

  it("rejects garbage with a Turkish CLAUDE_FAILED error", () => {
    for (const text of ["", "not json", "{}", '{"a":1}', "null", "42", "[1,2", "\u0000\u0001"]) {
      expect(() => parseAgents(text)).toThrow(EngineError);
      try {
        parseAgents(text);
      } catch (e) {
        expect((e as EngineError).code).toBe("CLAUDE_FAILED");
        expect((e as EngineError).message).toMatch(/beklenmeyen/);
      }
    }
  });

  it("monkey: random JSON never throws anything but EngineError, and output always validates", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const values = (): unknown =>
      pick([null, 0, -1, 1e20, "", "x", "busy", "-x", "../..", "/tmp", true, [], {}, "ä€😀", "a".repeat(300)]);
    for (let i = 0; i < 500; i++) {
      const arr = Array.from({ length: Math.floor(rnd() * 6) }, () =>
        Object.fromEntries(
          ["id", "cwd", "state", "status", "kind", "name", "startedAt", "pid", "__proto__x"]
            .filter(() => rnd() < 0.8)
            .map((k) => [k, values()]),
        ),
      );
      const out = parseAgents(JSON.stringify(arr));
      for (const a of out) {
        const s = mapSession(a, []);
        if (s) expect(BgAgentSessionSchema.safeParse(s).success).toBe(true);
      }
    }
  });
});

describe("state mapping", () => {
  const raw = (state: string, status?: string): RawAgent => ({ id: "x", name: "x", cwd: "/", state, ...(status ? { status } : {}) });
  it("blocked → waiting (approval), idle → waiting (input), busy/working → running, done → done", () => {
    expect(mapSession(raw("blocked"), [])).toMatchObject({ state: "waiting", waitingReason: "approval" });
    expect(mapSession(raw("blocked", "idle"), [])).toMatchObject({ state: "waiting", waitingReason: "approval" });
    expect(mapSession(raw("idle"), [])).toMatchObject({ state: "waiting", waitingReason: "input" });
    expect(mapSession(raw("busy"), [])).toEqual(expect.objectContaining({ state: "running" }));
    expect(mapSession(raw("working", "busy"), [])).toMatchObject({ state: "running" });
    expect(mapSession(raw("working", "busy"), [])!.waitingReason).toBeUndefined();
    expect(mapSession(raw("working"), [])).toMatchObject({ state: "running" });
    expect(mapSession(raw("done"), [])).toMatchObject({ state: "done" });
    expect(mapSession(raw("done", "idle"), [])).toMatchObject({ state: "done" });
  });
  it("a working session whose process is idle waits for the user (the CLI lists it under 'awaiting input')", () => {
    // Real `claude agents --json` output: state "working" + status "idle" when the turn ended and Claude waits.
    expect(mapSession(raw("working", "idle"), [])).toMatchObject({ state: "waiting", waitingReason: "input" });
  });
  it("unknown states count as running; interactive sessions are left out", () => {
    expect(mapSession(raw("thinking"), [])).toMatchObject({ state: "running" });
    expect(mapSession({ ...raw("busy"), kind: "interactive" }, [])).toBeUndefined();
    expect(mapSession({ ...raw("busy"), kind: "background" }, [])).toBeDefined();
  });
});

describe("cwd → project / card", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-bga-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("longest prefix on path boundaries; cards before projects; unmatched → none", () => {
    const projects = [project("home", "/Users/u", { builtin: true }), project("alfa", "/Users/u/alfa"), project("alfa2", "/Users/u/alfa2")];
    const cards = [card("k1", "alfa", "/data/wt/k1"), card("k2", "alfa", "/Users/u/alfa/.claude/worktrees/k2")];
    const targets = buildTargets(projects, cards, identity);
    expect(matchTarget("/Users/u/alfa", targets)).toEqual({ projectId: "alfa" });
    expect(matchTarget("/Users/u/alfa/src/x", targets)).toEqual({ projectId: "alfa" });
    expect(matchTarget("/Users/u/alfa2/src", targets)).toEqual({ projectId: "alfa2" });
    expect(matchTarget("/Users/u/alfabet", targets)).toEqual({ projectId: "home" });
    expect(matchTarget("/data/wt/k1/pkg", targets)).toEqual({ projectId: "alfa", cardId: "k1" });
    expect(matchTarget("/Users/u/alfa/.claude/worktrees/k2", targets)).toEqual({ projectId: "alfa", cardId: "k2" });
    expect(matchTarget("/Users/u/alfa/.claude/worktrees/k2/a/b", targets)).toEqual({ projectId: "alfa", cardId: "k2" });
    expect(matchTarget("/Users/u/alfa/.claude/worktrees/k22", targets)).toEqual({ projectId: "alfa" });
    expect(matchTarget("/tmp/elsewhere", targets)).toBeUndefined();
    expect(matchTarget("/data/wt", targets)).toBeUndefined();
  });

  it("ssh projects never match; github projects use their clone path", () => {
    const projects: Project[] = [
      { id: "s", name: "s", location: { kind: "ssh", hostId: "h", path: "/srv" } },
      { id: "g", name: "g", location: { kind: "github", url: "https://github.com/o/r", path: "/data/repos/g" } },
    ];
    const targets = buildTargets(projects, [], identity);
    expect(matchTarget("/srv/x", targets)).toBeUndefined();
    expect(matchTarget("/data/repos/g/x", targets)).toEqual({ projectId: "g" });
  });

  it("normalizes symlinked paths on both sides with realpath", () => {
    const real = join(root, "real", "alfa");
    mkdirSync(join(real, "src"), { recursive: true });
    mkdirSync(join(root, "wt", "k1"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    symlinkSync(join(root, "wt"), join(root, "wtlink"));
    const projects = [project("alfa", join(root, "link", "alfa"))];
    const cards = [card("k1", "alfa", join(root, "wtlink", "k1"))];
    const svc = createBgAgentsService(options({ projects, cards }));

    expect(svc.match(join(real, "src"))).toEqual({ projectId: "alfa" });
    expect(svc.match(join(root, "link", "alfa", "src"))).toEqual({ projectId: "alfa" });
    expect(svc.match(join(root, "wt", "k1"))).toEqual({ projectId: "alfa", cardId: "k1" });
    // A cwd that no longer exists still matches by its resolved parent.
    expect(svc.match(join(root, "link", "alfa", "gone", "deeper"))).toEqual({ projectId: "alfa" });
  });
});

// ---------- service ----------

interface Call {
  file: string;
  args: string[];
}

function options(
  over: Partial<Omit<BgAgentsOptions, "projects" | "cards">> & { projects?: Project[]; cards?: Card[] } = {},
): BgAgentsOptions {
  const { projects = [], cards = [], ...rest } = over;
  return {
    claudeBinary: "claude-test",
    pollMs: 1000,
    timeoutMs: 5000,
    maxOutputBytes: 1 << 20,
    logsMaxChars: 100,
    logger: silent,
    projects: { list: () => projects },
    cards: { list: () => cards },
    run: async () => ({ stdout: "[]", stderr: "", code: 0 }),
    ...rest,
  };
}

function scripted(responses: Array<RunResult | ((args: string[]) => RunResult)>) {
  const calls: Call[] = [];
  let i = 0;
  const run = vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return typeof r === "function" ? r(args) : r;
  });
  return { calls, run };
}

const okJson = (v: unknown): RunResult => ({ stdout: JSON.stringify(v), stderr: "", code: 0 });

describe("BgAgentsService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const projects = [project("alfa", "/p/alfa"), project("mac-mini", "/home", { builtin: true })];

  it("polls only while at least one client is connected", async () => {
    const { calls, run } = scripted([okJson([])]);
    const svc = createBgAgentsService(options({ run, projects }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);
    svc.setClientCount(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ file: "claude-test", args: ["agents", "--json", "--all"] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(4);
    svc.setClientCount(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(5);
    svc.setClientCount(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(5);
    svc.dispose();
  });

  it("emits a change only when the mapped list changes", async () => {
    const a = { id: "a1", cwd: "/p/alfa/x", state: "busy", name: "A" };
    const { run } = scripted([okJson([a]), okJson([{ ...a, extra: 1 }]), okJson([{ ...a, state: "blocked" }]), okJson([])]);
    const onChange = vi.fn();
    const svc = createBgAgentsService(options({ run, projects }));
    svc.onChange(onChange);
    svc.setClientCount(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await svc.list()).sessions).toEqual([{ id: "a1", name: "A", cwd: "/p/alfa/x", state: "running", projectId: "alfa" }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect((await svc.list()).sessions[0]).toMatchObject({ state: "waiting", waitingReason: "approval" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect((await svc.list()).sessions).toEqual([]);
    svc.dispose();
  });

  it("list before any poll runs one; errors keep the last good list and are reported in Turkish", async () => {
    const { run } = scripted([
      okJson([{ id: "a1", cwd: "/elsewhere", state: "done" }]),
      { stdout: "", stderr: "", code: null, error: "ENOENT" },
      { stdout: "", stderr: "", code: null, error: "TIMEOUT" },
      { stdout: "", stderr: "boom\nreal failure", code: 1 },
      { stdout: "garbage", stderr: "", code: 0 },
    ]);
    const onChange = vi.fn();
    const svc = createBgAgentsService(options({ run, projects }));
    svc.onChange(onChange);
    const first = await svc.list();
    expect(first).toEqual({ sessions: [{ id: "a1", name: "a1", cwd: "/elsewhere", state: "done" }] });
    svc.setClientCount(1);
    await vi.advanceTimersByTimeAsync(0);
    const missing = await svc.list();
    expect(missing.sessions).toHaveLength(1);
    expect(missing.error).toMatch(/claude.*bulunamadı.*claude-test/);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await svc.list()).error).toMatch(/5 saniyede yanıt vermedi/);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await svc.list()).error).toMatch(/hata verdi: real failure/);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await svc.list()).error).toMatch(/beklenmeyen/);
    expect(onChange).toHaveBeenCalledTimes(5);
    svc.dispose();
  });

  it("concurrent polls share one run", async () => {
    let resolve!: (r: RunResult) => void;
    const run = vi.fn(() => new Promise<RunResult>((r) => (resolve = r)));
    const svc = createBgAgentsService(options({ run, projects }));
    const p1 = svc.list();
    const p2 = svc.list();
    svc.setClientCount(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    resolve(okJson([]));
    expect(await p1).toEqual({ sessions: [] });
    expect(await p2).toEqual({ sessions: [] });
    svc.dispose();
  });

  it("performans: an unchanged list slows the polling down to idlePollMaxMs; a change or a new client speeds it up", async () => {
    // Each `claude agents --json --all` costs ~0.25 CPU-seconds and ~160 MB for a moment, once per account.
    const a = { id: "a1", cwd: "/p/alfa/x", state: "busy", name: "A" };
    let out: unknown[] = [a];
    const run = vi.fn(async () => okJson(out));
    const svc = createBgAgentsService(options({ run, projects, pollMs: 1000, idlePollMaxMs: 4000 }));
    svc.setClientCount(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    // Unchanged: the next waits 1 s, then 2 s, then 4 s (the cap), and stays there.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(run).toHaveBeenCalledTimes(5); // t = 0, 1, 3, 7, 11 s (12 without the slow-down)
    await vi.advanceTimersByTimeAsync(8000);
    expect(run).toHaveBeenCalledTimes(7); // 15, 19
    // A change is noticed at the next poll; from then on polling is fast again.
    out = [{ ...a, state: "blocked" }];
    await vi.advanceTimersByTimeAsync(4000);
    expect(run).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(9);
    // Slow again; a client that connects gets a fresh list at once and fast polling.
    await vi.advanceTimersByTimeAsync(20_000);
    const before = run.mock.calls.length;
    svc.setClientCount(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(before + 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(before + 2);
    svc.dispose();
  });

  it("pollMs 0 disables the CLI entirely", async () => {
    const { run } = scripted([okJson([])]);
    const svc = createBgAgentsService(options({ run, pollMs: 0 }));
    svc.setClientCount(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await svc.list()).toEqual({ sessions: [] });
    expect(run).not.toHaveBeenCalled();
    svc.dispose();
  });

  it("attachTarget: the session's project/card, the built-in project when unmatched, NOT_FOUND when unknown", async () => {
    const cards = [card("k1", "alfa", "/wt/k1")];
    const { calls, run } = scripted([
      okJson([
        { id: "a1", cwd: "/p/alfa", state: "busy" },
        { id: "a2", cwd: "/wt/k1/src", state: "busy" },
        { id: "a3", cwd: "/nowhere", state: "busy" },
      ]),
    ]);
    const svc = createBgAgentsService(options({ run, projects, cards, builtinProjectId: "mac-mini" }));
    expect(await svc.attachTarget("a1")).toEqual({ projectId: "alfa", command: "'claude-test' attach a1" });
    expect(await svc.attachTarget("a2")).toEqual({ projectId: "alfa", cardId: "k1", command: "'claude-test' attach a2" });
    expect(await svc.attachTarget("a3")).toEqual({ projectId: "mac-mini", command: "'claude-test' attach a3" });
    await expect(svc.attachTarget("zz")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // unknown id → one refresh, then NOT_FOUND
    expect(calls.length).toBe(2);
    await expect(svc.attachTarget("-rf")).rejects.toMatchObject({ code: "INVALID" });
    svc.dispose();
  });

  it("logs: argv, escape sequences stripped, tail kept within the limit", async () => {
    const long = "\x1b[1mbaşlık\x1b[0m\r\n" + Array.from({ length: 40 }, (_, i) => `satır ${i}`).join("\r\n");
    const { calls, run } = scripted([{ stdout: long, stderr: "", code: 0 }, { stdout: "kısa\n", stderr: "", code: 0 }]);
    const svc = createBgAgentsService(options({ run, logsMaxChars: 50 }));
    const r = await svc.logs("a1");
    expect(calls[0]).toEqual({ file: "claude-test", args: ["logs", "a1"] });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(50);
    expect(r.text).toMatch(/satır 39$/);
    expect(r.text).not.toMatch(/\x1b/);
    expect(r.text).toContain("satır 38\nsatır 39");
    expect(await svc.logs("a1")).toEqual({ text: "kısa\n", truncated: false });
    await expect(svc.logs("a b")).rejects.toMatchObject({ code: "INVALID" });
    svc.dispose();
  });

  it("stop: argv, then a refresh; failures are Turkish CLAUDE_FAILED", async () => {
    const { calls, run } = scripted([
      { stdout: "", stderr: "", code: 0 },
      okJson([]),
      { stdout: "", stderr: "No session abc", code: 1 },
    ]);
    const svc = createBgAgentsService(options({ run }));
    await svc.stop("a1");
    expect(calls.map((c) => c.args)).toEqual([["stop", "a1"], ["agents", "--json", "--all"]]);
    await expect(svc.stop("abc")).rejects.toMatchObject({ code: "CLAUDE_FAILED", message: expect.stringMatching(/No session abc/) });
    svc.dispose();
  });

  it("logs/stop surface a missing claude and timeouts in Turkish", async () => {
    const { run } = scripted([
      { stdout: "", stderr: "", code: null, error: "ENOENT" },
      { stdout: "", stderr: "", code: null, error: "TIMEOUT" },
      { stdout: "", stderr: "", code: null, error: "TOO_BIG" },
    ]);
    const svc = createBgAgentsService(options({ run }));
    await expect(svc.logs("a")).rejects.toThrow(/bulunamadı/);
    await expect(svc.stop("a")).rejects.toThrow(/yanıt vermedi/);
    await expect(svc.logs("a")).rejects.toThrow(/çok büyük/);
    svc.dispose();
  });
});
