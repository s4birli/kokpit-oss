// Claude kullanımı — formatting and the account tooltip.
import type { ClaudeUsageAccount, ClaudeUsageResult, ClaudeUsageWindow } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import { accountUsage, formatPercent, formatTokens, formatUsd, totalTokens, usageTooltip, windowLabels } from "./claude-usage.ts";

const TR = "tr-TR";
const win = (messages: number, input: number, output: number, cacheWrite: number, cacheRead: number): ClaudeUsageWindow => ({
  totals: { messages, input, output, cacheWrite, cacheRead },
  byModel: [],
  topProjects: [],
});
const account = (extra: Partial<ClaudeUsageAccount> = {}): ClaudeUsageAccount => ({
  accountId: "work",
  name: "Work",
  windows: { session: win(12, 200_000, 300_000, 200_000, 500_000), today: win(40, 1, 1, 1, 3_399_997), week: win(900, 0, 0, 0, 30_000_000) },
  indexing: false,
  ...extra,
});
const result = (accounts: ClaudeUsageAccount[]): ClaudeUsageResult => ({ accounts, sessionWindowHours: 5, longWindowDays: 7, refreshIntervalMs: 60_000, probeAvailable: true });

describe("formatting", () => {
  it("formats token counts compactly in Turkish", () => {
    expect(formatTokens(0, TR)).toBe("0");
    expect(formatTokens(999, TR)).toBe("999");
    expect(formatTokens(1500, TR)).toBe("1,5 B");
    expect(formatTokens(1_234_567, TR)).toBe("1,2 Mn");
    expect(formatTokens(2_500_000_000, TR)).toBe("2,5 Mr");
  });

  it("formats percentages and the estimated cost", () => {
    expect(formatPercent(23.5, TR)).toBe("%24");
    expect(formatPercent(0, TR)).toBe("%0");
    expect(formatUsd(12.345, TR)).toBe("$12,35");
  });

  it("totalTokens adds the four kinds", () => {
    expect(totalTokens({ messages: 9, input: 1, output: 2, cacheWrite: 3, cacheRead: 4 })).toBe(10);
  });

  it("window labels follow the engine's window lengths", () => {
    expect(windowLabels({ sessionWindowHours: 5, longWindowDays: 7 })).toEqual({ session: "Son 5 saat", today: "Bugün", week: "Son 7 gün" });
    expect(windowLabels({ sessionWindowHours: 1, longWindowDays: 14 })).toEqual({ session: "Son 1 saat", today: "Bugün", week: "Son 14 gün" });
  });
});

describe("usageTooltip", () => {
  it("names the three windows and says whose count it is", () => {
    const r = result([account()]);
    const tip = usageTooltip(accountUsage(r, "work"), r, TR)!;
    expect(tip).toContain("Son 5 saat: 1,2 Mn token");
    expect(tip).toContain("Bugün: 3,4 Mn");
    expect(tip).toContain("Son 7 gün: 30 Mn");
    expect(tip).toContain("Kokpit'in bu Mac'teki sayımı");
    expect(tip).not.toContain("Kota");
  });

  it("adds Claude's own quota figures when a source gave them", () => {
    const plan = {
      fiveHour: { usedPercent: 23.5, resetsAt: "2026-11-18T14:00:00.000Z", capturedAt: "2026-11-18T12:00:00.000Z", source: "statusline" as const },
      sevenDay: { usedPercent: 59, resetsAt: "2026-11-19T00:00:00.000Z", capturedAt: "2026-11-18T12:00:00.000Z", source: "probe" as const },
    };
    const r = result([account({ plan })]);
    expect(usageTooltip(accountUsage(r, "work"), r, TR)).toContain("Claude kotası: 5 saatlik %24 · haftalık %59");
    const weekOnly = result([account({ plan: { sevenDay: plan.sevenDay } })]);
    expect(usageTooltip(accountUsage(weekOnly, "work"), weekOnly, TR)).toContain("Claude kotası: haftalık %59");
  });

  it("is undefined without data or for an unknown account; says so while the first pass runs", () => {
    expect(usageTooltip(undefined, undefined, TR)).toBeUndefined();
    const r = result([account()]);
    expect(accountUsage(r, "yok")).toBeUndefined();
    expect(accountUsage(undefined, "work")).toBeUndefined();
    const first = result([account({ indexing: true })]);
    expect(usageTooltip(accountUsage(first, "work"), first, TR)).toContain("okunuyor");
    const failed = result([account({ error: "Oturum kayıtları okunamadı." })]);
    expect(usageTooltip(accountUsage(failed, "work"), failed, TR)).toContain("Oturum kayıtları okunamadı.");
  });
});
