import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card, Project, SshHost, TerminalInfo, Tool } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandPlaceholders } from "./launch.ts";
import { EngineError, type EngineConfig, type Logger, type StateStore, type StoredSettings } from "./contracts.ts";
import { createToolService, loadToolDefaults, TOOL_DEFAULTS_PATH, type ToolServiceDeps } from "./tools.ts";

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Minimal StateStore v2: only tools + seed flags are real; the rest is unused by ToolService. */
class ToolStore implements StateStore {
  readonly tools = new Map<string, Tool>();
  readonly seeded = new Set<string>();
  listTools(): Tool[] {
    return [...this.tools.values()].map((t) => structuredClone(t));
  }
  getTool(toolId: string): Tool | undefined {
    const t = this.tools.get(toolId);
    return t && structuredClone(t);
  }
  upsertTool(tool: Tool): void {
    this.tools.set(tool.id, structuredClone(tool));
  }
  removeTool(toolId: string): void {
    this.tools.delete(toolId);
  }
  settings: StoredSettings = {};
  getSettings(): StoredSettings {
    return { ...this.settings };
  }
  updateSettings(patch: StoredSettings): void {
    this.settings = { ...this.settings, ...patch };
  }
  isSeeded(key: string): boolean {
    return this.seeded.has(key);
  }
  markSeeded(key: string): void {
    this.seeded.add(key);
  }
  listProjects(): Project[] {
    return [];
  }
  getProject(): Project | undefined {
    return undefined;
  }
  upsertProject(): void {}
  removeProject(): void {}
  listSshHosts(): SshHost[] {
    return [];
  }
  getSshHost(): SshHost | undefined {
    return undefined;
  }
  upsertSshHost(): void {}
  removeSshHost(): void {}
  listCards(): Card[] {
    return [];
  }
  getCard(): Card | undefined {
    return undefined;
  }
  addCard(): void {}
  removeCard(): void {}
  listTerminals(): TerminalInfo[] {
    return [];
  }
  getTerminal(): TerminalInfo | undefined {
    return undefined;
  }
  upsertTerminal(): void {}
  removeTerminal(): void {}
}

function makeConfig(shell: string): EngineConfig {
  return {
    configPath: "/x/config.json",
    port: 0,
    dataDir: "/x",
    bufferBytes: 1024,
    shell,
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
  };
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

const DEFAULTS: Tool[] = [
  { id: "a", name: "A", command: "a", checkCommand: "command -v a", installCommand: "install a" },
  { id: "b", name: "B", command: "b" },
];

describe("tools.defaults.json", () => {
  it("ships the default tools, the initial global default and a check timeout", () => {
    const d = loadToolDefaults(TOOL_DEFAULTS_PATH);
    expect(TOOL_DEFAULTS_PATH).toBe(join(ENGINE_DIR, "tools.defaults.json"));
    expect(d.checkTimeoutMs).toBeGreaterThan(0);
    expect(d.tools.map((t) => t.id)).toEqual(["claude", "claude-skip", "claude-agents-skip", "codex", "gemini", "claude-tarayici"]);
    // A user who never picks a default gets plain `claude`.
    expect(d.defaultToolId).toBe("claude");
    const byId = Object.fromEntries(d.tools.map((t) => [t.id, t]));
    expect(byId.claude).toMatchObject({ command: "claude", checkCommand: "command -v claude" });
    expect(byId["claude-skip"]?.command).toBe("claude --dangerously-skip-permissions");
    expect(byId["claude-skip"]?.installCommand).toBe(byId.claude?.installCommand);
    expect(byId["claude-agents-skip"]).toMatchObject({
      name: "Claude Agents (skip permissions)",
      command: "claude agents --dangerously-skip-permissions",
      checkCommand: byId.claude?.checkCommand,
      installCommand: byId.claude?.installCommand,
    });
    expect(byId.codex).toMatchObject({ command: "codex", installCommand: "npm install -g @openai/codex" });
    // `command gemini` bypasses the user's interactive-only alias and runs the real binary.
    expect(byId.gemini).toMatchObject({ command: "command gemini", checkCommand: "command -v gemini" });
    for (const t of d.tools) expect(t.installCommand).toMatch(/^npm install -g /);
  });


  it("rejects unknown placeholders and missing placeholder files", () => {
    const dir = mkdtempSync(join(tmpdir(), "kokpit-tools-"));
    try {
      const f = join(dir, "t.json");
      const good = JSON.parse(readFileSync(TOOL_DEFAULTS_PATH, "utf8")) as Record<string, unknown>;
      writeFileSync(f, JSON.stringify({ ...good, tools: [{ id: "x", name: "X", command: "x {{nope}}" }], defaultToolId: "x", laterSteps: [], waitingPatternSteps: [], files: {} }));
      expect(() => loadToolDefaults(f)).toThrow(/nope/);
      const inInstall = [{ id: "x", name: "X", command: "x", installCommand: "cp {{flowPromptFile}} ." }];
      writeFileSync(f, JSON.stringify({ ...good, tools: inInstall, defaultToolId: "x", laterSteps: [], waitingPatternSteps: [], files: {} }));
      expect(() => loadToolDefaults(f)).toThrow(/installCommand/);
      writeFileSync(f, JSON.stringify({ ...good, files: { flowPromptFile: "missing.md" } }));
      expect(() => loadToolDefaults(f)).toThrow(/missing\.md/);
      writeFileSync(f, JSON.stringify({ ...good, laterSteps: [{ key: "default-tools-3", toolIds: ["not-a-tool"] }] }));
      expect(() => loadToolDefaults(f)).toThrow(f);
      writeFileSync(f, JSON.stringify({ ...good, waitingPatternSteps: [{ key: "w", toolIds: ["not-a-tool"] }] }));
      expect(() => loadToolDefaults(f)).toThrow(/waitingPatternSteps/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed files with the file path in the message", () => {
    const dir = mkdtempSync(join(tmpdir(), "kokpit-tools-"));
    try {
      const f = join(dir, "t.json");
      writeFileSync(f, JSON.stringify({ checkTimeoutMs: -1, tools: [] }));
      expect(() => loadToolDefaults(f)).toThrow(f);
      const good = loadToolDefaults(TOOL_DEFAULTS_PATH);
      writeFileSync(f, JSON.stringify({ ...good, defaultToolId: "not-a-default-tool" }));
      expect(() => loadToolDefaults(f)).toThrow(f);
      writeFileSync(f, "{nope");
      expect(() => loadToolDefaults(f)).toThrow(f);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ToolService", () => {
  let store: ToolStore;
  let used: Map<string, number>;
  let globalDefault: string | undefined;
  let runs: { shell: string; args: string[]; timeoutMs: number }[];
  let runImpl: (shell: string, args: string[], timeoutMs: number) => Promise<{ code: number | null }>;

  function service(over: Partial<ToolServiceDeps> = {}) {
    return createToolService({
      config: makeConfig("/bin/zsh"),
      store,
      logger: silentLogger,
      projectsUsingTool: (id) => used.get(id) ?? 0,
      isGlobalDefault: (id) => id === globalDefault,
      defaults: DEFAULTS,
      checkTimeoutMs: 1234,
      idMaxLen: 20,
      idFallback: "arac",
      run: (shell, args, timeoutMs) => {
        runs.push({ shell, args, timeoutMs });
        return runImpl(shell, args, timeoutMs);
      },
      ...over,
    });
  }

  beforeEach(() => {
    store = new ToolStore();
    used = new Map();
    globalDefault = undefined;
    runs = [];
    runImpl = async () => ({ code: 0 });
  });

  it("init seeds the defaults once as builtin tools", () => {
    const s = service();
    s.init();
    expect(s.list()).toEqual([
      { ...DEFAULTS[0], builtin: true },
      { ...DEFAULTS[1], builtin: true },
    ]);
    expect(store.isSeeded("default-tools")).toBe(true);
    expect(store.isSeeded("default-tools-2")).toBe(true);
  });

  it("init on an install seeded before step 2 adds only missing defaults, keeping edits", () => {
    store.upsertTool({ ...DEFAULTS[0]!, command: "a --mine", builtin: true });
    store.upsertTool({ id: "own", name: "Own", command: "own" });
    store.markSeeded("default-tools");
    service().init();
    expect(store.listTools()).toEqual([
      { ...DEFAULTS[0], command: "a --mine", builtin: true },
      { id: "own", name: "Own", command: "own" },
      { ...DEFAULTS[1], builtin: true },
    ]);
    expect(store.isSeeded("default-tools-2")).toBe(true);
    // Once step 2 ran, a deleted default stays deleted.
    store.removeTool("b");
    service().init();
    expect(store.getTool("b")).toBeUndefined();
  });

  // ---- later seed steps ----
  it("a later seed step adds only its own tools, once, never resurrecting deleted defaults", () => {
    const later = [{ key: "default-tools-3", toolIds: ["b"] }];
    store.upsertTool({ ...DEFAULTS[0]!, builtin: true });
    store.markSeeded("default-tools");
    store.markSeeded("default-tools-2");
    // "a" deleted by the user before step 3 shipped; step 3 adds only "b".
    store.removeTool("a");
    service({ laterSteps: later }).init();
    expect(store.listTools()).toEqual([{ ...DEFAULTS[1], builtin: true }]);
    expect(store.isSeeded("default-tools-3")).toBe(true);
    store.removeTool("b");
    service({ laterSteps: later }).init();
    expect(store.getTool("b")).toBeUndefined();
  });

  it("a fresh install marks later seed steps done", () => {
    service({ laterSteps: [{ key: "default-tools-3", toolIds: ["b"] }] }).init();
    expect(store.isSeeded("default-tools-3")).toBe(true);
  });

  it("seeds the real defaults with the placeholder, never an absolute path", () => {
    const d = loadToolDefaults(TOOL_DEFAULTS_PATH);
    service({ defaults: d.tools, laterSteps: d.laterSteps, files: d.files, fileArgs: d.fileArgs }).init();
    expect(store.getTool("claude-tarayici")?.command).toMatch(/ sh \{\{claudeBrowserScript\}\}$/);
  });

  it("migrates a seeded command holding a stale absolute prompt path back to the placeholder, once, only if otherwise unchanged", () => {
    const template = `claude --append-system-prompt "$(cat {{promptFile}})"`;
    const defaults: Tool[] = [
      { id: "h", name: "H", command: template, checkCommand: "test -f {{promptFile}}" },
      { id: "e", name: "E", command: template },
    ];
    const files = { promptFile: "prompts/ornek-istem.md" };
    const fileArgs = { promptFile: "'/now/x.md'" };
    const stale = (dir: string) => `'${dir}/packages/engine/prompts/ornek-istem.md'`;
    // A removed worktree whose path even contains a quote (as quoteShellArg wrote it).
    const oldDir = "/gone/it'\\''s tree";
    store.upsertTool({ id: "h", name: "H", command: `claude --append-system-prompt "$(cat ${stale(oldDir)})"`, checkCommand: `test -f ${stale("/old")}`, builtin: true });
    // Edited by the user: the command differs beyond the path, so it is left alone.
    const edited = `claude --model x --append-system-prompt "$(cat ${stale("/old")})"`;
    store.upsertTool({ id: "e", name: "E", command: edited, builtin: true });
    for (const k of ["default-tools", "default-tools-2"]) store.markSeeded(k);
    service({ defaults, files, fileArgs }).init();
    expect(store.getTool("h")).toMatchObject({ command: template, checkCommand: "test -f {{promptFile}}" });
    expect(store.getTool("e")?.command).toBe(edited);
    expect(store.isSeeded("default-tools-placeholders")).toBe(true);
    // Once: a path the user types in later stays.
    store.upsertTool({ ...store.getTool("h")!, command: `claude --append-system-prompt "$(cat ${stale("/mine")})"` });
    service({ defaults, files, fileArgs }).init();
    expect(store.getTool("h")?.command).toContain("/mine/");
  });

  it("check expands placeholders in checkCommand with the current engine's paths", async () => {
    store.upsertTool({ id: "h", name: "H", command: "h", checkCommand: "test -f {{f}}" });
    store.markSeeded("default-tools");
    await service({ fileArgs: { f: "'/now/p.md'" } }).check();
    expect(runs.map((r) => r.args.at(-1))).toContain("test -f '/now/p.md'");
  });

  it("init keeps user edits and deletions on later starts", () => {
    service().init();
    const s = service();
    s.update({ toolId: "a", command: "a --fast" });
    s.delete("b");
    service().init();
    expect(store.listTools()).toEqual([{ ...DEFAULTS[0], command: "a --fast", builtin: true }]);
  });

  it("create derives a unique slug id from the name", () => {
    const s = service();
    s.init();
    const t = s.create({ name: "Aider Çalış", command: "aider" });
    expect(t).toEqual({ id: "aider-calis", name: "Aider Çalış", command: "aider" });
    expect(s.create({ name: "aider  çalış!", command: "x" }).id).toBe("aider-calis-2");
    expect(s.create({ name: "AIDER ÇALIŞ", command: "x" }).id).toBe("aider-calis-3");
    expect(s.create({ name: "a", command: "x" }).id).toBe("a-2"); // collides with a default
    expect(s.create({ name: "!!!", command: "x" }).id).toBe("arac");
    expect(s.get("aider-calis")).toEqual(t);
  });

  it("create keeps optional fields and never marks builtin", () => {
    const t = service().create({ name: "X", command: "x", installCommand: "i", checkCommand: "c" });
    expect(t).toEqual({ id: "x", name: "X", command: "x", installCommand: "i", checkCommand: "c" });
  });

  it("update changes fields, null clears install/check, id and builtin stay", () => {
    const s = service();
    s.init();
    const t = s.update({ toolId: "a", name: "Yeni", installCommand: null, checkCommand: null });
    expect(t).toEqual({ id: "a", name: "Yeni", command: "a", builtin: true });
    expect(store.getTool("a")).toEqual(t);
    expect(s.update({ toolId: "a" })).toEqual(t);
    expect(s.update({ toolId: "a", checkCommand: "c2" }).checkCommand).toBe("c2");
  });

  it("update/delete of an unknown tool → NOT_FOUND", () => {
    const s = service();
    expectCode(() => s.update({ toolId: "zz", name: "n" }), "NOT_FOUND");
    expectCode(() => s.delete("zz"), "NOT_FOUND");
    expect(s.get("zz")).toBeUndefined();
  });

  it("delete refuses a tool that is a project's default; builtin tools can be deleted", () => {
    const s = service();
    s.init();
    used.set("a", 2);
    expectCode(() => s.delete("a"), "INVALID");
    expect(s.get("a")).toBeDefined();
    s.delete("b");
    expect(s.get("b")).toBeUndefined();
  });

  it("delete refuses the global default tool with a Turkish message", () => {
    const s = service();
    s.init();
    globalDefault = "a";
    try {
      s.delete("a");
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as EngineError).code).toBe("INVALID");
      expect((err as Error).message).toMatch(/varsayılan/);
    }
    expect(s.get("a")).toBeDefined();
    s.delete("b");
  });

  it("check runs each checkCommand in a non-interactive login shell, in parallel, with the timeout", async () => {
    const s = service();
    s.init();
    s.create({ name: "C", command: "c", checkCommand: "command -v c" });
    const pending: (() => void)[] = [];
    runImpl = (_shell, args) =>
      new Promise((resolve) => pending.push(() => resolve({ code: args[1] === "command -v a" ? 0 : 1 })));
    const p = s.check();
    await new Promise((r) => setTimeout(r, 0));
    expect(pending).toHaveLength(2); // both started before either finished
    for (const done of pending) done();
    expect(await p).toEqual([
      { toolId: "a", installed: true },
      { toolId: "b", installed: null },
      { toolId: "c", installed: false },
    ]);
    // `-lc` without `-i`: interactive-only aliases (e.g. the user's `gemini`) are not loaded,
    // so `command -v` reflects the real binary on PATH.
    expect(runs).toEqual([
      { shell: "/bin/zsh", args: ["-lc", "command -v a"], timeoutMs: 1234 },
      { shell: "/bin/zsh", args: ["-lc", "command -v c"], timeoutMs: 1234 },
    ]);
  });

  it("check reports false when the runner fails or times out", async () => {
    const s = service();
    s.init();
    runImpl = async () => {
      throw new Error("spawn failed");
    };
    expect(await s.check()).toEqual([
      { toolId: "a", installed: false },
      { toolId: "b", installed: null },
    ]);
    runImpl = async () => ({ code: null });
    expect((await s.check())[0]).toEqual({ toolId: "a", installed: false });
  });
});

describe("ToolService default runner (real shell)", () => {
  function realService(checkCommand: string, timeoutMs: number) {
    const store = new ToolStore();
    const s = createToolService({
      config: makeConfig("/bin/sh"),
      store,
      logger: silentLogger,
      projectsUsingTool: () => 0,
      isGlobalDefault: () => false,
      defaults: [{ id: "t", name: "T", command: "t", checkCommand }],
      checkTimeoutMs: timeoutMs,
      idMaxLen: 20,
      idFallback: "arac",
    });
    s.init();
    return s;
  }

  it("exit 0 → installed, non-zero → not installed", async () => {
    expect(await realService("command -v sh", 5000).check()).toEqual([{ toolId: "t", installed: true }]);
    expect(await realService("command -v kokpit-no-such-binary-xyz", 5000).check()).toEqual([
      { toolId: "t", installed: false },
    ]);
  });

  it("the check shell is non-interactive", async () => {
    // $- contains "i" only in interactive shells, where aliases from rc files would apply.
    const s = realService('case $- in *i*) exit 1;; esac; exit 0', 5000);
    expect(await s.check()).toEqual([{ toolId: "t", installed: true }]);
  });

  it("a hanging check times out as not installed", async () => {
    const started = Date.now();
    expect(await realService("exec sleep 5", 200).check()).toEqual([{ toolId: "t", installed: false }]);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
