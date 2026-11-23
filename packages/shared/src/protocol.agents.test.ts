// İş A — ajan özeti: protocol additions.
import { describe, expect, it } from "vitest";
import {
  parseClientMessage,
  parseServerMessage,
  TerminalActivitySchema,
  TerminalInfoSchema,
  ToolSchema,
  WaitingPatternsSchema,
} from "./protocol.ts";

const req = (method: string, params: unknown) => JSON.stringify({ type: "req", id: 7, method, params });
const ok = (method: string, params: unknown) => parseClientMessage(req(method, params)).ok;

describe("agents protocol", () => {
  it("TerminalInfo carries an optional activity", () => {
    const base = { id: "t", projectId: "p", title: "sh", status: "running", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(TerminalInfoSchema.safeParse(base).success).toBe(true);
    const activity = { state: "waiting", since: "2026-01-01T00:00:01.000Z", summary: "Do you want to proceed?" };
    expect(TerminalInfoSchema.parse({ ...base, activity }).activity).toEqual(activity);
    expect(TerminalInfoSchema.safeParse({ ...base, activity: { state: "busy", since: "x" } }).success).toBe(false);
  });

  it("activity states are exactly running, waiting, idle, exited", () => {
    for (const state of ["running", "waiting", "idle", "exited"]) {
      expect(TerminalActivitySchema.safeParse({ state, since: "2026-01-01T00:00:00.000Z" }).success).toBe(true);
    }
    expect(TerminalActivitySchema.safeParse({ state: "unknown", since: "2026-01-01T00:00:00.000Z" }).success).toBe(false);
  });

  it("agents.summary takes no params", () => {
    expect(ok("agents.summary", {})).toBe(true);
    const bad = parseClientMessage(req("agents.summary", { projectId: "p" }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.badRequest?.method).toBe("agents.summary");
  });

  it("terminal.activity event parses, with and without cardId", () => {
    const activity = { state: "running", since: "2026-01-01T00:00:00.000Z" };
    const ev = { type: "event", name: "terminal.activity", terminalId: "t", projectId: "p", activity };
    expect(parseServerMessage(JSON.stringify(ev)).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ ...ev, cardId: "c" })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ ...ev, activity: { state: "nope", since: "x" } })).ok).toBe(false);
  });

  it("tools accept optional, valid waitingPatterns on create and update; null clears", () => {
    const tool = { name: "Claude", command: "claude" };
    expect(ok("tools.create", tool)).toBe(true);
    expect(ok("tools.create", { ...tool, waitingPatterns: ["Do you want to proceed\\?", "❯ *1\\. *Yes"] })).toBe(true);
    expect(ok("tools.update", { toolId: "claude", waitingPatterns: null })).toBe(true);
    expect(ok("tools.update", { toolId: "claude", waitingPatterns: [] })).toBe(true);
    expect(ToolSchema.parse({ id: "x", name: "x", command: "x", waitingPatterns: ["a"] }).waitingPatterns).toEqual(["a"]);
  });

  it.each([
    ["an invalid regex", ["(unclosed"]],
    ["an empty pattern", [""]],
    ["a too long pattern", ["a".repeat(501)]],
    ["too many patterns", Array.from({ length: 51 }, (_, i) => `p${i}`)],
    ["a non-string", [42]],
  ])("rejects %s", (_label, waitingPatterns) => {
    expect(WaitingPatternsSchema.safeParse(waitingPatterns).success).toBe(false);
    const r = parseClientMessage(req("tools.create", { name: "x", command: "x", waitingPatterns }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.badRequest).toBeTruthy();
  });
});
