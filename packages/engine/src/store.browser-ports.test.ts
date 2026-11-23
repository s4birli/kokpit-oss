// Adım 9 İş A: each project's DevTools port and what the engine wrote into its Claude settings file live in the
// v2 state file; both fields are absent in older files (and whenever empty).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError, type Logger } from "./contracts.ts";
import { createFileStore, createMemoryStore } from "./store.ts";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-store-ports-"));
  file = join(dir, "state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.each([
  ["file", () => createFileStore(file, logger)],
  ["memory", () => createMemoryStore()],
] as const)("browser ports (%s)", (_n, make) => {
  it("starts empty, keeps one port per project, undefined forgets", () => {
    const s = make();
    expect(s.getBrowserPort("p1")).toBeUndefined();
    expect(s.listBrowserPorts()).toEqual({});
    s.setBrowserPort("p1", 39201);
    s.setBrowserPort("p2", 39202);
    s.setBrowserPort("p1", 39300);
    expect(s.getBrowserPort("p1")).toBe(39300);
    expect(s.listBrowserPorts()).toEqual({ p1: 39300, p2: 39202 });
    s.setBrowserPort("p1", undefined);
    expect(s.listBrowserPorts()).toEqual({ p2: 39202 });
  });

  it("refuses ports outside 1024–65535 and non-integers", () => {
    const s = make();
    for (const bad of [0, 80, 65536, 39200.5, Number.NaN]) expect(() => s.setBrowserPort("p1", bad)).toThrow(EngineError);
    expect(s.listBrowserPorts()).toEqual({});
  });
});

describe.each([
  ["file", () => createFileStore(file, logger)],
  ["memory", () => createMemoryStore()],
] as const)("managed Claude settings (%s)", (_n, make) => {
  const rec = { file: "/repos/a/.claude/settings.local.json", env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:39201" }, createdFile: true };

  it("keeps one record per project, returns copies, undefined forgets", () => {
    const s = make();
    expect(s.getManagedClaudeSettings("p1")).toBeUndefined();
    s.setManagedClaudeSettings("p1", rec);
    const got = s.getManagedClaudeSettings("p1")!;
    expect(got).toEqual(rec);
    got.env.EVIL = "x";
    expect(s.getManagedClaudeSettings("p1")).toEqual(rec);
    expect(s.listManagedClaudeSettings()).toEqual({ p1: rec });
    s.setManagedClaudeSettings("p1", undefined);
    expect(s.listManagedClaudeSettings()).toEqual({});
  });

  it("refuses a relative file or a non-string value", () => {
    const s = make();
    expect(() => s.setManagedClaudeSettings("p1", { ...rec, file: "rel/settings.json" })).toThrow(EngineError);
    expect(() => s.setManagedClaudeSettings("p1", { ...rec, env: { A: 1 as unknown as string } })).toThrow(EngineError);
  });
});

describe("on disk", () => {
  it("both survive a reopen; a state file without them (older engine) loads and keeps its shape", () => {
    writeFileSync(file, JSON.stringify({ version: 2, projects: [], sshHosts: [], tools: [], cards: [], terminals: [], seeded: ["x"] }));
    const s = createFileStore(file, logger);
    expect(s.isSeeded("x")).toBe(true);
    expect(s.listBrowserPorts()).toEqual({});
    s.markSeeded("y");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw).not.toHaveProperty("browserPorts");
    expect(raw).not.toHaveProperty("claudeBrowserSettings");

    s.setBrowserPort("p1", 39201);
    s.setManagedClaudeSettings("p1", { file: "/a/.claude/settings.local.json", env: { K: "v" } });
    const again = createFileStore(file, logger);
    expect(again.getBrowserPort("p1")).toBe(39201);
    expect(again.getManagedClaudeSettings("p1")).toEqual({ file: "/a/.claude/settings.local.json", env: { K: "v" } });
  });
});
