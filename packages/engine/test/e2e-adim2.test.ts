// End-to-end for SPEC-adim-2 "Bitti sayılır" 1, 2, 4, 5, 6, 7 against the real engine.
// SSH is exercised with a fake ssh binary (config tunable `sshBinary`) that records its argv and
// runs the remote command locally, so argv building and remote-path quoting are tested for real.
// GitHub cloning (item 3) needs the network; it is covered by unit tests and the verifier.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, escapeRe, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const KEY_MARKER = "SECRET-PRIVATE-KEY-MARKER-7f3a";
const DIMS = { cols: 100, rows: 30 };

let root: string;
let home: string;
let dataDir: string;
let localDir: string;
let remoteDir: string;
let argsFile: string;
let configPath: string;
let engine: EngineProc | undefined;

type Proj = { id: string; name: string; location: { kind: string; path?: string; hostId?: string }; defaultToolId?: string };
type Term = { id: string; projectId: string; cardId?: string; toolId?: string };

const env = () => ({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: home });
const connect = () => Client.connect(engine!.port, KEY);

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e2-")));
  home = join(root, "home");
  dataDir = join(root, "data");
  localDir = join(root, "yerel proje");
  remoteDir = join(root, "uzak 'klasör' $(x)");
  argsFile = join(root, "ssh-args.txt");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(localDir);
  mkdirSync(remoteDir);
  writeFileSync(join(home, ".ssh", "id_test"), `-----BEGIN KEY-----\n${KEY_MARKER}\n-----END KEY-----\n`, { mode: 0o600 });
  writeFileSync(join(home, ".ssh", "id_test.pub"), "ssh-ed25519 AAAA test\n");
  writeFileSync(join(home, ".ssh", "config"), "Host testbox\n  HostName 10.9.8.7\n  User tester\n");

  // Fake ssh: record argv, then run the remote command (last argument) locally.
  const fakeSsh = join(root, "fake-ssh");
  writeFileSync(
    fakeSsh,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nfor last; do :; done\nSHELL=/bin/sh exec /bin/sh -c "$last"\n`,
  );
  chmodSync(fakeSsh, 0o755);

  configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      sshBinary: fakeSsh,
    }),
  );
  engine = await startEngine(env());
  // These scenarios type into plain shells; the seeded global default tool (claude) would take the input.
  const c = await connect();
  await c.req("settings.update", { defaultToolId: null });
  await c.close();
}, 30000);

afterAll(async () => {
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("Adım 2 end-to-end", () => {
  let local: Proj;
  let sshProj: Proj;
  let aliasProj: Proj;
  let hostId: string;
  let toolId: string;

  it("has the built-in Mac mini project in the home dir", async () => {
    const c = await connect();
    const { projects } = await c.req<{ projects: Proj[] }>("projects.list", {});
    const builtin = projects.find((p) => p.id === "mac-mini");
    expect(builtin?.location).toEqual({ kind: "local", path: home });
    await c.close();
  });

  it("adds a local project and opens a terminal in its folder without a card (Bitti 1)", async () => {
    const c = await connect();
    ({ project: local } = await c.req<{ project: Proj }>("projects.create", {
      name: "Yerel Proje",
      location: { kind: "local", path: localDir },
    }));
    const { projects } = await c.req<{ projects: Proj[] }>("projects.list", {});
    expect(projects.map((p) => p.id)).toContain(local.id);
    const { terminal } = await c.req<{ terminal: Term }>("terminal.open", { projectId: local.id, ...DIMS, command: "pwd" });
    expect(terminal.cardId).toBeUndefined();
    await c.waitForOutput(terminal.id, new RegExp(escapeRe(localDir)));
    const { terminals } = await c.req<{ terminals: Term[] }>("terminals.list", { projectId: local.id });
    expect(terminals.map((t) => t.id)).toContain(terminal.id);
    await c.close();
  });

  it("rejects a local project whose folder does not exist", async () => {
    const c = await connect();
    await expect(
      c.req("projects.create", { name: "Yok", location: { kind: "local", path: join(root, "olmayan") } }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await c.close();
  });

  it("adds an ssh host with a key from ~/.ssh and opens a terminal in the remote folder (Bitti 2)", async () => {
    const c = await connect();
    const { keys } = await c.req<{ keys: string[] }>("sshKeys.list", {});
    expect(keys).toContain("id_test");
    const { host } = await c.req<{ host: { id: string } }>("sshHosts.create", {
      name: "Test Sunucu",
      hostname: "203.0.113.5",
      user: "deploy",
      port: 2222,
      identityFile: "id_test",
    });
    hostId = host.id;
    ({ project: sshProj } = await c.req<{ project: Proj }>("projects.create", {
      name: "Uzak",
      location: { kind: "ssh", hostId, path: remoteDir },
    }));
    const { terminal } = await c.req<{ terminal: Term }>("terminal.open", { projectId: sshProj.id, ...DIMS });
    c.input(terminal.id, "pwd\r");
    await c.waitForOutput(terminal.id, new RegExp(escapeRe(remoteDir)));
    const args = readFileSync(argsFile, "utf8").split("\n");
    expect(args).toEqual(expect.arrayContaining(["-t", "-p", "2222", "-i", join(home, ".ssh", "id_test"), "--", "deploy@203.0.113.5"]));
    await expect(c.req("cards.create", { projectId: sshProj.id, name: "olmaz" })).rejects.toMatchObject({ code: "INVALID" });
    await c.close();
  });

  it("lists ~/.ssh/config aliases read-only and connects through them (Bitti 2)", async () => {
    const c = await connect();
    const { hosts } = await c.req<{ hosts: { id: string; source: string }[] }>("sshHosts.list", {});
    expect(hosts).toEqual(expect.arrayContaining([expect.objectContaining({ id: "testbox", source: "ssh-config" })]));
    await expect(c.req("sshHosts.delete", { hostId: "testbox" })).rejects.toMatchObject({ code: "INVALID" });
    ({ project: aliasProj } = await c.req<{ project: Proj }>("projects.create", {
      name: "Alias",
      location: { kind: "ssh", hostId: "testbox" },
    }));
    const { terminal } = await c.req<{ terminal: Term }>("terminal.open", { projectId: aliasProj.id, ...DIMS, command: "echo ALIAS_OK" });
    await c.waitForOutput(terminal.id, /ALIAS_OK/);
    const args = readFileSync(argsFile, "utf8").split("\n");
    expect(args).toContain("testbox");
    expect(args).not.toContain("-i");
    await c.close();
  });

  it("starts the project's default tool in a new terminal (Bitti 4)", async () => {
    const c = await connect();
    ({ tool: { id: toolId } } = await c.req<{ tool: { id: string } }>("tools.create", {
      name: "İşaret Aracı",
      command: "echo TOOL_STARTED_$((6*7))",
      installCommand: "echo INSTALL_RAN_$((2*3))",
      checkCommand: "false",
    }));
    await c.req("projects.update", { projectId: local.id, defaultToolId: toolId });
    const { terminal } = await c.req<{ terminal: Term }>("terminal.open", { projectId: local.id, ...DIMS });
    expect(terminal.toolId).toBe(toolId);
    await c.waitForOutput(terminal.id, /TOOL_STARTED_42/);
    await c.close();
  });

  it("reports a missing tool and installs it in the Mac mini terminal (Bitti 5)", async () => {
    const c = await connect();
    const { statuses } = await c.req<{ statuses: { toolId: string; installed: boolean | null }[] }>("tools.check", {});
    expect(statuses.find((s) => s.toolId === toolId)?.installed).toBe(false);
    const { terminal } = await c.req<{ terminal: Term }>("tools.install", { toolId, ...DIMS });
    expect(terminal.projectId).toBe("mac-mini");
    await c.waitForOutput(terminal.id, /INSTALL_RAN_6/);
    await c.close();
  });

  it("keeps projects, hosts and tools across an engine restart (Bitti 6)", async () => {
    await stopEngine(engine);
    engine = await startEngine(env());
    const c = await connect();
    const { projects } = await c.req<{ projects: Proj[] }>("projects.list", {});
    expect(projects.map((p) => p.id)).toEqual(expect.arrayContaining(["mac-mini", local.id, sshProj.id, aliasProj.id]));
    expect(projects.find((p) => p.id === local.id)?.defaultToolId).toBe(toolId);
    const { hosts } = await c.req<{ hosts: { id: string }[] }>("sshHosts.list", {});
    expect(hosts.map((h) => h.id)).toContain(hostId);
    const { tools } = await c.req<{ tools: { id: string }[] }>("tools.list", {});
    expect(tools.map((t) => t.id)).toEqual(expect.arrayContaining([toolId, "claude", "codex"]));
    await c.close();
  }, 30000);

  it("never leaks private key contents into frames, logs or the state file (Bitti 7)", async () => {
    const c = await connect();
    await c.req("sshHosts.list", {});
    await c.req("sshKeys.list", {});
    await c.req("projects.list", {});
    expect(c.raw.join("\n")).not.toContain(KEY_MARKER);
    expect(engine!.logs()).not.toContain(KEY_MARKER);
    expect(readFileSync(join(dataDir, "state.json"), "utf8")).not.toContain(KEY_MARKER);
    // grep exits 1 when nothing matches: that is the passing case.
    const grep = spawnSync("grep", ["-rl", KEY_MARKER, dataDir], { encoding: "utf8" });
    expect(grep.status).toBe(1);
    expect(grep.stdout).toBe("");
    await c.close();
  });

  it("refuses to delete a project that still has cards and deletes an empty one without touching files", async () => {
    const repo = join(root, "kartli repo");
    mkdirSync(repo);
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "kart\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "init");

    const c = await connect();
    const { project } = await c.req<{ project: Proj }>("projects.create", { name: "Kartlı", location: { kind: "local", path: repo } });
    const { card } = await c.req<{ card: { id: string; worktreePath: string } }>("cards.create", { projectId: project.id, name: "iş" });
    await expect(c.req("projects.delete", { projectId: project.id })).rejects.toMatchObject({ code: "INVALID" });
    expect((await c.req<{ projects: Proj[] }>("projects.list", {})).projects.map((p) => p.id)).toContain(project.id);
    await c.req("cards.delete", { cardId: card.id });
    await c.req("projects.delete", { projectId: project.id });
    expect((await c.req<{ projects: Proj[] }>("projects.list", {})).projects.map((p) => p.id)).not.toContain(project.id);
    expect(existsSync(join(repo, "README.md"))).toBe(true);

    await c.req("projects.delete", { projectId: aliasProj.id });
    const { projects } = await c.req<{ projects: Proj[] }>("projects.list", {});
    expect(projects.map((p) => p.id)).not.toContain(aliasProj.id);
    await expect(c.req("projects.delete", { projectId: "mac-mini" })).rejects.toMatchObject({ code: "INVALID" });
    await c.close();
  });
});
