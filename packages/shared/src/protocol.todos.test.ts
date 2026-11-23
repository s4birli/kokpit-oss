import { describe, expect, it } from "vitest";
import {
  isDateKey,
  NOTE_TEXT_MAX,
  parseClientMessage,
  parseServerMessage,
  TODO_TEXT_MAX,
  TodoSchema,
} from "./protocol.ts";

const ok = (m: unknown) => parseClientMessage(JSON.stringify(m)).ok;
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });

describe("yapılacaklar protokolü", () => {
  it("accepts the todo and note requests", () => {
    expect(ok(req("todos.list", {}))).toBe(true);
    expect(ok(req("todos.list", { date: "2026-11-16" }))).toBe(true);
    expect(ok(req("todos.create", { text: "Süt al" }))).toBe(true);
    expect(ok(req("todos.create", { text: "Süt al", projectId: "p1", date: "2026-11-17" }))).toBe(true);
    expect(ok(req("todos.update", { id: "t1", text: "x", done: true, projectId: null, order: 0 }))).toBe(true);
    expect(ok(req("todos.update", { id: "t1", projectId: "p2" }))).toBe(true);
    expect(ok(req("todos.delete", { id: "t1" }))).toBe(true);
    expect(ok(req("notes.get", {}))).toBe(true);
    expect(ok(req("notes.get", { date: "2026-11-16" }))).toBe(true);
    expect(ok(req("notes.set", { text: "" }))).toBe(true);
    expect(ok(req("notes.set", { date: "2026-11-16", text: "not" }))).toBe(true);
  });

  it.each([
    ["todos.list", { date: "2026-13-01" }],
    ["todos.list", { date: "2026-02-30" }],
    ["todos.list", { date: "16.11.2026" }],
    ["todos.list", { extra: 1 }],
    ["todos.create", { text: "   " }],
    ["todos.create", { text: "x".repeat(TODO_TEXT_MAX + 1) }],
    ["todos.create", { text: 5 }],
    ["todos.create", {}],
    ["todos.update", { text: "x" }],
    ["todos.update", { id: "t", order: -1 }],
    ["todos.update", { id: "t", order: 1.5 }],
    ["todos.update", { id: "t", done: "yes" }],
    ["todos.update", { id: "t", text: "" }],
    ["todos.delete", {}],
    ["notes.set", { date: "2026-11-16" }],
    ["notes.set", { text: "x".repeat(NOTE_TEXT_MAX + 1) }],
    ["notes.get", { date: "" }],
  ])("rejects %s %j", (method, params) => {
    expect(ok(req(method, params))).toBe(false);
  });

  it("validates calendar dates", () => {
    expect(isDateKey("2024-02-29")).toBe(true);
    expect(isDateKey("2026-02-29")).toBe(false);
    expect(isDateKey("2026-11-16")).toBe(true);
    expect(isDateKey("2026-11-16T00:00")).toBe(false);
    expect(isDateKey("0000-00-00")).toBe(false);
  });

  it("parses todo records", () => {
    const todo = {
      id: "t1",
      text: "x",
      done: true,
      date: "2026-11-16",
      order: 0,
      createdAt: "2026-11-16T08:00:00.000Z",
      doneAt: "2026-11-16T09:00:00.000Z",
      rolledFrom: "2026-11-15",
      projectId: "p1",
    };
    expect(TodoSchema.safeParse(todo).success).toBe(true);
    expect(TodoSchema.safeParse({ ...todo, date: "dün" }).success).toBe(false);
  });

  it("accepts the todos.changed and notes.changed events", () => {
    expect(parseServerMessage(JSON.stringify({ type: "event", name: "todos.changed" })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ type: "event", name: "notes.changed", date: "2026-11-16" })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ type: "event", name: "notes.changed" })).ok).toBe(false);
  });
});
