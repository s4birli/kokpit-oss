import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "./contracts.ts";
import { dataPaths, hostPaths, loadConfig } from "./config.ts";
import { slugify as slugifyRaw } from "./slug.ts";

const slugify = (t: string, o: { maxLen: number; fallback: string }) => slugifyRaw(t, o.maxLen, o.fallback);

type Entry = { level: string; msg: string; extra?: Record<string, unknown> };

function memLogger() {
  const entries: Entry[] = [];
  const logger: Logger = {
    info: (msg, extra) => entries.push({ level: "info", msg, extra }),
    warn: (msg, extra) => entries.push({ level: "warn", msg, extra }),
    error: (msg, extra) => entries.push({ level: "error", msg, extra }),
  };
  return { logger, entries };
}

const defaults = JSON.parse(
  readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected rejection");
}

let root: string;
let cfgPath: string;
let dataDir: string;
let home: string;

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { KOKPIT_CONFIG: cfgPath, HOME: home, SHELL: "/bin/zsh", ...extra };
}

function writeCfg(obj: unknown) {
  writeFileSync(cfgPath, typeof obj === "string" ? obj : JSON.stringify(obj));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kokpit-config-"));
  cfgPath = join(root, "engine.json");
  dataDir = join(root, "data");
  home = join(root, "home");
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("config.defaults.json", () => {
  it("ships the documented defaults and no dataDir, shell or key", () => {
    expect(defaults).toMatchObject({
      port: 7420,
      bufferBytes: 1048576,
      shellArgs: ["-l"],
      branchPrefix: "kokpit/",
      baseBranch: null,
      authTimeoutMs: 5000,
      tailscaleRescanMs: 30000,
      wsPingIntervalMs: 30000,
      listenLocalhost: true,
      listenTailscale: true,
      tailscaleCidrs: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"],
      projects: [],
      flushIntervalMs: 1000,
      killGraceMs: 2000,
      slugMaxLen: 50,
      slugFallback: "kart",
      gitCloneTimeoutMs: 300000,
      builtinProjectId: "mac-mini",
      builtinProjectName: "Mac mini",
      sshBinary: "ssh",
      claudeBinary: "claude",
      bgAgentsPollMs: 5000,
      bgAgentsIdlePollMaxMs: 20000,
      bgAgentsTimeoutMs: 15000,
      bgAgentsMaxOutputBytes: 2097152,
      bgAgentsLogsMaxChars: 65536,
    });
    expect(defaults).not.toHaveProperty("dataDir");
    expect(defaults).not.toHaveProperty("shell");
    expect(defaults).not.toHaveProperty("key");
  });
});

describe("loadConfig", () => {
  it("merges defaults with the user file and resolves derived fields", async () => {
    writeCfg({ dataDir, port: 9000 });
    const { logger } = memLogger();
    const c = await loadConfig({ env: env(), logger });
    expect(c.configPath).toBe(cfgPath);
    expect(c.port).toBe(9000);
    expect(c.dataDir).toBe(dataDir);
    expect(c.bufferBytes).toBe(1048576);
    expect(c.shell).toBe("/bin/zsh");
    expect(c.shellArgs).toEqual(["-l"]);
    expect(c.baseBranch).toBeNull();
    expect(c.tunables).toMatchObject({
      flushIntervalMs: 1000,
      killGraceMs: 2000,
      slugMaxLen: 50,
      slugFallback: "kart",
      gitCloneTimeoutMs: 300000,
      builtinProjectId: "mac-mini",
      builtinProjectName: "Mac mini",
      sshBinary: "ssh",
    });
    // İş A: agent activity tunables.
    expect(c.tunables.activity).toEqual({
      windowMs: 3000,
      debounceMs: 250,
      scanLines: 15,
      summaryMaxLen: 160,
      tailChars: 16384,
    });
    expect(existsSync(dataDir)).toBe(true);
  });

  it("uses XDG_CONFIG_HOME, then ~/.config, when KOKPIT_CONFIG is unset", async () => {
    const xdg = join(root, "xdg");
    mkdirSync(join(xdg, "kokpit"), { recursive: true });
    writeFileSync(join(xdg, "kokpit", "engine.json"), JSON.stringify({ dataDir }));
    const a = await loadConfig({ env: { HOME: home, SHELL: "/bin/sh", XDG_CONFIG_HOME: xdg }, logger: memLogger().logger });
    expect(a.configPath).toBe(join(xdg, "kokpit", "engine.json"));

    mkdirSync(join(home, ".config", "kokpit"), { recursive: true });
    writeFileSync(join(home, ".config", "kokpit", "engine.json"), JSON.stringify({ dataDir, port: 1234 }));
    const b = await loadConfig({ env: { HOME: home, SHELL: "/bin/sh" }, logger: memLogger().logger });
    expect(b.configPath).toBe(join(home, ".config", "kokpit", "engine.json"));
    expect(b.port).toBe(1234);
  });

  it("env overrides beat the user file", async () => {
    const otherData = join(root, "other");
    writeCfg({ dataDir, port: 9000, bufferBytes: 10, key: "file-key-0123456789abcdef-0123456789abcdef-0" });
    const c = await loadConfig({
      env: env({
        KOKPIT_PORT: "0",
        KOKPIT_DATA_DIR: otherData,
        KOKPIT_KEY: "env-key-0123456789abcdef-0123456789abcdef-0123",
        KOKPIT_BUFFER_BYTES: "4096",
      }),
      logger: memLogger().logger,
    });
    expect(c.port).toBe(0);
    expect(c.dataDir).toBe(otherData);
    expect(c.key).toBe("env-key-0123456789abcdef-0123456789abcdef-0123");
    expect(c.bufferBytes).toBe(4096);
  });

  it("İş A (Adım 7): background-agent tunables; env KOKPIT_BG_AGENTS_POLL_MS wins (0 = off)", async () => {
    writeCfg({ dataDir, claudeBinary: "/opt/claude", bgAgentsPollMs: 100 });
    const c = await loadConfig({ env: env(), logger: memLogger().logger });
    expect(c.tunables.bgAgents).toEqual({
      claudeBinary: "/opt/claude",
      pollMs: 100,
      idlePollMaxMs: 20000,
      timeoutMs: 15000,
      maxOutputBytes: 2097152,
      logsMaxChars: 65536,
    });
    const off = await loadConfig({ env: env({ KOKPIT_BG_AGENTS_POLL_MS: "0" }), logger: memLogger().logger });
    expect(off.tunables.bgAgents.pollMs).toBe(0);
    await expect(loadConfig({ env: env({ KOKPIT_BG_AGENTS_POLL_MS: "x" }), logger: memLogger().logger })).rejects.toThrow(
      /KOKPIT_BG_AGENTS_POLL_MS/,
    );
  });

  it("İş H: claudeAccounts block, merged key by key with the user file", async () => {
    writeCfg({ dataDir, claudeAccounts: { defaultName: "Ben" } });
    const c = await loadConfig({ env: env(), logger: memLogger().logger });
    expect(c.claudeAccounts).toEqual({
      defaultId: "benim",
      defaultName: "Ben",
      defaultDirName: ".claude",
      idFallback: "hesap",
      idMaxLen: 50,
      shareNames: ["skills", "agents", "commands"],
      loginArgs: ["/login"],
    });
    writeCfg({ dataDir, claudeAccounts: { defaultDirName: "" } });
    await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/claudeAccounts/);
    writeCfg({ dataDir, claudeAccounts: { shareNames: ["../x"] } });
    await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/claudeAccounts/);
  });

  it("terminalZdotdir: unset by default, from the file, env KOKPIT_TERMINAL_ZDOTDIR wins; must be absolute", async () => {
    writeCfg({ dataDir });
    expect((await loadConfig({ env: env(), logger: memLogger().logger })).tunables.terminalZdotdir).toBeUndefined();
    writeCfg({ dataDir, terminalZdotdir: "/z/file" });
    expect((await loadConfig({ env: env(), logger: memLogger().logger })).tunables.terminalZdotdir).toBe("/z/file");
    const fromEnv = await loadConfig({ env: env({ KOKPIT_TERMINAL_ZDOTDIR: "/z/env" }), logger: memLogger().logger });
    expect(fromEnv.tunables.terminalZdotdir).toBe("/z/env");
    writeCfg({ dataDir, terminalZdotdir: "relative" });
    await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/terminalZdotdir/);
  });

  it("works without a user file when env supplies dataDir", async () => {
    const c = await loadConfig({ env: env({ KOKPIT_DATA_DIR: dataDir }), logger: memLogger().logger });
    expect(c.port).toBe(7420);
    expect(c.projects).toEqual([]);
  });

  it("shell: config beats SHELL; missing both throws", async () => {
    writeCfg({ dataDir, shell: "/bin/bash" });
    expect((await loadConfig({ env: env(), logger: memLogger().logger })).shell).toBe("/bin/bash");
    writeCfg({ dataDir });
    await expect(loadConfig({ env: env({ SHELL: undefined }), logger: memLogger().logger })).rejects.toThrow(/shell/);
  });

  describe("dataDir", () => {
    it("is required", async () => {
      writeCfg({});
      await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/dataDir/);
    });

    it("must be absolute", async () => {
      writeCfg({ dataDir: "relative/data" });
      await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/dataDir.*absolute|absolute.*dataDir/);
    });

    it("expands ~", async () => {
      writeCfg({ dataDir: "~/kd" });
      const c = await loadConfig({ env: env(), logger: memLogger().logger });
      expect(c.dataDir).toBe(join(home, "kd"));
      expect(existsSync(join(home, "kd"))).toBe(true);
    });

    it("is not created when its parent is missing (unmounted disk)", async () => {
      const missing = join(root, "Volumes", "Yok", "kokpit-data");
      writeCfg({ dataDir: missing });
      await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/disk bağlı mı/);
      expect(existsSync(join(root, "Volumes"))).toBe(false);
    });

    it("rejects a dataDir that is a file", async () => {
      writeFileSync(dataDir, "x");
      writeCfg({ dataDir });
      await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/dataDir/);
    });
  });

  describe("projects", () => {
    it("derives slug ids, expands ~, warns on missing repo", async () => {
      const repo = join(root, "repo");
      mkdirSync(repo);
      mkdirSync(join(home, "r2"));
      writeCfg({
        dataDir,
        projects: [
          { name: "Şık Proje Ğüıöç", repoPath: repo },
          { name: "Other", repoPath: "~/r2", id: "custom" },
          { name: "Gone", repoPath: join(root, "nope") },
        ],
      });
      const { logger, entries } = memLogger();
      const c = await loadConfig({ env: env(), logger });
      expect(c.projects).toEqual([
        { id: "sik-proje-guioc", name: "Şık Proje Ğüıöç", location: { kind: "local", path: repo } },
        { id: "custom", name: "Other", location: { kind: "local", path: join(home, "r2") } },
        { id: "gone", name: "Gone", location: { kind: "local", path: join(root, "nope") } },
      ]);
      expect(entries.some((e) => e.level === "warn" && JSON.stringify(e).includes("nope"))).toBe(true);
    });

    it("rejects duplicate ids", async () => {
      writeCfg({ dataDir, projects: [{ name: "A b", repoPath: "/x" }, { name: "a-B", repoPath: "/y" }] });
      await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/a-b/);
    });

    it("rejects relative repoPath", async () => {
      writeCfg({ dataDir, projects: [{ name: "A", repoPath: "rel" }] });
      await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/projects\.0\.repoPath/);
    });
  });

  const EXISTING = "existing-key-0123456789abcdef-0123456789abcdef";
  const FILE_KEY = "file-key-0123456789abcdef-0123456789abcdef-012345";
  describe("key", () => {
    it("generates engine.key (0600) once and reuses it", async () => {
      writeCfg({ dataDir });
      const { logger, entries } = memLogger();
      const a = await loadConfig({ env: env(), logger });
      const keyFile = join(dataDir, "engine.key");
      expect(a.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      const b = await loadConfig({ env: env(), logger });
      expect(b.key).toBe(a.key);
      expect(JSON.stringify(entries)).not.toContain(a.key);
    });

    it("tightens a key file with wide permissions and warns", async () => {
      writeCfg({ dataDir });
      mkdirSync(dataDir);
      const keyFile = join(dataDir, "engine.key");
      writeFileSync(keyFile, `${EXISTING}\n`);
      chmodSync(keyFile, 0o644);
      const { logger, entries } = memLogger();
      const c = await loadConfig({ env: env(), logger });
      expect(c.key).toBe(EXISTING);
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(entries.some((e) => e.level === "warn")).toBe(true);
      expect(JSON.stringify(entries)).not.toContain("existing-key");
    });

    it("file key beats key file; env beats file key", async () => {
      writeCfg({ dataDir, key: FILE_KEY });
      expect((await loadConfig({ env: env(), logger: memLogger().logger })).key).toBe(FILE_KEY);
      expect(existsSync(join(dataDir, "engine.key"))).toBe(false);
    });

    it.each([
      ["in the config file", (k: string) => writeCfg({ dataDir, key: k })],
      ["in the key file", (k: string) => {
        writeCfg({ dataDir });
        mkdirSync(dataDir);
        writeFileSync(join(dataDir, "engine.key"), `${k}\n`, { mode: 0o600 });
      }],
    ])("refuses a weak key %s at startup, and says how to make a strong one", async (_n, put) => {
      put("kokpit-mac-mini-2026-guessable-but-long!!");
      const err = await failure(loadConfig({ env: env(), logger: memLogger().logger }));
      expect(err.message).toMatch(/32/);
      expect(err.message).toMatch(/randomBytes|openssl|engine\.key/);
      expect(err.message).not.toContain("guessable");
    });

    it("refuses a weak key from the environment", async () => {
      writeCfg({ dataDir });
      const err = await failure(loadConfig({ env: { ...env(), KOKPIT_KEY: "ab".repeat(24) }, logger: memLogger().logger }));
      expect(err.message).toMatch(/32/);
    });

    it("never puts the key in error messages", async () => {
      writeCfg({ dataDir, key: "short" });
      const err = await failure(loadConfig({ env: env(), logger: memLogger().logger }));
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/key/);
      expect(err.message).not.toContain("short");
    });
  });

  describe("errors name the field and config path", () => {
    it("unparsable JSON", async () => {
      writeCfg("{ nope");
      await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(cfgPath);
    });

    it("unknown field", async () => {
      writeCfg({ dataDir, prot: 1 });
      await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(/prot/);
    });

    it("bad env value names the variable", async () => {
      writeCfg({ dataDir });
      await expect(loadConfig({ env: env({ KOKPIT_PORT: "abc" }), logger: memLogger().logger })).rejects.toThrow(
        /KOKPIT_PORT/,
      );
      await expect(
        loadConfig({ env: env({ KOKPIT_BUFFER_BYTES: "-5" }), logger: memLogger().logger }),
      ).rejects.toThrow(/KOKPIT_BUFFER_BYTES/);
    });
  });

  describe("monkey: malformed values are rejected with field + path", () => {
    const cases: Array<[string, unknown]> = [
      ["port", -1],
      ["port", 70000],
      ["port", 1.5],
      ["port", "7420"],
      ["port", null],
      ["bufferBytes", 0],
      ["bufferBytes", 1e300],
      ["bufferBytes", Number.MAX_SAFE_INTEGER + 2],
      ["bufferBytes", "big"],
      ["shellArgs", "-l"],
      ["shellArgs", [1]],
      ["branchPrefix", 5],
      ["baseBranch", 3],
      ["authTimeoutMs", -10],
      ["authTimeoutMs", 1e12],
      ["tailscaleRescanMs", 0],
      ["wsPingIntervalMs", -1],
      ["wsPingIntervalMs", 1e12],
      ["listenLocalhost", "yes"],
      ["listenTailscale", 1],
      ["tailscaleCidrs", ["not-a-cidr"]],
      ["tailscaleCidrs", ["100.64.0.0/99"]],
      ["tailscaleCidrs", "100.64.0.0/10"],
      ["projects", {}],
      ["projects", [{ name: "x" }]],
      ["projects", [{ name: 1, repoPath: "/x" }]],
      ["projects", [{ name: "x", repoPath: "/x", id: "" }]],
      ["projects", [{ name: "x", repoPath: "/x", extra: true }]],
      ["flushIntervalMs", 0],
      ["killGraceMs", -1],
      ["slugMaxLen", 0],
      ["slugMaxLen", 1e9],
      ["slugFallback", ""],
      ["gitCloneTimeoutMs", 0],
      ["gitCloneTimeoutMs", "5m"],
      ["builtinProjectId", ""],
      ["builtinProjectId", "Mac Mini"],
      ["builtinProjectName", ""],
      ["builtinProjectName", "   "],
      ["sshBinary", ""],
      ["sshBinary", 1],
      ["claudeBinary", ""],
      ["bgAgentsPollMs", -1],
      ["bgAgentsIdlePollMaxMs", -1],
      ["bgAgentsTimeoutMs", 0],
      ["bgAgentsMaxOutputBytes", 0],
      ["bgAgentsLogsMaxChars", 0],
      ["shell", ""],
      ["shell", "zsh"],
      ["dataDir", 42],
      ["dataDir", ""],
      ["key", 12345],
    ];
    for (const [field, value] of cases) {
      it(`${field} = ${JSON.stringify(value)}`, async () => {
        writeCfg({ dataDir, [field]: value });
        const err = await failure(loadConfig({ env: env(), logger: memLogger().logger }));
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain(field);
        expect(err.message).toContain(cfgPath);
      });
    }

    it("non-object roots", async () => {
      for (const raw of ["[]", "null", "42", '"str"']) {
        writeCfg(raw);
        await expect(loadConfig({ env: env(), logger: memLogger().logger })).rejects.toThrow(cfgPath);
      }
    });

    it("random junk never crashes with a non-Error or succeeds silently with wrong types", async () => {
      const junk = [null, true, -1, 0, 1e308, "", "x", [], {}, [null], { a: 1 }, NaN];
      const fields = ["port", "bufferBytes", "shellArgs", "listenLocalhost", "projects", "tailscaleCidrs", "slugMaxLen"];
      let seed = 42;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % n;
      };
      for (let i = 0; i < 60; i++) {
        const obj: Record<string, unknown> = { dataDir };
        obj[fields[rnd(fields.length)]!] = junk[rnd(junk.length)];
        writeCfg(obj);
        try {
          const c = await loadConfig({ env: env(), logger: memLogger().logger });
          expect(Number.isInteger(c.port)).toBe(true);
          expect(Array.isArray(c.shellArgs)).toBe(true);
          expect(typeof c.listenLocalhost).toBe("boolean");
          expect(Array.isArray(c.projects)).toBe(true);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
          expect((e as Error).message).toContain(cfgPath);
        }
      }
    });
  });
});

describe("dataPaths", () => {
  it("derives and creates the data subdirectories", async () => {
    writeCfg({ dataDir });
    const c = await loadConfig({ env: env(), logger: memLogger().logger });
    const p = dataPaths(c);
    expect(p).toEqual({
      stateFile: join(dataDir, "state.json"),
      buffersDir: join(dataDir, "buffers"),
      worktreesDir: join(dataDir, "worktrees"),
      reposDir: join(dataDir, "repos"),
    });
    expect(statSync(p.buffersDir).isDirectory()).toBe(true);
    expect(statSync(p.worktreesDir).isDirectory()).toBe(true);
    expect(statSync(p.reposDir).isDirectory()).toBe(true);
    expect(dataPaths(c)).toEqual(p); // idempotent
  });
});

describe("hostPaths", () => {
  it("derives home, ~/.ssh and ~/.ssh/config from HOME", () => {
    expect(hostPaths({ HOME: "/Users/someone" })).toEqual({
      homeDir: "/Users/someone",
      sshDir: "/Users/someone/.ssh",
      sshConfigFile: "/Users/someone/.ssh/config",
    });
  });

  it("falls back to the OS home dir when HOME is unset or empty", () => {
    for (const env of [{}, { HOME: "" }]) {
      const p = hostPaths(env);
      expect(p.homeDir).toBe(homedir());
      expect(p.sshConfigFile).toBe(join(homedir(), ".ssh", "config"));
    }
  });

  it("does not create anything", () => {
    const h = join(root, "h2");
    hostPaths({ HOME: h });
    expect(existsSync(h)).toBe(false);
  });
});

describe("slugify", () => {
  const o = { maxLen: 50, fallback: "kart" };
  it("maps Turkish chars and collapses separators", () => {
    expect(slugify("  İstanbul ŞEHİR -- çığ!! ", o)).toBe("istanbul-sehir-cig");
  });
  it("falls back when nothing is left", () => {
    expect(slugify("!!!", o)).toBe("kart");
    expect(slugify("", o)).toBe("kart");
    expect(slugify("日本語", o)).toBe("kart");
  });
  it("truncates without a trailing dash", () => {
    const s = slugify("a".repeat(49) + " bcd", o);
    expect(s).toBe("a".repeat(49));
    expect(slugify("x".repeat(500), o)).toHaveLength(50);
  });
  it("monkey: output is always a valid slug", () => {
    let seed = 7;
    for (let i = 0; i < 500; i++) {
      let s = "";
      const len = (seed = (seed * 48271) % 2147483647) % 80;
      for (let j = 0; j < len; j++) s += String.fromCharCode((seed = (seed * 48271) % 2147483647) % 0x2000);
      const out = slugify(s, o);
      expect(out).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(out.length).toBeLessThanOrEqual(50);
    }
  });
});
