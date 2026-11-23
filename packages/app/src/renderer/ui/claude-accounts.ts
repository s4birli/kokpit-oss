// İş H — Claude hesapları: shared helpers for the settings tab, the project form, the header and the Ajanlar panel.
import type { ClaudeAccount, Project } from "@kokpit/shared";
import { t } from "../../i18n/index.ts";
import type { EngineClient } from "../engine/types.ts";

export const fetchClaudeAccounts = async (c: EngineClient): Promise<ClaudeAccount[]> => (await c.request("claudeAccounts.list", {})).accounts;
export const CLAUDE_ACCOUNTS_EVENTS = ["claudeAccounts.changed"] as const;

/**
 * Name of a NON-default account, for subtle badges (project header, background agents); undefined for the
 * default account, an unset one, or an id the list does not know (the engine falls back to the default then).
 */
export function accountBadge(accounts: readonly ClaudeAccount[] | undefined, accountId: string | undefined): string | undefined {
  if (accountId === undefined || !accounts) return undefined;
  const a = accounts.find((x) => x.id === accountId);
  return a && !a.isDefault ? a.name : undefined;
}

export const projectAccountBadge = (accounts: readonly ClaudeAccount[] | undefined, project: Pick<Project, "claudeAccountId">) =>
  accountBadge(accounts, project.claudeAccountId);

/** Client-side check of a config folder: absolute or `~/…` (the engine checks it is inside HOME). */
export function checkConfigDir(raw: string): string | undefined {
  const v = raw.trim();
  if (v === "") return t("claude.accounts.configDirRequired");
  if (!v.startsWith("/") && !v.startsWith("~/")) return t("claude.accounts.configDirAbsolute");
  if (v.includes("\0")) return t("claude.accounts.configDirInvalid");
  return undefined;
}
