// Claude kullanımı — shared helpers of the usage block (Ayarlar › Claude hesapları, Claude paneli › Kullanım) and
// of the account badge's tooltip on a project tab. Numbers come from the engine (`claudeUsage.get`); here they are
// only formatted.
import type { ClaudePlanWindow, ClaudeUsageAccount, ClaudeUsageResult, ClaudeUsageTotals } from "@kokpit/shared";
import { intlLocale, t, type MessageKey } from "../../i18n/index.ts";
import type { EngineClient } from "../engine/types.ts";

export const fetchClaudeUsage = async (c: EngineClient): Promise<ClaudeUsageResult> => c.request("claudeUsage.get", {});
/** New numbers, or another set of accounts. */
export const CLAUDE_USAGE_EVENTS = ["claudeUsage.changed", "claudeAccounts.changed"] as const;

export type UsageWindowId = keyof ClaudeUsageAccount["windows"];
export const USAGE_WINDOWS: readonly UsageWindowId[] = ["session", "today", "week"];

/** What the numbers are — shown wherever they are. */
export const usageSourceNote = (): string => t("usage.sourceNote");
export const usageSourceNoteShort = (): string => t("usage.sourceNoteShort");
export const PLAN_KEYS: Record<"fiveHour" | "sevenDay", MessageKey> = { fiveHour: "usage.plan.fiveHour", sevenDay: "usage.plan.sevenDay" };
export const PLAN_SOURCE_KEYS: Record<ClaudePlanWindow["source"], MessageKey> = { statusline: "usage.planSource.statusline", probe: "usage.planSource.probe" };

export const totalTokens = (t: ClaudeUsageTotals): number => t.input + t.output + t.cacheWrite + t.cacheRead;

/** 1 234 567 → "1,2 Mn" (tr-TR). */
export function formatTokens(n: number, locale: string = intlLocale()): string {
  return plainSpaces(new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n));
}

/** Intl separates number and unit with no-break spaces; plain ones keep the text searchable (CSS keeps it on one line). */
const plainSpaces = (s: string): string => s.replace(/[\u00a0\u202f]/g, " ");

const PERCENT_BASE = 100;
/** 23.5 → "%24" (tr-TR). */
export function formatPercent(percent: number, locale: string = intlLocale()): string {
  return plainSpaces(new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(percent / PERCENT_BASE));
}

export function formatUsd(usd: number, locale: string = intlLocale()): string {
  return plainSpaces(new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(usd));
}

/** Time of day; with the date when it is not today. */
export function formatWhen(iso: string, locale: string = intlLocale(), now: number = Date.now()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(locale, { ...(sameDay ? {} : { day: "numeric", month: "short" }), hour: "2-digit", minute: "2-digit" }).format(d);
}

export function windowLabels(meta: Pick<ClaudeUsageResult, "sessionWindowHours" | "longWindowDays">): Record<UsageWindowId, string> {
  return {
    session: t("usage.window.session", { count: meta.sessionWindowHours }),
    today: t("usage.window.today"),
    week: t("usage.window.week", { count: meta.longWindowDays }),
  };
}

export function accountUsage(result: ClaudeUsageResult | undefined, accountId: string | undefined): ClaudeUsageAccount | undefined {
  return accountId === undefined ? undefined : result?.accounts.find((a) => a.accountId === accountId);
}

/** "5 saatlik %24 · haftalık %59", or undefined without plan figures. */
export function planSummary(account: ClaudeUsageAccount, locale: string = intlLocale()): string | undefined {
  const parts: string[] = [];
  if (account.plan?.fiveHour) parts.push(`${t(PLAN_KEYS.fiveHour)} ${formatPercent(account.plan.fiveHour.usedPercent, locale)}`);
  if (account.plan?.sevenDay) parts.push(`${t(PLAN_KEYS.sevenDay)} ${formatPercent(account.plan.sevenDay.usedPercent, locale)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Several lines for a `title`: the three windows, Claude's quota when known, and whose count this is. */
export function usageTooltip(account: ClaudeUsageAccount | undefined, meta: ClaudeUsageResult | undefined, locale: string = intlLocale()): string | undefined {
  if (!account || !meta) return undefined;
  if (account.error !== undefined) return account.error;
  if (account.updatedAt === undefined && account.indexing) return t("usage.tooltip.reading");
  const labels = windowLabels(meta);
  const windows = USAGE_WINDOWS.map((id, i) =>
    t(i === 0 ? "usage.tooltip.windowTokens" : "usage.tooltip.window", { label: labels[id], value: formatTokens(totalTokens(account.windows[id].totals), locale) }),
  ).join(" · ");
  const plan = planSummary(account, locale);
  return [windows, ...(plan !== undefined ? [t("usage.tooltip.quota", { plan })] : []), usageSourceNoteShort()].join("\n");
}
