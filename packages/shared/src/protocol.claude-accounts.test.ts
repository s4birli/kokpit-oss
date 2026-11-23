// İş H (Adım 8) — Claude hesapları: protocol additions.
import { describe, expect, it } from "vitest";
import { BgAgentSessionSchema, ClaudeAccountSchema, ProjectSchema, parseClientMessage, parseServerMessage } from "./protocol.ts";

const req = (method: string, params: unknown) => JSON.stringify({ type: "req", id: 1, method, params });
const ok = (method: string, params: unknown) => parseClientMessage(req(method, params)).ok;

describe("claudeAccounts protocol", () => {
  it("an account has id, name, absolute configDir and an optional default flag", () => {
    const a = { id: "work", name: "Work", configDir: "/Users/x/.claude-work" };
    expect(ClaudeAccountSchema.parse(a)).toEqual(a);
    expect(ClaudeAccountSchema.safeParse({ ...a, isDefault: true }).success).toBe(true);
    expect(ClaudeAccountSchema.safeParse({ ...a, configDir: "rel/dir" }).success).toBe(false);
    expect(ClaudeAccountSchema.safeParse({ ...a, name: "" }).success).toBe(false);
  });

  it("list / create / update / delete / login / shareSkills validate their params", () => {
    expect(ok("claudeAccounts.list", {})).toBe(true);
    expect(ok("claudeAccounts.list", { x: 1 })).toBe(false);
    expect(ok("claudeAccounts.create", { name: "Work", configDir: "/Users/x/.claude-work" })).toBe(true);
    expect(ok("claudeAccounts.create", { name: "Work", configDir: "~/.claude-work" })).toBe(true);
    expect(ok("claudeAccounts.create", { name: "Work", configDir: "relative" })).toBe(false);
    expect(ok("claudeAccounts.create", { name: " ", configDir: "/a" })).toBe(false);
    expect(ok("claudeAccounts.create", { name: "K", configDir: "/a", isDefault: true })).toBe(false);
    expect(ok("claudeAccounts.update", { id: "work", name: "K" })).toBe(true);
    expect(ok("claudeAccounts.update", { id: "work", configDir: "/b" })).toBe(true);
    expect(ok("claudeAccounts.update", { name: "K" })).toBe(false);
    expect(ok("claudeAccounts.delete", { id: "work" })).toBe(true);
    expect(ok("claudeAccounts.login", { id: "work", cols: 80, rows: 24 })).toBe(true);
    expect(ok("claudeAccounts.login", { id: "work" })).toBe(false);
    expect(ok("claudeAccounts.shareSkills", { id: "work", confirm: true })).toBe(true);
    expect(ok("claudeAccounts.shareSkills", { id: "work", confirm: false })).toBe(false);
    expect(ok("claudeAccounts.shareSkills", { id: "work" })).toBe(false);
  });

  it("projects carry an optional account; update can set or clear it", () => {
    const p = { id: "p", name: "P", location: { kind: "local", path: "/x" }, claudeAccountId: "work" };
    expect(ProjectSchema.parse(p)).toEqual(p);
    expect(ok("projects.update", { projectId: "p", claudeAccountId: "work" })).toBe(true);
    expect(ok("projects.update", { projectId: "p", claudeAccountId: null })).toBe(true);
    expect(ok("projects.update", { projectId: "p", claudeAccountId: "" })).toBe(false);
    expect(ok("projects.create", { name: "P", location: { kind: "local", path: "/x" }, claudeAccountId: "work" })).toBe(true);
  });

  it("background sessions may carry their account id", () => {
    const s = { id: "a1", name: "n", state: "running", cwd: "/x", accountId: "work" };
    expect(BgAgentSessionSchema.parse(s)).toEqual(s);
  });

  it("claudeAccounts.changed is a server event", () => {
    expect(parseServerMessage(JSON.stringify({ type: "event", name: "claudeAccounts.changed" })).ok).toBe(true);
  });
});
