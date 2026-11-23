import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, Project, SshHost, Tool } from "@kokpit/shared";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError, type EngineConfig, type HostPaths } from "./contracts.ts";
import { quoteShellArg, remoteShellCommand, resolveLaunch } from "./launch.ts";

const config = { shell: "/bin/zsh", shellArgs: ["-l"] } as EngineConfig;
const hostPaths: HostPaths = { homeDir: "/Users/me", sshDir: "/Users/me/.ssh", sshConfigFile: "/Users/me/.ssh/config" };
const SSH = "/usr/bin/ssh";

const local: Project = { id: "p", name: "P", location: { kind: "local", path: "/work/p" } };
const github: Project = { id: "g", name: "G", location: { kind: "github", url: "https://github.com/a/b", path: "/data/repos/g" } };
const sshProject = (path?: string, hostId = "h"): Project => ({
  id: "s",
  name: "S",
  location: path === undefined ? { kind: "ssh", hostId } : { kind: "ssh", hostId, path },
});
const kokpitHost: SshHost = { id: "h", name: "Kutu", hostname: "10.0.0.5", user: "ubuntu", port: 2222, identityFile: "id_ed25519", source: "kokpit" };
const card: Card = { id: "c", projectId: "p", name: "C", branch: "kokpit/c", worktreePath: "/data/wt/p/c", createdAt: "x" };
const tool: Tool = { id: "t", name: "Claude", command: "claude --dangerously-skip-permissions" };

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe("INVALID");
    return;
  }
  throw new Error("expected EngineError INVALID");
}

describe("resolveLaunch, local and github", () => {
  it("opens the configured shell in the project folder", () => {
    expect(resolveLaunch({ config, hostPaths, project: local, sshBinary: SSH })).toEqual({
      file: "/bin/zsh",
      args: ["-l"],
      cwd: "/work/p",
      title: "zsh",
    });
  });

  it("uses the card worktree and the clone path", () => {
    expect(resolveLaunch({ config, hostPaths, project: local, card, sshBinary: SSH }).cwd).toBe("/data/wt/p/c");
    expect(resolveLaunch({ config, hostPaths, project: github, sshBinary: SSH }).cwd).toBe("/data/repos/g");
  });

  it("types the tool command, explicit command wins", () => {
    const t = resolveLaunch({ config, hostPaths, project: local, tool, sshBinary: SSH });
    expect(t.initialInput).toBe("claude --dangerously-skip-permissions\r");
    expect(t.title).toBe("Claude");
    const c = resolveLaunch({ config, hostPaths, project: local, tool, command: "htop", sshBinary: SSH });
    expect(c.initialInput).toBe("htop\r");
    expect(c.title).toBe("htop");
  });

  it("expands engine file placeholders in the tool command at launch, leaving unknown ones and explicit commands alone", () => {
    const prompted: Tool = { id: "h", name: "İstemli", command: `claude --append-system-prompt "$(cat {{promptFile}})" {{other}}` };
    const placeholders = { promptFile: quoteShellArg("/now/engine dir/prompts/p.md") };
    const t = resolveLaunch({ config, hostPaths, project: local, tool: prompted, placeholders, sshBinary: SSH });
    expect(t.initialInput).toBe(`claude --append-system-prompt "$(cat '/now/engine dir/prompts/p.md')" {{other}}\r`);
    const c = resolveLaunch({ config, hostPaths, project: local, tool: prompted, command: "echo {{promptFile}}", placeholders, sshBinary: SSH });
    expect(c.initialInput).toBe("echo {{promptFile}}\r");
    expect(resolveLaunch({ config, hostPaths, project: local, tool: prompted, sshBinary: SSH }).initialInput).toBe(prompted.command + "\r");
  });

  it("does not share the args array with the config", () => {
    const l = resolveLaunch({ config, hostPaths, project: local, sshBinary: SSH });
    l.args.push("x");
    expect(config.shellArgs).toEqual(["-l"]);
  });

  it("rejects a card from another project and an un-cloned github project", () => {
    expectInvalid(() => resolveLaunch({ config, hostPaths, project: local, card: { ...card, projectId: "other" }, sshBinary: SSH }));
    const noPath: Project = { ...github, location: { kind: "github", url: "https://github.com/a/b" } };
    expectInvalid(() => resolveLaunch({ config, hostPaths, project: noPath, sshBinary: SSH }));
  });
});

describe("resolveLaunch, ssh", () => {
  it("builds ssh argv for a kokpit host", () => {
    expect(resolveLaunch({ config, hostPaths, project: sshProject("/srv/app"), host: kokpitHost, sshBinary: SSH })).toEqual({
      file: SSH,
      args: [
        "-t",
        "-p",
        "2222",
        "-i",
        "/Users/me/.ssh/id_ed25519",
        "-o",
        "IdentitiesOnly=yes",
        "--",
        "ubuntu@10.0.0.5",
        `cd '/srv/app' && exec "$SHELL" -l`,
      ],
      cwd: "/Users/me",
      title: "Kutu",
    });
  });

  it("minimal kokpit host, no path", () => {
    const h: SshHost = { id: "h", name: "N", hostname: "box", source: "kokpit" };
    expect(resolveLaunch({ config, hostPaths, project: sshProject(), host: h, sshBinary: SSH }).args).toEqual([
      "-t",
      "--",
      "box",
      `exec "$SHELL" -l`,
    ]);
  });

  it("uses the alias for ssh-config hosts and leaves port/key to ssh's own config", () => {
    const h: SshHost = { id: "oracle", name: "oracle", hostname: "oracle", user: "ubuntu", port: 22, identityFile: "k", source: "ssh-config" };
    const l = resolveLaunch({ config, hostPaths, project: sshProject("/x", "oracle"), host: h, tool, sshBinary: SSH });
    expect(l.args).toEqual(["-t", "--", "oracle", `cd '/x' && exec "$SHELL" -l`]);
    expect(l.initialInput).toBe("claude --dangerously-skip-permissions\r");
    expect(l.title).toBe("Claude");
  });

  it("rejects a card, a missing host and a host that is not the project's", () => {
    expectInvalid(() => resolveLaunch({ config, hostPaths, project: sshProject(), host: kokpitHost, card: { ...card, projectId: "s" }, sshBinary: SSH }));
    expectInvalid(() => resolveLaunch({ config, hostPaths, project: sshProject(), sshBinary: SSH }));
    expectInvalid(() => resolveLaunch({ config, hostPaths, project: sshProject(undefined, "other"), host: kokpitHost, sshBinary: SSH }));
  });

  it("rejects unsafe host fields instead of passing them to ssh", () => {
    const bad: Partial<SshHost>[] = [
      { hostname: "-oProxyCommand=touch /tmp/x" },
      { hostname: "a b" },
      { user: "-l" },
      { user: "a;b" },
      { port: 0 },
      { port: 1.5 },
      { identityFile: "../id" },
      { identityFile: "-x" },
    ];
    for (const b of bad) expectInvalid(() => resolveLaunch({ config, hostPaths, project: sshProject(), host: { ...kokpitHost, ...b }, sshBinary: SSH }));
    expectInvalid(() =>
      resolveLaunch({
        config,
        hostPaths,
        project: sshProject(undefined, "-oFoo"),
        host: { id: "-oFoo", name: "-oFoo", hostname: "-oFoo", source: "ssh-config" },
        sshBinary: SSH,
      }),
    );
  });

  it("rejects a remote path with a NUL byte", () => {
    expectInvalid(() => resolveLaunch({ config, hostPaths, project: sshProject("/a\0b"), host: kokpitHost, sshBinary: SSH }));
  });
});

const TRICKY = [
  "plain",
  "with space",
  "it's",
  "''",
  'dq"x',
  "$(touch PWNED)",
  "`touch PWNED`",
  "${HOME}",
  "semi;colon && x",
  "new\nline",
  "back\\slash",
  "-dash",
  "glob*?[a]",
  "ünïcødé",
  "'; touch PWNED; '",
];

describe("quoteShellArg", () => {
  it.each(TRICKY)("round-trips %j through sh as a single word", (s) => {
    const out = execFileSync("/bin/sh", ["-c", `printf %s ${quoteShellArg(s)}`], { encoding: "utf8" });
    expect(out).toBe(s);
  });
});

describe("remoteShellCommand, run by a real sh", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it.each(TRICKY)("cds into %j and execs $SHELL without running anything else", (name) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-launch-")));
    dirs.push(root);
    const work = join(root, "work");
    const bin = join(root, "bin");
    mkdirSync(work);
    mkdirSync(bin);
    const target = join(work, name);
    mkdirSync(target);
    // Stand-in for the remote login shell: prints where it was started and its args.
    const fakeShell = join(bin, "fake-shell");
    writeFileSync(fakeShell, '#!/bin/sh\nprintf "%s|%s" "$PWD" "$*"\n');
    chmodSync(fakeShell, 0o755);
    const out = execFileSync("/bin/sh", ["-c", remoteShellCommand(target)], {
      cwd: work,
      env: { PATH: process.env.PATH, SHELL: fakeShell },
      encoding: "utf8",
    });
    expect(out).toBe(`${target}|-l`);
    expect(existsSync(join(work, "PWNED"))).toBe(false);
    expect(readdirSync(work)).toEqual([name.split("/")[0]]);
  });

  it("without a path execs $SHELL in the remote home", () => {
    expect(remoteShellCommand(undefined)).toBe(`exec "$SHELL" -l`);
  });
});

describe("monkey", () => {
  it("random hosts and paths never inject options and only throw EngineError", () => {
    const atoms = ["-", "-o", "a", "Z", "0", ".", "@", ":", " ", "'", '"', "$(", "`", ";", "\n", "\0", "/", "é", "=", "_", "+"];
    let seed = 99;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const str = () => Array.from({ length: rnd(6) }, () => atoms[rnd(atoms.length)]).join("");
    const opt = <T,>(v: T): T | undefined => (rnd(3) === 0 ? undefined : v);
    let ok = 0;
    for (let i = 0; i < 3000; i++) {
      const host = {
        id: "h",
        name: str(),
        hostname: str(),
        user: opt(str()),
        port: opt([rnd(70000), -1, 0, 2.5, NaN][rnd(5)]),
        identityFile: opt(str()),
        source: rnd(2) ? "kokpit" : "ssh-config",
      } as SshHost;
      const path = opt("/" + str());
      try {
        const l = resolveLaunch({ config, hostPaths, project: sshProject(path), host, command: opt(str()), sshBinary: SSH });
        ok++;
        const sep = l.args.indexOf("--");
        expect(sep).toBeGreaterThan(0);
        expect(l.args.length).toBe(sep + 3);
        const target = l.args[sep + 1]!;
        expect(target.startsWith("-")).toBe(false);
        expect(target).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._@:+-]*$/);
        for (const a of l.args.slice(0, sep)) expect(a).not.toMatch(/[\s;$`'"\n]/);
        expect(l.file).toBe(SSH);
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
      }
    }
    expect(ok).toBeGreaterThan(0);
  });
});

