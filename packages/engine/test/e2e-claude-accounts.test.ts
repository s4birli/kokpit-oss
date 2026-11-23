// End-to-end for İş H (Adım 8, Claude hesapları) against the real engine: temp HOME, a fake `claude` on PATH that
// prints $CLAUDE_CONFIG_DIR and lists background sessions per config dir. The real `claude` and the user's
// ~/.claude are never touched.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BgAgentSession, ClaudeAccount, Project, TerminalInfo } from "@kokpit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeClaude, type FakeClaude } from "./fakes/fake-claude-agents-setup.ts";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const POLL_MS = 150;
const DIMS = { cols: 100, rows: 30 };
const WAIT_MS = 10_000;

let root: string;
let home: string;
let engine: EngineProc | undefined;
let engineEnv: NodeJS.ProcessEnv;
let c: Client;
let fake: FakeClaude;
let work: ClaudeAccount;
let workProject: Project;
let plainProject: Project;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rejects(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected the request to fail");
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

/** Opens a plain shell in the project, runs the fake's `config-dir`, returns what it printed. */
async function configDirSeenBy(projectId: string): Promise<string> {
  const { terminal } = await c.req<{ terminal: TerminalInfo }>("terminal.open", { projectId, ...DIMS, command: "claude config-dir" });
  const out = await c.waitForOutput(terminal.id, /CONFIG_DIR=\[[^\]\r\n]*\]/);
  await c.req("terminal.close", { terminalId: terminal.id });
  return /CONFIG_DIR=\[([^\]\r\n]*)\]/.exec(out)![1]!;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-accounts-")));
  home = join(root, "home");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(root, "work-proje"));
  mkdirSync(join(root, "duz-proje"));
  fake = installFakeClaude(root, []);
  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir: join(root, "data"), port: 0, shell: "/bin/sh", shellArgs: [], listenTailscale: false, killGraceMs: 200 }),
  );
  engineEnv = {
    KOKPIT_CONFIG: configPath,
    KOKPIT_KEY: KEY,
    KOKPIT_BG_AGENTS_POLL_MS: String(POLL_MS),
    HOME: home,
    PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
    // An engine started from another account's terminal must not leak it into terminals.
    CLAUDE_CONFIG_DIR: join(root, "engine-inherited"),
    ...fake.env,
  };
  engine = await startEngine(engineEnv);
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
}, 30_000);

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("Claude accounts through the engine", () => {
  it("seeds the default account at <HOME>/.claude", async () => {
    const { accounts } = await c.req<{ accounts: ClaudeAccount[] }>("claudeAccounts.list", {});
    expect(accounts).toEqual([{ id: "benim", name: "Benim", configDir: join(home, ".claude"), isDefault: true }]);
  });

  it("creates Work's account (folder 0700) and refuses folders outside HOME", async () => {
    ({ account: work } = await c.req<{ account: ClaudeAccount }>("claudeAccounts.create", { name: "Work", configDir: "~/.claude-work" }));
    expect(work.configDir).toBe(join(home, ".claude-work"));
    expect(statSync(work.configDir).mode & 0o777).toBe(0o700);
    expect((await rejects(c.req("claudeAccounts.create", { name: "X", configDir: "/etc" }))).code).toBe("INVALID");
    expect((await rejects(c.req("claudeAccounts.delete", { id: "benim" }))).code).toBe("INVALID");
  });

  it("projects pick an account; unknown ids are refused", async () => {
    ({ project: workProject } = await c.req<{ project: Project }>("projects.create", {
      name: "Work işi",
      location: { kind: "local", path: join(root, "work-proje") },
    }));
    ({ project: workProject } = await c.req<{ project: Project }>("projects.update", { projectId: workProject.id, claudeAccountId: work.id }));
    expect(workProject.claudeAccountId).toBe(work.id);
    ({ project: plainProject } = await c.req<{ project: Project }>("projects.create", {
      name: "Düz",
      location: { kind: "local", path: join(root, "duz-proje") },
    }));
    expect((await rejects(c.req("projects.update", { projectId: plainProject.id, claudeAccountId: "yok" }))).code).toBe("NOT_FOUND");
    expect((await rejects(c.req("claudeAccounts.delete", { id: work.id }))).code).toBe("INVALID");
  });

  it("the Work project's terminal gets CLAUDE_CONFIG_DIR; other projects get none", async () => {
    expect(await configDirSeenBy(workProject.id)).toBe(work.configDir);
    expect(await configDirSeenBy(plainProject.id)).toBe("");
    expect(await configDirSeenBy("mac-mini")).toBe("");
  });

  it("login opens `claude /login` in the built-in project with the account's dir", async () => {
    const { terminal } = await c.req<{ terminal: TerminalInfo }>("claudeAccounts.login", { id: work.id, ...DIMS });
    expect(terminal.projectId).toBe("mac-mini");
    await c.waitForOutput(terminal.id, new RegExp(`FAKE-LOGIN CONFIG_DIR=\\[${work.configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
    await c.req("terminal.close", { terminalId: terminal.id });
    const def = await c.req<{ terminal: TerminalInfo }>("claudeAccounts.login", { id: "benim", ...DIMS });
    await c.waitForOutput(def.terminal.id, /FAKE-LOGIN CONFIG_DIR=\[\]/);
    await c.req("terminal.close", { terminalId: def.terminal.id });
  });

  it("background agents come from both accounts, tagged; attach/logs/stop use the session's account", async () => {
    fake.setSessions([{ id: "aaaa1111", cwd: join(root, "duz-proje"), name: "Benim ajan", state: "working", status: "busy", kind: "background" }]);
    fake.setSessionsFor(work.configDir, [
      { id: "bbbb2222", cwd: join(root, "work-proje"), name: "Work ajan", state: "blocked", kind: "background" },
    ]);
    const r = await until(
      () => c.req<{ sessions: BgAgentSession[]; error?: string }>("bgAgents.list", {}),
      (v) => v.sessions.length === 2,
    );
    expect(r.error).toBeUndefined();
    const byId = Object.fromEntries(r.sessions.map((s) => [s.id, s]));
    expect(byId["aaaa1111"]).toMatchObject({ accountId: "benim", projectId: plainProject.id });
    expect(byId["bbbb2222"]).toMatchObject({ accountId: work.id, projectId: workProject.id, state: "waiting" });

    const logs = await c.req<{ text: string }>("bgAgents.logs", { id: "bbbb2222" });
    expect(logs.text).toContain("FAKE-LOG bbbb2222"); // found only in Work's dir
    const { terminal } = await c.req<{ terminal: TerminalInfo }>("bgAgents.attach", { id: "bbbb2222", ...DIMS });
    await c.waitForOutput(terminal.id, /FAKE-ATTACH bbbb2222/);
    await c.req("terminal.close", { terminalId: terminal.id });
    await c.req("bgAgents.stop", { id: "bbbb2222" });
    await until(
      () => c.req<{ sessions: BgAgentSession[] }>("bgAgents.list", {}),
      (v) => v.sessions.find((s) => s.id === "bbbb2222")?.state === "done",
    );
  });

  it("shareSkills links only what is missing and never overwrites", async () => {
    mkdirSync(join(work.configDir, "agents"));
    const r = await c.req<{ linked: string[]; skipped: { name: string }[] }>("claudeAccounts.shareSkills", { id: work.id, confirm: true });
    expect(r.linked).toEqual(["skills"]);
    expect(r.skipped.map((s) => s.name).sort()).toEqual(["agents", "commands"]);
    expect(lstatSync(join(work.configDir, "skills")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(work.configDir, "skills"))).toBe(join(home, ".claude", "skills"));
    expect(lstatSync(join(work.configDir, "agents")).isSymbolicLink()).toBe(false);
    expect((await rejects(c.req("claudeAccounts.shareSkills", { id: work.id }))).code).toBe("INVALID");
  });

  it("the Claude panel's inventory reads each project's own account (and shared skills)", async () => {
    type Inv = { items: { kind: string; name: string; source: string }[] };
    const names = (inv: Inv, kind: string) => inv.items.filter((i) => i.kind === kind && i.source === "user").map((i) => i.name);
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    writeFileSync(join(home, ".claude", "agents", "benim-ajan.md"), "---\nname: benim-ajan\ndescription: benim\n---\n");
    writeFileSync(join(work.configDir, "agents", "work-ajan.md"), "---\nname: work-ajan\ndescription: work\n---\n");
    mkdirSync(join(home, ".claude", "skills", "ortak"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "ortak", "SKILL.md"), "---\nname: ortak\ndescription: paylaşılan\n---\n");

    const workInv = await c.req<Inv>("claude.inventory", { projectId: workProject.id });
    expect(names(workInv, "agent")).toEqual(["work-ajan"]);
    // Work's skills dir is a symlink into the default account (shareSkills above): allowed as a shared root.
    expect(names(workInv, "skill")).toContain("ortak");

    const plainInv = await c.req<Inv>("claude.inventory", { projectId: plainProject.id });
    expect(names(plainInv, "agent")).toEqual(["benim-ajan"]);
  });

  it("accounts persist across an engine restart", async () => {
    await c.close();
    await stopEngine(engine);
    engine = await startEngine(engineEnv);
    c = await Client.connect(engine.port, KEY);
    const { accounts } = await c.req<{ accounts: ClaudeAccount[] }>("claudeAccounts.list", {});
    expect(accounts.map((a) => a.id)).toEqual(["benim", work.id]);
    expect(await configDirSeenBy(workProject.id)).toBe(work.configDir);
  });
});
