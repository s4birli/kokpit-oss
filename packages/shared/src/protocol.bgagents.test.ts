// İş A — arka plan ajanları (Adım 7): protocol additions.
import { describe, expect, it } from "vitest";
import { BG_AGENT_ID_RE, BgAgentSessionSchema, parseClientMessage, parseServerMessage } from "./protocol.ts";

const req = (method: string, params: unknown) => JSON.stringify({ type: "req", id: 3, method, params });
const ok = (method: string, params: unknown) => parseClientMessage(req(method, params)).ok;

const session = {
  id: "9e3779b1",
  name: "Alfa testleri",
  state: "waiting",
  waitingReason: "approval",
  startedAt: "2026-11-16T10:00:00.000Z",
  cwd: "/Users/ornek/alfa",
  projectId: "alfa",
};

describe("bgAgents protocol", () => {
  it("a session parses with and without project/card/reason", () => {
    expect(BgAgentSessionSchema.parse(session)).toEqual(session);
    const { waitingReason: _r, projectId: _p, ...bare } = session;
    expect(BgAgentSessionSchema.safeParse({ ...bare, state: "running" }).success).toBe(true);
    expect(BgAgentSessionSchema.safeParse({ ...session, cardId: "c1" }).success).toBe(true);
    expect(BgAgentSessionSchema.safeParse({ ...session, state: "blocked" }).success).toBe(false);
    expect(BgAgentSessionSchema.safeParse({ ...session, waitingReason: "x" }).success).toBe(false);
  });

  it("ids are letters, digits and dashes, never option-like", () => {
    for (const id of ["9e3779b1", "abc-DEF-123", "a"]) expect(BG_AGENT_ID_RE.test(id)).toBe(true);
    for (const id of ["", "-rf", "a b", "a;b", "a/b", "$(x)", "a\nb", "ä"]) expect(BG_AGENT_ID_RE.test(id)).toBe(false);
  });

  it("bgAgents.list takes no params", () => {
    expect(ok("bgAgents.list", {})).toBe(true);
    expect(ok("bgAgents.list", { all: true })).toBe(false);
  });

  it("attach / logs / stop validate the id", () => {
    expect(ok("bgAgents.attach", { id: "9e3779b1", cols: 80, rows: 24 })).toBe(true);
    expect(ok("bgAgents.logs", { id: "9e3779b1" })).toBe(true);
    expect(ok("bgAgents.stop", { id: "9e3779b1" })).toBe(true);
    for (const id of ["-x", "a b", "a;rm -rf /", "x".repeat(201), ""]) {
      const r = parseClientMessage(req("bgAgents.stop", { id }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.badRequest?.method).toBe("bgAgents.stop");
    }
    expect(ok("bgAgents.attach", { id: "abc" })).toBe(false);
    expect(ok("bgAgents.logs", { id: "abc", extra: 1 })).toBe(false);
  });

  it("bgAgents.changed event parses", () => {
    const r = parseServerMessage(JSON.stringify({ type: "event", name: "bgAgents.changed" }));
    expect(r.ok).toBe(true);
  });
});
