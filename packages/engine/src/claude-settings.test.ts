// Adım 9 İş A: the engine keeps ONLY its own `env` keys in a project's Claude settings file.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyManagedEnv, createClaudeBrowserSettings, removeManagedEnv, type ClaudeBrowserSettingsDeps } from "./claude-settings.ts";
import type { Logger, ManagedClaudeSettings } from "./contracts.ts";
import { createMemoryStore } from "./store.ts";

const PATH = [".claude", "settings.local.json"] as const;
const ENV = { PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:39201", PLAYWRIGHT_MCP_OUTPUT_DIR: "/tmp/out" };

let root: string;
let proj: string;
let file: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-claude-settings-")));
  proj = join(root, "proj");
  mkdirSync(proj);
  file = join(proj, ...PATH);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (f = file) => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
const put = (content: unknown, f = file) => {
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
};
const apply = (env: Record<string, string> = ENV, previous?: Record<string, string>) =>
  applyManagedEnv({ projectDir: proj, path: PATH, env, ...(previous ? { previous } : {}) });

describe("applyManagedEnv", () => {
  it("creates the folder and the file when neither exists, and says so", () => {
    const r = apply();
    expect(r).toEqual({ status: "written", file, createdFile: true, createdDir: true });
    expect(read()).toEqual({ env: ENV });
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps every other key, other env entries and their order; only its own keys change", () => {
    put({
      permissions: { allow: ["Bash(ls:*)"], deny: [] },
      env: { MINE: "1", PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:1", OTHER: "2" },
      enableAllProjectMcpServers: true,
    });
    const r = apply();
    expect(r).toMatchObject({ status: "written", createdFile: false, createdDir: false });
    expect(read()).toEqual({
      permissions: { allow: ["Bash(ls:*)"], deny: [] },
      env: { MINE: "1", PLAYWRIGHT_MCP_CDP_ENDPOINT: ENV.PLAYWRIGHT_MCP_CDP_ENDPOINT, OTHER: "2", PLAYWRIGHT_MCP_OUTPUT_DIR: ENV.PLAYWRIGHT_MCP_OUTPUT_DIR },
      enableAllProjectMcpServers: true,
    });
    expect(Object.keys(read())).toEqual(["permissions", "env", "enableAllProjectMcpServers"]);
    expect(Object.keys(read().env as object)).toEqual(["MINE", "PLAYWRIGHT_MCP_CDP_ENDPOINT", "OTHER", "PLAYWRIGHT_MCP_OUTPUT_DIR"]);
  });

  it("reads any JSON formatting (one line, tabs, CRLF) and keeps the file's indentation and mode", () => {
    put('{"permissions":{"allow":["x"]}}');
    apply();
    expect(read()).toEqual({ permissions: { allow: ["x"] }, env: ENV });

    put('{\r\n\t"a": 1,\r\n\t"env": {\r\n\t\t"MINE": "1"\r\n\t}\r\n}\r\n');
    chmodSync(file, 0o644);
    apply();
    expect(read()).toEqual({ a: 1, env: { MINE: "1", ...ENV } });
    expect(readFileSync(file, "utf8")).toContain('\n\t"a": 1');
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it("does not rewrite a file that already has the values", () => {
    put('{"env":{"PLAYWRIGHT_MCP_OUTPUT_DIR":"/tmp/out","PLAYWRIGHT_MCP_CDP_ENDPOINT":"http://127.0.0.1:39201"}}');
    const before = readFileSync(file, "utf8");
    expect(apply()).toMatchObject({ status: "unchanged", file });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("drops keys it wrote earlier and no longer wants — unless the user changed them", () => {
    put({ env: { OLD_A: "kokpit", OLD_B: "user-edited", KEEP: "1" } });
    apply(ENV, { OLD_A: "kokpit", OLD_B: "kokpit" });
    expect(read()).toEqual({ env: { OLD_B: "user-edited", KEEP: "1", ...ENV } });
  });

  it("writes atomically: no temp file is left behind", () => {
    put({ a: 1 });
    apply();
    expect(readdirSync(join(proj, ".claude"))).toEqual(["settings.local.json"]);
  });

  it.each([
    ["not JSON", "{ this is not json"],
    ["an array", "[]"],
    ["null", "null"],
    ["env that is not an object", '{"env":"x"}'],
    ["env that is an array", '{"env":[]}'],
  ])("leaves a file with %s untouched", (_n, content) => {
    put(content);
    expect(apply().status).toBe("skipped");
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("never follows a symlinked folder out of the project", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(proj, ".claude"));
    expect(apply().status).toBe("skipped");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("never follows a symlinked file out of the project (existing or dangling)", () => {
    const outside = join(root, "outside.json");
    writeFileSync(outside, "{}");
    mkdirSync(join(proj, ".claude"));
    symlinkSync(outside, file);
    expect(apply().status).toBe("skipped");
    expect(readFileSync(outside, "utf8")).toBe("{}");

    rmSync(file);
    symlinkSync(join(root, "missing.json"), file);
    expect(apply().status).toBe("skipped");
    expect(existsSync(join(root, "missing.json"))).toBe(false);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it("follows symlinks that stay inside the project and writes the real file", () => {
    const realDir = join(proj, "config");
    mkdirSync(realDir);
    symlinkSync(realDir, join(proj, ".claude"));
    const r = apply();
    expect(r).toMatchObject({ status: "written", file: join(realDir, "settings.local.json") });
    expect(read(join(realDir, "settings.local.json"))).toEqual({ env: ENV });
    expect(lstatSync(join(proj, ".claude")).isSymbolicLink()).toBe(true);
  });

  it("skips a missing project folder, a folder where the file should be, and a file where the folder should be", () => {
    expect(applyManagedEnv({ projectDir: join(root, "nope"), path: PATH, env: ENV }).status).toBe("skipped");
    mkdirSync(file, { recursive: true });
    expect(apply().status).toBe("skipped");
    rmSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, ".claude"), "x");
    expect(apply().status).toBe("skipped");
    expect(readFileSync(join(proj, ".claude"), "utf8")).toBe("x");
  });
});

describe("removeManagedEnv", () => {
  const rec = (over: Partial<ManagedClaudeSettings> = {}): ManagedClaudeSettings => ({ file, env: ENV, ...over });

  it("removes only the keys it wrote, with the values it wrote", () => {
    put({ a: 1, env: { MINE: "1", PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:5555", PLAYWRIGHT_MCP_OUTPUT_DIR: "/tmp/out" } });
    expect(removeManagedEnv(rec()).status).toBe("removed");
    // The endpoint was changed by the user: not ours any more.
    expect(read()).toEqual({ a: 1, env: { MINE: "1", PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:5555" } });
  });

  it("drops an env block it emptied; keeps the file when something else is in it or it was not created by the engine", () => {
    put({ a: 1, env: ENV });
    removeManagedEnv(rec({ createdFile: true }));
    expect(read()).toEqual({ a: 1 });
    put({ env: ENV });
    removeManagedEnv(rec());
    expect(read()).toEqual({});
  });

  it("deletes the file and folder it created once nothing else is in them", () => {
    const made = apply();
    expect(made).toMatchObject({ createdFile: true, createdDir: true });
    removeManagedEnv(rec({ createdFile: true, createdDir: true }));
    expect(existsSync(join(proj, ".claude"))).toBe(false);

    apply();
    writeFileSync(join(proj, ".claude", "other.txt"), "x");
    removeManagedEnv(rec({ createdFile: true, createdDir: true }));
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(proj, ".claude"))).toEqual(["other.txt"]);
  });

  it("does nothing for a missing file, unreadable JSON, or a path that became a symlink", () => {
    expect(removeManagedEnv(rec()).status).toBe("unchanged");
    put("{ nope");
    expect(removeManagedEnv(rec()).status).toBe("skipped");
    expect(readFileSync(file, "utf8")).toBe("{ nope");

    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({ env: ENV }));
    rmSync(file);
    symlinkSync(outside, file);
    expect(removeManagedEnv(rec()).status).toBe("skipped");
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({ env: ENV });
  });
});

describe("createClaudeBrowserSettings", () => {
  const local = (over: Partial<Project> = {}): Project => ({ id: "Acme", name: "Acme", location: { kind: "local", path: proj }, ...over });

  function setup(initial: Project[] = [local()]) {
    const projects = new Map(initial.map((p) => [p.id, p]));
    const store = createMemoryStore();
    const running = new Set<string>();
    const warnings: string[] = [];
    const logger: Logger = { info() {}, warn: (m) => warnings.push(m), error() {} };
    let env: Record<string, string> = ENV;
    const protectedDirs: string[] = [];
    const deps: ClaudeBrowserSettingsDeps = {
      path: PATH,
      store,
      logger,
      getProject: (id) => projects.get(id),
      envFor: (p) => (p.location.kind === "local" || p.location.kind === "github" ? env : {}),
      isRunning: (id) => running.has(id),
      protectedDirs: () => protectedDirs,
    };
    return {
      svc: createClaudeBrowserSettings(deps),
      store,
      projects,
      running,
      warnings,
      protectedDirs,
      setEnv: (e: Record<string, string>) => (env = e),
    };
  }

  it("writes nothing until the project's browser has started", () => {
    const { svc, store } = setup();
    svc.sync("Acme");
    expect(existsSync(join(proj, ".claude"))).toBe(false);
    expect(store.getManagedClaudeSettings("Acme")).toBeUndefined();
  });

  it("writes when the browser starts and remembers exactly what it wrote", () => {
    const { svc, store } = setup();
    svc.sync("Acme", { started: true });
    expect(read()).toEqual({ env: ENV });
    expect(store.getManagedClaudeSettings("Acme")).toEqual({ file, env: ENV, createdFile: true, createdDir: true });
  });

  it("corrects stale values later (e.g. on the next engine start), without the browser running", () => {
    const { svc, store, setEnv } = setup();
    svc.sync("Acme", { started: true });
    setEnv({ ...ENV, PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:39777" });
    svc.syncAll();
    expect((read().env as Record<string, string>).PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe("http://127.0.0.1:39777");
    expect(store.getManagedClaudeSettings("Acme")?.env.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe("http://127.0.0.1:39777");
    // Still knows it created the file.
    expect(store.getManagedClaudeSettings("Acme")?.createdFile).toBe(true);
  });

  it("restores its keys when the user deleted them while the option is on", () => {
    const { svc } = setup();
    svc.sync("Acme", { started: true });
    put({ env: { MINE: "1" } });
    svc.syncAll();
    expect(read()).toEqual({ env: { MINE: "1", ...ENV } });
  });

  it("option off: removes its keys and forgets the project; back on with the browser running: writes again", () => {
    const { svc, store, projects, running } = setup();
    put({ permissions: {}, env: { MINE: "1" } });
    svc.sync("Acme", { started: true });
    running.add("Acme");
    projects.set("Acme", local({ claudeBrowserEnv: false }));
    svc.sync("Acme");
    expect(read()).toEqual({ permissions: {}, env: { MINE: "1" } });
    expect(store.getManagedClaudeSettings("Acme")).toBeUndefined();
    // Off stays off even when the browser starts again.
    svc.sync("Acme", { started: true });
    expect(read()).toEqual({ permissions: {}, env: { MINE: "1" } });

    projects.set("Acme", local({ claudeBrowserEnv: true }));
    svc.sync("Acme");
    expect(read()).toEqual({ permissions: {}, env: { MINE: "1", ...ENV } });
  });

  it("project deleted: its keys go, the record goes", () => {
    const { svc, store, projects } = setup();
    svc.sync("Acme", { started: true });
    projects.delete("Acme");
    svc.sync("Acme");
    expect(existsSync(join(proj, ".claude"))).toBe(false);
    expect(store.listManagedClaudeSettings()).toEqual({});
  });

  it("forget (project about to be deleted): keys go while the project record still exists", () => {
    const { svc, store } = setup();
    put({ a: 1 });
    svc.sync("Acme", { started: true });
    svc.forget("Acme");
    expect(read()).toEqual({ a: 1 });
    expect(store.listManagedClaudeSettings()).toEqual({});
    expect(() => svc.forget("unknown")).not.toThrow();
  });

  it("location changed: the old folder is cleaned, the new one is written", () => {
    const { svc, store, projects } = setup();
    svc.sync("Acme", { started: true });
    const other = join(root, "other");
    mkdirSync(other);
    projects.set("Acme", local({ location: { kind: "local", path: other } }));
    svc.sync("Acme");
    expect(existsSync(join(proj, ".claude"))).toBe(false);
    expect(read(join(other, ...PATH))).toEqual({ env: ENV });
    expect(store.getManagedClaudeSettings("Acme")?.file).toBe(join(other, ...PATH));
  });

  it("never creates anything for ssh projects or a browser on the app's machine", () => {
    const { svc, store, projects } = setup([]);
    for (const p of [
      local({ location: { kind: "ssh", hostId: "oracle", path: proj } }),
    ] as Project[]) {
      projects.set(p.id, p);
      svc.sync(p.id, { started: true });
      expect(existsSync(join(proj, ".claude"))).toBe(false);
    }
    expect(store.listManagedClaudeSettings()).toEqual({});
  });

  it("a project that became ssh loses the keys written while it was local", () => {
    const { svc, projects } = setup();
    svc.sync("Acme", { started: true });
    projects.set("Acme", local({ location: { kind: "ssh", hostId: "oracle" } }));
    svc.sync("Acme");
    expect(existsSync(join(proj, ".claude"))).toBe(false);
  });

  it("never writes into a protected folder (Claude's own config dir, e.g. the home project's ~/.claude)", () => {
    const { svc, store, protectedDirs, warnings } = setup();
    mkdirSync(join(proj, ".claude"));
    protectedDirs.push(join(proj, ".claude"));
    svc.sync("Acme", { started: true });
    expect(readdirSync(join(proj, ".claude"))).toEqual([]);
    expect(store.getManagedClaudeSettings("Acme")).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("protects a config dir that does not exist yet, also when it is named through a symlinked parent", () => {
    const { svc, protectedDirs } = setup();
    const link = join(root, "link-to-proj");
    symlinkSync(proj, link);
    protectedDirs.push(join(link, ".claude"));
    svc.sync("Acme", { started: true });
    expect(existsSync(join(proj, ".claude"))).toBe(false);
  });

  it("a file it must not touch is reported once per sync and nothing is recorded", () => {
    const { svc, store, warnings } = setup();
    put("{ broken");
    svc.sync("Acme", { started: true });
    expect(readFileSync(file, "utf8")).toBe("{ broken");
    expect(store.getManagedClaudeSettings("Acme")).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("sync never throws (a failing store is logged)", () => {
    const { svc, store, warnings } = setup();
    store.setManagedClaudeSettings = () => {
      throw new Error("disk full");
    };
    expect(() => svc.sync("Acme", { started: true })).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
