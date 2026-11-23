// End-to-end for İş A (Adım 7, arka plan ajanları) against the real engine: a fake `claude` on PATH emits
// scripted `claude agents --json --all` output and records attach/logs/stop. The real `claude` never runs.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BgAgentSession, Card, Project, ServerMessage, TerminalInfo } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeClaude, type FakeClaude, type FakeClaudeSession } from "./fakes/fake-claude-agents-setup.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const POLL_MS = 150;
const DIMS = { cols: 100, rows: 30 };
const WAIT_MS = 10_000;

let root: string;
let projectDir: string;
let engine: EngineProc | undefined;
let c: Client;
let fake: FakeClaude;
let project: Project;
let card: Card;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agentCalls = () => fake.calls().filter((a) => a[0] === "agents");
const changedEvents = (cl: Client) =>
  cl.frames.filter((f: ServerMessage) => f.type === "event" && f.name === "bgAgents.changed").length;

async function list(): Promise<{ sessions: BgAgentSession[]; error?: string }> {
  return c.req("bgAgents.list", {});
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > WAIT_MS) throw new Error(`timeout; last: ${JSON.stringify(v)}`);
    await sleep(50);
  }
}

async function rejects(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected the request to fail");
}

function sessions(): FakeClaudeSession[] {
  return [
    // Started through a symlink to the project folder: realpath maps it.
    { id: "a1b2c3d4", cwd: join(root, "proje-link", "src"), name: "Testleri düzelt", state: "blocked", kind: "background", startedAt: 1792600000000, pid: 1 },
    { id: "e5f6a7b8", cwd: card.worktreePath, name: "Kart işi", state: "working", status: "busy", kind: "background", startedAt: 1792600600000 },
    { id: "c9d0e1f2", cwd: "/", name: "Başka yerde", state: "done", kind: "background", startedAt: 1792601200000 },
    { id: "abcdef01", cwd: projectDir, name: "Etkileşimli", state: "working", kind: "interactive" },
  ];
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-bgagents-")));
  const home = join(root, "home");
  projectDir = join(root, "proje");
  mkdirSync(home);
  mkdirSync(join(projectDir, "src"), { recursive: true });
  symlinkSync(projectDir, join(root, "proje-link"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...a], { cwd: projectDir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(projectDir, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  fake = installFakeClaude(root, []);
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false, killGraceMs: 200 }),
  );
  engine = await startEngine({
    KOKPIT_CONFIG: configPath,
    KOKPIT_KEY: KEY,
    KOKPIT_BG_AGENTS_POLL_MS: String(POLL_MS),
    HOME: home,
    PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
    ...fake.env,
  });
}, 30_000);

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("background agents through the engine", () => {
  it("does not run claude while no client is connected", async () => {
    await sleep(POLL_MS * 4);
    expect(agentCalls()).toHaveLength(0);
  });

  it("lists sessions mapped to their project / card once a client connects", async () => {
    c = await Client.connect(engine!.port, KEY);
    await c.req("settings.update", { defaultToolId: null });
    ({ project } = await c.req<{ project: Project }>("projects.create", { name: "Proje", location: { kind: "local", path: projectDir } }));
    ({ card } = await c.req<{ card: Card }>("cards.create", { projectId: project.id, name: "Kart" }));
    fake.setSessions(sessions());
    const r = await until(list, (v) => v.sessions.length === 3);
    expect(r.error).toBeUndefined();
    const byId = Object.fromEntries(r.sessions.map((s) => [s.id, s]));
    expect(byId["a1b2c3d4"]).toEqual({
      id: "a1b2c3d4",
      name: "Testleri düzelt",
      state: "waiting",
      waitingReason: "approval",
      startedAt: new Date(1792600000000).toISOString(),
      cwd: join(root, "proje-link", "src"),
      projectId: project.id,
      accountId: "benim", // İş H: tagged with the (default) Claude account
    });
    expect(byId["e5f6a7b8"]).toMatchObject({ state: "running", projectId: project.id, cardId: card.id });
    expect(byId["c9d0e1f2"]).toMatchObject({ state: "done" });
    // "/" is outside every project folder (the built-in project is the temp HOME).
    expect(byId["c9d0e1f2"]!.projectId).toBeUndefined();
    expect(agentCalls()[0]).toEqual(["agents", "--json", "--all"]);
  });

  it("sends bgAgents.changed only when the list changes", async () => {
    const before = changedEvents(c);
    await sleep(POLL_MS * 5);
    expect(changedEvents(c)).toBe(before);
    fake.setSessions(sessions().map((s) => (s.id === "c9d0e1f2" ? { ...s, state: "idle" } : s)));
    await c.waitFor(() => changedEvents(c) > before, WAIT_MS);
    const r = await list();
    expect(r.sessions.find((s) => s.id === "c9d0e1f2")).toMatchObject({ state: "waiting", waitingReason: "input" });
  });

  it("attach opens a normal terminal in the session's card running `claude attach <id>`", async () => {
    const { terminal } = await c.req<{ terminal: TerminalInfo }>("bgAgents.attach", { id: "e5f6a7b8", ...DIMS });
    expect(terminal).toMatchObject({ projectId: project.id, cardId: card.id, status: "running" });
    await c.waitForOutput(terminal.id, /FAKE-ATTACH e5f6a7b8/);
    const { terminals } = await c.req<{ terminals: TerminalInfo[] }>("terminals.list", { cardId: card.id });
    expect(terminals.map((t) => t.id)).toContain(terminal.id);
    expect(fake.calls()).toContainEqual(["attach", "e5f6a7b8"]);
    await c.req("terminal.close", { terminalId: terminal.id });
  });

  it("attach of an unmatched session opens in the built-in project", async () => {
    const { projects } = await c.req<{ projects: Project[] }>("projects.list", {});
    const builtin = projects.find((p) => p.builtin)!;
    const { terminal } = await c.req<{ terminal: TerminalInfo }>("bgAgents.attach", { id: "c9d0e1f2", ...DIMS });
    expect(terminal.projectId).toBe(builtin.id);
    await c.waitForOutput(terminal.id, /FAKE-ATTACH c9d0e1f2/);
    await c.req("terminal.close", { terminalId: terminal.id });
  });

  it("logs returns the stripped text", async () => {
    const r = await c.req<{ text: string; truncated: boolean }>("bgAgents.logs", { id: "a1b2c3d4" });
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("Testleri düzelt\n> çalışıyor…\nFAKE-LOG a1b2c3d4");
    expect(r.text).not.toContain("\x1b");
  });

  it("stop runs `claude stop <id>` and the list follows", async () => {
    await c.req("bgAgents.stop", { id: "a1b2c3d4" });
    expect(fake.calls()).toContainEqual(["stop", "a1b2c3d4"]);
    const r = await until(list, (v) => v.sessions.find((s) => s.id === "a1b2c3d4")?.state === "done");
    expect(r.sessions.find((s) => s.id === "a1b2c3d4")!.waitingReason).toBeUndefined();
  });

  it("rejects bad ids before running anything, and reports CLI failures in Turkish", async () => {
    const n = fake.calls().length;
    for (const id of ["-rf", "a b", "x;touch PWNED", "$(id)"]) {
      expect((await rejects(c.req("bgAgents.stop", { id }))).code).toBe("INVALID");
      expect((await rejects(c.req("bgAgents.attach", { id, ...DIMS }))).code).toBe("INVALID");
    }
    expect(fake.calls().slice(n).filter((a) => a[0] !== "agents")).toEqual([]);
    const unknown = await rejects(c.req("bgAgents.logs", { id: "deadbeef" }));
    expect(unknown).toMatchObject({ code: "CLAUDE_FAILED", message: expect.stringMatching(/claude hata verdi: No background session/) });
    expect((await rejects(c.req("bgAgents.attach", { id: "deadbeef", ...DIMS }))).code).toBe("NOT_FOUND");
  });

  it("garbage output keeps the last list and reports an error", async () => {
    const good = (await list()).sessions;
    writeFileSync(fake.env.FAKE_CLAUDE_STATE!, JSON.stringify({ sessions: "garbage" }));
    const r = await until(list, (v) => v.error !== undefined);
    expect(r.error).toMatch(/beklenmeyen/);
    expect(r.sessions).toEqual(good);
    fake.setSessions(sessions());
    await until(list, (v) => v.error === undefined);
  });

  it("stops polling when the last client disconnects", async () => {
    await c.close();
    await sleep(POLL_MS * 2);
    const n = agentCalls().length;
    await sleep(POLL_MS * 5);
    expect(agentCalls().length).toBe(n);
    c = await Client.connect(engine!.port, KEY);
    await until(async () => agentCalls().length, (m) => m > n);
  });
});
