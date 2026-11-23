// Claude kullanımı — protocol additions: claudeUsage.get / claudeUsage.probe, the result shapes, the change event.
import { describe, expect, it } from "vitest";
import {
  ClaudePlanWindowSchema,
  ClaudeUsageAccountSchema,
  ClaudeUsageProjectSchema,
  ClaudeUsageResultSchema,
  ClaudeUsageTotalsSchema,
  parseClientMessage,
  parseServerMessage,
} from "./protocol.ts";

const req = (method: string, params: unknown) => JSON.stringify({ type: "req", id: 1, method, params });
const ok = (method: string, params: unknown) => parseClientMessage(req(method, params)).ok;

const totals = { messages: 3, input: 10, output: 20, cacheWrite: 30, cacheRead: 40 };
const window = { totals, byModel: [{ family: "opus", ...totals }], topProjects: [{ projectId: "p1", name: "Alfa", ...totals }] };
const account = {
  accountId: "work",
  name: "Work",
  windows: { session: window, today: window, week: window },
  indexing: false,
};
const result = { accounts: [account], sessionWindowHours: 5, longWindowDays: 7, refreshIntervalMs: 60000, probeAvailable: true };

describe("claudeUsage protocol", () => {
  it("get takes an optional account and refresh flag; probe needs an account and an explicit confirm", () => {
    expect(ok("claudeUsage.get", {})).toBe(true);
    expect(ok("claudeUsage.get", { accountId: "work" })).toBe(true);
    expect(ok("claudeUsage.get", { refresh: true })).toBe(true);
    expect(ok("claudeUsage.get", { accountId: "" })).toBe(false);
    expect(ok("claudeUsage.get", { configDir: "/x" })).toBe(false);
    expect(ok("claudeUsage.probe", { accountId: "work", confirm: true })).toBe(true);
    expect(ok("claudeUsage.probe", { accountId: "work" })).toBe(false);
    expect(ok("claudeUsage.probe", { accountId: "work", confirm: false })).toBe(false);
    expect(ok("claudeUsage.probe", { confirm: true })).toBe(false);
  });

  it("totals are non-negative integers and nothing else", () => {
    expect(ClaudeUsageTotalsSchema.parse(totals)).toEqual(totals);
    expect(ClaudeUsageTotalsSchema.safeParse({ ...totals, input: -1 }).success).toBe(false);
    expect(ClaudeUsageTotalsSchema.safeParse({ ...totals, input: 1.5 }).success).toBe(false);
    expect(ClaudeUsageTotalsSchema.safeParse({ ...totals, text: "merhaba" }).success).toBe(false);
  });

  it("a project row carries a folder NAME, never a path", () => {
    expect(ClaudeUsageProjectSchema.safeParse({ name: "kokpit", ...totals }).success).toBe(true);
    expect(ClaudeUsageProjectSchema.safeParse({ name: "/Users/x/kokpit", ...totals }).success).toBe(false);
    expect(ClaudeUsageProjectSchema.safeParse({ name: "a/b", ...totals }).success).toBe(false);
    expect(ClaudeUsageProjectSchema.safeParse({ name: "kokpit", cwd: "/Users/x/kokpit", ...totals }).success).toBe(false);
  });

  it("a plan window has a percentage, a reset time, when it was captured and by which source", () => {
    const w = { usedPercent: 23.5, resetsAt: "2026-11-18T12:00:00.000Z", capturedAt: "2026-11-18T09:00:00.000Z", source: "statusline" };
    expect(ClaudePlanWindowSchema.parse(w)).toEqual(w);
    expect(ClaudePlanWindowSchema.safeParse({ ...w, source: "probe" }).success).toBe(true);
    expect(ClaudePlanWindowSchema.safeParse({ ...w, source: "credentials" }).success).toBe(false);
    expect(ClaudePlanWindowSchema.safeParse({ ...w, usedPercent: -1 }).success).toBe(false);
    expect(ClaudePlanWindowSchema.safeParse({ ...w, token: "x" }).success).toBe(false);
  });

  it("an account result is strict: unknown keys (text, paths, titles) are refused", () => {
    expect(ClaudeUsageAccountSchema.parse(account)).toEqual(account);
    const full = {
      ...account,
      isDefault: true,
      plan: { sevenDay: { usedPercent: 59, resetsAt: "2026-11-19T00:00:00.000Z", capturedAt: "2026-11-18T09:00:00.000Z", source: "probe" } },
      updatedAt: "2026-11-18T09:00:00.000Z",
      partial: true,
      error: "Oturum kayıtları okunamadı.",
    };
    expect(ClaudeUsageAccountSchema.parse(full)).toEqual(full);
    expect(ClaudeUsageAccountSchema.safeParse({ ...account, configDir: "/Users/x/.claude" }).success).toBe(false);
    expect(ClaudeUsageAccountSchema.safeParse({ ...account, sessions: ["başlık"] }).success).toBe(false);
    expect(ClaudeUsageAccountSchema.safeParse({ ...account, windows: { session: window, today: window } }).success).toBe(false);
  });

  it("the result names its windows and refresh interval; cost only with a dated price table", () => {
    expect(ClaudeUsageResultSchema.parse(result)).toEqual(result);
    const priced = { ...result, pricesAsOf: "2026-11-01", accounts: [{ ...account, windows: { ...account.windows, week: { ...window, estimatedCostUsd: 1.25 } } }] };
    expect(ClaudeUsageResultSchema.parse(priced)).toEqual(priced);
    expect(ClaudeUsageResultSchema.safeParse({ ...result, refreshIntervalMs: 0 }).success).toBe(false);
  });

  it("claudeUsage.changed is a server event", () => {
    expect(parseServerMessage(JSON.stringify({ type: "event", name: "claudeUsage.changed" })).ok).toBe(true);
  });
});
