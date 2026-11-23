// İş A — waiting patterns on tools: defaults, CRUD, and seeding them into stores seeded earlier.
import type { Tool } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../test/fakes/memory-store.ts";
import type { EngineConfig, Logger } from "./contracts.ts";
import { createToolService, loadToolDefaults, TOOL_DEFAULTS_PATH, type ToolServiceDeps } from "./tools.ts";

const silentLogger: Logger = { info() {}, warn() {}, error() {} };
const config = { shell: "/bin/sh" } as EngineConfig;

const DEFAULTS: Tool[] = [
  { id: "a", name: "A", command: "a", waitingPatterns: ["A waits\\?"] },
  { id: "b", name: "B", command: "b" },
];

function service(store: MemoryStore, defaults = DEFAULTS, over: Partial<ToolServiceDeps> = {}) {
  return createToolService({
    config,
    store,
    logger: silentLogger,
    projectsUsingTool: () => 0,
    isGlobalDefault: () => false,
    defaults,
    checkTimeoutMs: 100,
    idMaxLen: 20,
    idFallback: "arac",
    ...over,
  });
}

describe("waiting patterns in tools.defaults.json", () => {
  const d = loadToolDefaults(TOOL_DEFAULTS_PATH);
  const byId = Object.fromEntries(d.tools.map((t) => [t.id, t]));
  const matches = (toolId: string, line: string) =>
    (byId[toolId]?.waitingPatterns ?? []).some((p) => new RegExp(p).test(line));

  it("Claude variants recognise Claude Code's permission and trust prompts", () => {
    for (const id of ["claude", "claude-skip", "claude-agents-skip"]) {
      expect(matches(id, "Do you want to proceed?")).toBe(true);
      expect(matches(id, "Do you want to make this edit to server.ts?")).toBe(true);
      expect(matches(id, " ❯ 1. Yes")).toBe(true);
      expect(matches(id, "  3. No, and tell Claude what to do differently (esc)")).toBe(true);
      expect(matches(id, " ❯ 1. Yes, I trust this folder")).toBe(true);
      expect(matches(id, "Reading files…")).toBe(false);
    }
  });

  it("every builtin tool that runs claude has exactly the Claude patterns", () => {
    const claudeTools = d.tools.filter((t) => /^claude(\s|$)/.test(t.command));
    for (const t of claudeTools) expect(t.waitingPatterns, t.id).toEqual(byId.claude?.waitingPatterns);
  });


  it("Codex recognises its approval prompts", () => {
    expect(matches("codex", "Would you like to run the following command?")).toBe(true);
    expect(matches("codex", "Would you like to make the following edits?")).toBe(true);
    expect(matches("codex", "› 1. Yes, proceed (y)")).toBe(true);
    expect(matches("codex", "  3. No, and tell Codex what to do differently (esc)")).toBe(true);
    expect(matches("codex", "Working (12s • esc to interrupt)")).toBe(false);
  });

  it("ships a generic list for terminals without a tool (y/n, password, press enter)", () => {
    const generic = d.genericWaitingPatterns.map((p) => new RegExp(p));
    const hit = (line: string) => generic.some((re) => re.test(line));
    expect(hit("Overwrite? [y/N] ")).toBe(true);
    expect(hit("Proceed (y/n)? ")).toBe(true);
    expect(hit("Are you sure you want to continue connecting (yes/no/[fingerprint])? ")).toBe(true);
    expect(hit("Password:")).toBe(true);
    expect(hit("[sudo] password for me: ")).toBe(true);
    expect(hit("Press Enter to continue")).toBe(true);
    expect(hit("total 42")).toBe(false);
  });

  it("every shipped pattern compiles", () => {
    for (const p of [...d.genericWaitingPatterns, ...d.tools.flatMap((t) => t.waitingPatterns ?? [])]) {
      expect(() => new RegExp(p)).not.toThrow();
    }
  });
});

describe("ToolService waiting patterns", () => {
  it("create keeps waitingPatterns; update sets, replaces and (null) clears them", () => {
    const s = service(new MemoryStore());
    const t = s.create({ name: "X", command: "x", waitingPatterns: ["X\\?"] });
    expect(t.waitingPatterns).toEqual(["X\\?"]);
    expect(s.update({ toolId: t.id, waitingPatterns: ["Y"] }).waitingPatterns).toEqual(["Y"]);
    expect(s.update({ toolId: t.id }).waitingPatterns).toEqual(["Y"]);
    expect(s.update({ toolId: t.id, waitingPatterns: [] }).waitingPatterns).toEqual([]);
    expect("waitingPatterns" in s.update({ toolId: t.id, waitingPatterns: null })).toBe(false);
  });

  it("fresh seed copies the patterns", () => {
    const store = new MemoryStore();
    service(store).init();
    expect(store.getTool("a")?.waitingPatterns).toEqual(["A waits\\?"]);
  });

  it("a store seeded before İş A gets the default patterns on builtin tools that lack them, once", () => {
    const store = new MemoryStore();
    store.upsertTool({ id: "a", name: "A", command: "a --mine", builtin: true });
    store.markSeeded("default-tools");
    store.markSeeded("default-tools-2");
    service(store).init();
    expect(store.getTool("a")).toEqual({ id: "a", name: "A", command: "a --mine", builtin: true, waitingPatterns: ["A waits\\?"] });
    expect(store.getTool("b")).toBeUndefined();
    // Once applied, a user who cleared the patterns keeps them cleared.
    service(store).update({ toolId: "a", waitingPatterns: null });
    service(store).init();
    expect(store.getTool("a")?.waitingPatterns).toBeUndefined();
  });

  it("never touches patterns the user already set or tools that are not builtin", () => {
    const store = new MemoryStore();
    store.upsertTool({ id: "a", name: "A", command: "a", builtin: true, waitingPatterns: ["mine"] });
    store.upsertTool({ id: "b", name: "B", command: "b" });
    store.markSeeded("default-tools");
    store.markSeeded("default-tools-2");
    service(store, [...DEFAULTS.slice(0, 1), { ...DEFAULTS[1]!, waitingPatterns: ["B"] }]).init();
    expect(store.getTool("a")?.waitingPatterns).toEqual(["mine"]);
    expect(store.getTool("b")?.waitingPatterns).toBeUndefined();
  });

  it("a later waiting-pattern step fills in only its own builtin tools, once, and only when they have none", () => {
    const store = new MemoryStore();
    const defaults: Tool[] = [DEFAULTS[0]!, { ...DEFAULTS[1]!, waitingPatterns: ["B waits"] }, { id: "c", name: "C", command: "c", waitingPatterns: ["C"] }];
    const steps = [{ key: "wp-2", toolIds: ["b", "c"] }];
    // Seeded before b had patterns; the user cleared a's patterns after the first backfill and set c's own.
    store.upsertTool({ id: "a", name: "A", command: "a", builtin: true });
    store.upsertTool({ id: "b", name: "B", command: "b --mine", builtin: true });
    store.upsertTool({ id: "c", name: "C", command: "c", builtin: true, waitingPatterns: [] });
    for (const k of ["default-tools", "default-tools-2", "default-tools-waiting-patterns"]) store.markSeeded(k);
    service(store, defaults, { waitingPatternSteps: steps }).init();
    expect(store.getTool("a")?.waitingPatterns).toBeUndefined();
    expect(store.getTool("b")).toEqual({ id: "b", name: "B", command: "b --mine", builtin: true, waitingPatterns: ["B waits"] });
    expect(store.getTool("c")?.waitingPatterns).toEqual([]);
    expect(store.isSeeded("wp-2")).toBe(true);
    service(store).update({ toolId: "b", waitingPatterns: null });
    service(store, defaults, { waitingPatternSteps: steps }).init();
    expect(store.getTool("b")?.waitingPatterns).toBeUndefined();
  });
});
