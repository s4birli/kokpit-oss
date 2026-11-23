// İş C (Adım 8) — Claude envanteri: protocol additions.
import { describe, expect, it } from "vitest";
import { CLAUDE_INVENTORY_LIMITS, ClaudeInventoryItemSchema, parseClientMessage } from "./protocol.ts";

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });

describe("claude envanteri protokolü", () => {
  it("claude.inventory takes exactly one of projectId / cardId", () => {
    expect(parse(req("claude.inventory", { projectId: "p1" })).ok).toBe(true);
    expect(parse(req("claude.inventory", { cardId: "c1" })).ok).toBe(true);
    for (const bad of [{}, { projectId: "p1", cardId: "c1" }, { projectId: "p1", configDir: "/etc" }]) {
      const r = parse(req("claude.inventory", bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.badRequest?.method).toBe("claude.inventory");
    }
  });

  it("claude.inventory.read needs a target and a bounded id", () => {
    expect(parse(req("claude.inventory.read", { projectId: "p1", id: "user:agents/a.md" })).ok).toBe(true);
    // Shape only: the engine re-validates the id (traversal answers INVALID there).
    expect(parse(req("claude.inventory.read", { projectId: "p1", id: "user:../../x.md" })).ok).toBe(true);
    for (const bad of [
      { projectId: "p1" },
      { projectId: "p1", id: "" },
      { projectId: "p1", id: 3 },
      { id: "user:agents/a.md" },
      { projectId: "p1", id: "a".repeat(CLAUDE_INVENTORY_LIMITS.maxIdChars + 1) },
      { projectId: "p1", id: "user:agents/a.md", path: "/etc/passwd" },
    ]) {
      expect(parse(req("claude.inventory.read", bad)).ok).toBe(false);
    }
  });

  it("describes items", () => {
    const item = { kind: "skill", name: "tdd", source: "plugin", path: "~/.claude/plugins/x/skills/tdd/SKILL.md", id: "plugin:x/skills/tdd/SKILL.md" };
    expect(ClaudeInventoryItemSchema.safeParse(item).success).toBe(true);
    expect(ClaudeInventoryItemSchema.safeParse({ ...item, kind: "hook" }).success).toBe(false);
    expect(ClaudeInventoryItemSchema.safeParse({ ...item, source: "system" }).success).toBe(false);
  });
});
