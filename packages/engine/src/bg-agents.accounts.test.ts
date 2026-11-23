// İş H (Adım 8): background agents read once per Claude account config dir, merged and tagged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@kokpit/shared";
import { createBgAgentsService, type BgAgentsOptions } from "./bg-agents.ts";
import type { AccountDir } from "./claude-accounts.ts";
import type { Logger } from "./contracts.ts";
import type { RunResult } from "./exec-runner.ts";

const silent: Logger = { info() {}, warn() {}, error() {} };
const project = (id: string, path: string): Project => ({ id, name: id, location: { kind: "local", path } });
const ok = (v: unknown): RunResult => ({ stdout: JSON.stringify(v), stderr: "", code: 0 });

const ACCOUNTS: AccountDir[] = [
  { accountId: "benim", name: "Benim", configDir: "/h/.claude", isDefault: true },
  { accountId: "work", name: "Work", configDir: "/h/.claude-work", isDefault: false },
];

type Call = { args: string[]; dir: string | undefined };

function setup(byDir: Record<string, RunResult>, accounts: AccountDir[] = ACCOUNTS) {
  const calls: Call[] = [];
  const run = vi.fn(async (_file: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    const dir = opts.env?.CLAUDE_CONFIG_DIR;
    calls.push({ args, dir });
    if (args[0] !== "agents") return ok([]);
    return byDir[dir ?? "default"] ?? ok([]);
  });
  const options: BgAgentsOptions = {
    claudeBinary: "claude-test",
    pollMs: 1000,
    timeoutMs: 5000,
    maxOutputBytes: 1 << 20,
    logsMaxChars: 100,
    logger: silent,
    projects: { list: () => [project("alfa", "/p/alfa"), project("beta", "/p/beta")] },
    cards: { list: () => [] },
    builtinProjectId: "mac-mini",
    run: run as never,
    realpath: (p) => p,
    accounts: () => accounts,
  };
  return { calls, svc: createBgAgentsService(options) };
}

describe("BgAgentsService with Claude accounts (İş H)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/engine/inherited";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("polls once per account dir (default without the variable) and tags each session", async () => {
    const { calls, svc } = setup({
      default: ok([{ id: "a1", cwd: "/p/alfa", state: "busy", name: "Mine" }]),
      "/h/.claude-work": ok([{ id: "k1", cwd: "/p/beta", state: "blocked", name: "Work's" }]),
    });
    const r = await svc.list();
    expect(calls.map((c) => c.dir)).toEqual([undefined, "/h/.claude-work"]);
    expect(r.error).toBeUndefined();
    expect(r.sessions.map((s) => [s.id, s.accountId, s.projectId])).toEqual([
      ["a1", "benim", "alfa"],
      ["k1", "work", "beta"],
    ]);
  });

  it("one failing account keeps the others' sessions and names the account in the error", async () => {
    const { svc } = setup({
      default: ok([{ id: "a1", cwd: "/p/alfa", state: "busy" }]),
      "/h/.claude-work": { stdout: "", stderr: "not logged in", code: 1 },
    });
    const r = await svc.list();
    expect(r.sessions.map((s) => s.id)).toEqual(["a1"]);
    expect(r.error).toMatch(/^Work: .*not logged in/);
  });

  it("the same id from two dirs is listed once (first account wins)", async () => {
    const same = { id: "x1", cwd: "/p/alfa", state: "busy" };
    const { svc } = setup({ default: ok([same]), "/h/.claude-work": ok([same]) });
    const r = await svc.list();
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.accountId).toBe("benim");
  });

  it("logs / stop run with the session's account dir; attach returns the account", async () => {
    const { calls, svc } = setup({
      default: ok([]),
      "/h/.claude-work": ok([{ id: "k1", cwd: "/p/beta", state: "busy" }]),
    });
    await svc.list();
    calls.length = 0;
    await svc.logs("k1");
    await svc.stop("k1");
    expect(calls.filter((c) => c.args[0] !== "agents")).toEqual([
      { args: ["logs", "k1"], dir: "/h/.claude-work" },
      { args: ["stop", "k1"], dir: "/h/.claude-work" },
    ]);
    expect(await svc.attachTarget("k1")).toMatchObject({ projectId: "beta", accountId: "work" });
  });

  it("logs of an unknown session use the default account (no variable)", async () => {
    const { calls, svc } = setup({});
    await svc.logs("zz9");
    expect(calls.at(-1)).toEqual({ args: ["logs", "zz9"], dir: undefined });
  });

  it("without accounts the single call never forwards the engine's inherited variable", async () => {
    const { calls, svc } = setup({}, []);
    await svc.list();
    expect(calls).toEqual([{ args: ["agents", "--json", "--all"], dir: undefined }]);
  });
});
