// İş H (Adım 8) — Claude hesapları: service unit tests (temp HOME, never the real ~/.claude).
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@kokpit/shared";
import {
  CLAUDE_CONFIG_ENV,
  configDirFor,
  createClaudeAccountService,
  type ClaudeAccountsTunables,
} from "./claude-accounts.ts";
import { EngineError, type Logger } from "./contracts.ts";
import { createMemoryStore } from "./store.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const tunables: ClaudeAccountsTunables = {
  defaultId: "benim",
  defaultName: "Benim",
  defaultDirName: ".claude",
  idFallback: "hesap",
  idMaxLen: 50,
  shareNames: ["skills", "agents", "commands"],
  loginArgs: ["/login"],
};

const local = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, location: { kind: "local", path: "/tmp" }, ...extra });

function expectEngineError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe(code);
    return;
  }
  throw new Error("expected an EngineError");
}

describe("ClaudeAccountService", () => {
  let home: string;
  let store: ReturnType<typeof createMemoryStore>;
  const svc = () => {
    const s = createClaudeAccountService({ store, logger: silentLogger, homeDir: home, tunables });
    s.init();
    return s;
  };

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-accounts-")));
    store = createMemoryStore();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("seeds the default account at <HOME>/.claude without creating anything", () => {
    const s = svc();
    expect(s.list()).toEqual([{ id: "benim", name: "Benim", configDir: join(home, ".claude"), isDefault: true }]);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    svc(); // idempotent
    expect(s.list()).toHaveLength(1);
  });

  it("keeps a renamed default across restarts", () => {
    svc().update({ id: "benim", name: "Alex" });
    expect(svc().list()[0]!.name).toBe("Alex");
  });

  it("creates an account, expanding ~/ and creating the folder with 0700", () => {
    const a = svc().create({ name: "Work", configDir: "~/.claude-work" });
    expect(a).toEqual({ id: "work", name: "Work", configDir: join(home, ".claude-work") });
    expect(statSync(a.configDir).isDirectory()).toBe(true);
    expect(statSync(a.configDir).mode & 0o777).toBe(0o700);
  });

  it("an existing folder is reused as is (nothing deleted or rewritten)", () => {
    const dir = join(home, ".claude-work");
    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(join(dir, "settings.json"), "{}");
    svc().create({ name: "Work", configDir: dir });
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{}");
  });

  it("rejects folders outside HOME, HOME itself, files, and symlink escapes", () => {
    const s = svc();
    expectEngineError(() => s.create({ name: "A", configDir: "/etc/claude" }), "INVALID");
    expectEngineError(() => s.create({ name: "A", configDir: home }), "INVALID");
    expectEngineError(() => s.create({ name: "A", configDir: `${home}/../x` }), "INVALID");
    expectEngineError(() => s.create({ name: "A", configDir: "~/" }), "INVALID");
    writeFileSync(join(home, "file"), "x");
    expectEngineError(() => s.create({ name: "A", configDir: join(home, "file") }), "INVALID");
    const outside = mkdtempSync(join(tmpdir(), "kokpit-outside-"));
    try {
      symlinkSync(outside, join(home, "escape"));
      expectEngineError(() => s.create({ name: "A", configDir: join(home, "escape", "sub") }), "INVALID");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(s.list()).toHaveLength(1);
  });

  it("rejects duplicate names and folders (including the default's)", () => {
    const s = svc();
    s.create({ name: "Work", configDir: "~/.claude-work" });
    expectEngineError(() => s.create({ name: "work", configDir: "~/.other" }), "INVALID");
    expectEngineError(() => s.create({ name: "Başka", configDir: "~/.claude-work/" }), "INVALID");
    expectEngineError(() => s.create({ name: "Başka", configDir: "~/.claude" }), "INVALID");
  });

  it("ids are unique slugs", () => {
    const s = svc();
    const a = s.create({ name: "İş", configDir: "~/.c1" });
    const b = s.create({ name: "İŞ!", configDir: "~/.c2" });
    expect(a.id).not.toBe(b.id);
  });

  it("the default's folder cannot change; others can, folder validated", () => {
    const s = svc();
    expectEngineError(() => s.update({ id: "benim", configDir: "~/.x" }), "INVALID");
    const a = s.create({ name: "Work", configDir: "~/.claude-work" });
    expect(s.update({ id: a.id, configDir: "~/.claude-k2" }).configDir).toBe(join(home, ".claude-k2"));
    expect(existsSync(join(home, ".claude-work"))).toBe(true); // old folder kept
    expectEngineError(() => s.update({ id: a.id, configDir: "/tmp/x" }), "INVALID");
    expectEngineError(() => s.update({ id: "nope", name: "x" }), "NOT_FOUND");
  });

  it("delete: never the default, never while a project uses it, never removes the folder", () => {
    const s = svc();
    expectEngineError(() => s.delete("benim"), "INVALID");
    const a = s.create({ name: "Work", configDir: "~/.claude-work" });
    store.upsertProject(local("p", { claudeAccountId: a.id }));
    expectEngineError(() => s.delete(a.id), "INVALID");
    store.upsertProject(local("p"));
    s.delete(a.id);
    expect(s.list()).toHaveLength(1);
    expect(existsSync(join(home, ".claude-work"))).toBe(true);
    expectEngineError(() => s.delete(a.id), "NOT_FOUND");
  });

  it("configDirFor: the project's account, else the default", () => {
    const s = svc();
    const a = s.create({ name: "Work", configDir: "~/.claude-work" });
    expect(s.configDirFor({ claudeAccountId: a.id })).toBe(a.configDir);
    expect(s.configDirFor({})).toBe(join(home, ".claude"));
    expect(s.configDirFor({ claudeAccountId: "gone" })).toBe(join(home, ".claude"));
    expect(configDirFor(s.list(), { claudeAccountId: a.id })).toBe(a.configDir);
  });

  it("sharedRootsFor: non-default accounts may link into the default account's folder", () => {
    const s = svc();
    const a = s.create({ name: "Work", configDir: "~/.claude-work" });
    expect(s.sharedRootsFor({ claudeAccountId: a.id })).toEqual([join(home, ".claude")]);
    expect(s.sharedRootsFor({})).toEqual([]);
    expect(s.sharedRootsFor({ claudeAccountId: "benim" })).toEqual([]);
  });

  it("env is injected only for non-default accounts on local projects", () => {
    const s = svc();
    const a = s.create({ name: "Work", configDir: "~/.claude-work" });
    expect(s.envFor(local("p", { claudeAccountId: a.id }))).toEqual({ [CLAUDE_CONFIG_ENV]: a.configDir });
    expect(s.envFor(local("p"))).toEqual({});
    expect(s.envFor(local("p", { claudeAccountId: "benim" }))).toEqual({});
    expect(s.envFor(local("p", { claudeAccountId: "gone" }))).toEqual({});
    const ssh: Project = { id: "s", name: "s", location: { kind: "ssh", hostId: "h" }, claudeAccountId: a.id };
    expect(s.envFor(ssh)).toEqual({}); // accounts are local to the Mac mini
    // explicit account (login / attach) wins over the project's
    expect(s.envFor(local("p", { claudeAccountId: a.id }), "benim")).toEqual({});
    expect(s.envFor(local("p"), a.id)).toEqual({ [CLAUDE_CONFIG_ENV]: a.configDir });
  });

  it("requireAccount validates ids for projects", () => {
    const s = svc();
    expectEngineError(() => s.require("nope"), "NOT_FOUND");
    expect(s.require("benim").isDefault).toBe(true);
  });

  it("distinct dirs: one entry per folder, default first", () => {
    const s = svc();
    s.create({ name: "Work", configDir: "~/.claude-work" });
    expect(s.distinctDirs().map((d) => [d.accountId, d.isDefault])).toEqual([
      ["benim", true],
      ["work", false],
    ]);
  });

  describe("shareSkills", () => {
    it("links missing folders to the default's, skips existing ones and missing sources", () => {
      const s = svc();
      const def = join(home, ".claude");
      mkdirSync(join(def, "skills"), { recursive: true });
      mkdirSync(join(def, "agents"), { recursive: true });
      const a = s.create({ name: "Work", configDir: "~/.claude-work" });
      mkdirSync(join(a.configDir, "agents"));
      writeFileSync(join(a.configDir, "agents", "mine.md"), "x");
      const r = s.shareSkills(a.id);
      expect(r.linked).toEqual(["skills"]);
      expect(r.skipped.map((x) => x.name)).toEqual(["agents", "commands"]);
      expect(lstatSync(join(a.configDir, "skills")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(a.configDir, "skills"))).toBe(join(def, "skills"));
      expect(readFileSync(join(a.configDir, "agents", "mine.md"), "utf8")).toBe("x"); // never overwritten
      // second run: everything exists
      expect(s.shareSkills(a.id).linked).toEqual([]);
    });

    it("never replaces a dangling symlink or file", () => {
      const s = svc();
      mkdirSync(join(home, ".claude", "skills"), { recursive: true });
      const a = s.create({ name: "Work", configDir: "~/.claude-work" });
      symlinkSync(join(home, "nowhere"), join(a.configDir, "skills"));
      expect(s.shareSkills(a.id).linked).toEqual([]);
      expect(readlinkSync(join(a.configDir, "skills"))).toBe(join(home, "nowhere"));
    });

    it("is refused for the default account and unknown ids", () => {
      const s = svc();
      expectEngineError(() => s.shareSkills("benim"), "INVALID");
      expectEngineError(() => s.shareSkills("nope"), "NOT_FOUND");
    });
  });

  it("monkey: random inputs never corrupt the list or escape HOME", () => {
    const s = svc();
    const junk = ["", " ", "~", "~/", "~user/x", "/", "//", "/..", `${home}/a/../../b`, "\0", "~/a\0b", "~/" + "x".repeat(300), "~/ok-1", "~/ok-1", "~/a/b/c"];
    for (const [i, dir] of junk.entries()) {
      try {
        const a = s.create({ name: `n${i}`, configDir: dir });
        expect(a.configDir.startsWith(`${home}/`)).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
      }
    }
    const dirs = s.list().map((a) => a.configDir);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(s.list().filter((a) => a.isDefault)).toHaveLength(1);
  });
});
