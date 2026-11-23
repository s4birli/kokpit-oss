// Todos and day notes in the StateStore (Adım 6): stored in the v2 file, absent → empty.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Todo } from "@kokpit/shared";
import { EngineError, type Logger, type TodoStore } from "./contracts.ts";
import { createFileStore, createMemoryStore } from "./store.ts";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const todo = (id: string, extra: Partial<Todo> = {}): Todo => ({
  id,
  text: `iş ${id}`,
  done: false,
  date: "2026-11-16",
  order: 0,
  createdAt: "2026-11-16T08:00:00.000Z",
  ...extra,
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-store-todos-"));
  file = join(dir, "state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const variants: [string, () => TodoStore][] = [
  ["file", () => createFileStore(file, logger)],
  ["memory", () => createMemoryStore()],
];

describe.each(variants)("todo store (%s)", (_name, make) => {
  it("starts empty", () => {
    const s = make();
    expect(s.listTodos()).toEqual([]);
    expect(s.getNotes()).toEqual({});
  });

  it("replaces todos atomically and returns copies", () => {
    const s = make();
    s.replaceTodos([todo("a"), todo("b", { order: 1, projectId: "p1" })]);
    const list = s.listTodos();
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
    list[0]!.text = "değişti";
    expect(s.listTodos()[0]!.text).toBe("iş a");
  });

  it("rejects invalid todos and duplicate ids, leaving state unchanged", () => {
    const s = make();
    s.replaceTodos([todo("a")]);
    expect(() => s.replaceTodos([todo("x", { date: "2026-02-30" })])).toThrow(EngineError);
    expect(() => s.replaceTodos([todo("x"), todo("x")])).toThrow(EngineError);
    expect(s.listTodos().map((t) => t.id)).toEqual(["a"]);
  });

  it("sets and removes day notes", () => {
    const s = make();
    s.setNote("2026-11-16", "not");
    s.setNote("2026-11-17", "yarın");
    expect(s.getNotes()).toEqual({ "2026-11-16": "not", "2026-11-17": "yarın" });
    s.setNote("2026-11-16", "");
    expect(s.getNotes()).toEqual({ "2026-11-17": "yarın" });
    expect(() => s.setNote("16.11.2026", "x")).toThrow(EngineError);
  });
});

describe("todo store on disk", () => {
  it("survives reopening", () => {
    const a = createFileStore(file, logger);
    a.replaceTodos([todo("a", { done: true, doneAt: "2026-11-16T09:00:00.000Z", rolledFrom: "2026-11-15" })]);
    a.setNote("2026-11-16", "kalıcı not");
    const b = createFileStore(file, logger);
    expect(b.listTodos()).toEqual([todo("a", { done: true, doneAt: "2026-11-16T09:00:00.000Z", rolledFrom: "2026-11-15" })]);
    expect(b.getNotes()).toEqual({ "2026-11-16": "kalıcı not" });
    const disk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(disk.version).toBe(2);
    expect(disk.notes).toEqual({ "2026-11-16": "kalıcı not" });
  });

  it("reads an older v2 file without todos or notes, and keeps other records", () => {
    writeFileSync(
      file,
      JSON.stringify({ version: 2, projects: [], sshHosts: [], tools: [], cards: [], terminals: [], seeded: ["x"] }),
    );
    const s = createFileStore(file, logger);
    expect(s.listTodos()).toEqual([]);
    expect(s.getNotes()).toEqual({});
    expect(s.isSeeded("x")).toBe(true);
  });

  it("does not write empty todo fields, so files without todos stay as they were", () => {
    const s = createFileStore(file, logger);
    s.markSeeded("k");
    const disk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect("todos" in disk).toBe(false);
    expect("notes" in disk).toBe(false);
  });
});
