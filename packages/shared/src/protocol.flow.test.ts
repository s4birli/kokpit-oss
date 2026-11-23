// İş W — Akış: protocol additions.
import { describe, expect, it } from "vitest";
import { FLOW_LIMITS, FlowEntrySchema, FlowInfoSchema, isFlowId, parseClientMessage } from "./protocol.ts";

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));
const ok = (m: unknown) => parse(m).ok;
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });

describe("akış protokolü", () => {
  it.each(["flow.info", "flow.list"])("%s takes exactly one of projectId / cardId", (method) => {
    expect(ok(req(method, { projectId: "p1" }))).toBe(true);
    expect(ok(req(method, { cardId: "c1" }))).toBe(true);
    expect(ok(req(method, {}))).toBe(false);
    expect(ok(req(method, { projectId: "p1", cardId: "c1" }))).toBe(false);
    expect(ok(req(method, { projectId: "p1", dir: "/etc" }))).toBe(false);
  });

  it("flow.read takes a target and a flow id", () => {
    expect(ok(req("flow.read", { projectId: "p1", id: "giris.mmd" }))).toBe(true);
    expect(ok(req("flow.read", { cardId: "c1", id: "a-b_c.1.mmd" }))).toBe(true);
  });

  it.each([
    ["missing id", { projectId: "p1" }],
    ["traversal", { projectId: "p1", id: "../x.mmd" }],
    ["subfolder", { projectId: "p1", id: "a/x.mmd" }],
    ["backslash", { projectId: "p1", id: "a\\x.mmd" }],
    ["not .mmd", { projectId: "p1", id: "x.md" }],
    ["absolute", { projectId: "p1", id: "/etc/x.mmd" }],
    ["hidden", { projectId: "p1", id: ".x.mmd" }],
    ["bare extension", { projectId: "p1", id: ".mmd" }],
    ["NUL", { projectId: "p1", id: "a\0.mmd" }],
    ["overlong", { projectId: "p1", id: `${"a".repeat(FLOW_LIMITS.maxIdChars)}.mmd` }],
    ["no target", { id: "x.mmd" }],
  ])("flow.read rejects %s", (_n, params) => {
    const r = parse(req("flow.read", params));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.badRequest?.method).toBe("flow.read");
  });

  it("isFlowId accepts plain .mmd names only", () => {
    expect(isFlowId("giris-akisi.mmd")).toBe(true);
    expect(isFlowId("Ödeme akışı.mmd")).toBe(true);
    expect(isFlowId("x.MMD")).toBe(false);
    expect(isFlowId("..mmd")).toBe(false);
    expect(isFlowId("x.mmd/")).toBe(false);
  });

  it("describes entries and info", () => {
    expect(FlowEntrySchema.safeParse({ id: "a.mmd", file: "docs/akis/a.mmd", modifiedAt: "2026-11-16T10:00:00.000Z" }).success).toBe(true);
    expect(FlowEntrySchema.safeParse({ id: "a.mmd", file: "docs/akis/a.mmd", title: "Giriş", modifiedAt: "x" }).success).toBe(true);
    expect(FlowEntrySchema.safeParse({ id: "a.mmd" }).success).toBe(false);
    expect(FlowInfoSchema.safeParse({ available: false }).success).toBe(true);
    expect(FlowInfoSchema.safeParse({ available: true, dir: "docs/akis", updateCommand: "claude" }).success).toBe(true);
  });
});
