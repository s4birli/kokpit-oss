// İş H (Adım 8) — Claude hesapları: protocol handlers. Registered in server.ts with one spread line.
import type { ParamsOf, ResultOf, ServerMessage, TerminalInfo } from "@kokpit/shared";
import type { ClaudeAccountService } from "../claude-accounts.ts";
import { engineError } from "../contracts.ts";

type ClaudeAccountMethod =
  | "claudeAccounts.list"
  | "claudeAccounts.create"
  | "claudeAccounts.update"
  | "claudeAccounts.delete"
  | "claudeAccounts.login"
  | "claudeAccounts.shareSkills";

export type ClaudeAccountHandlers<C> = {
  [M in ClaudeAccountMethod]: (ctx: C, params: ParamsOf<M>) => Promise<ResultOf<M>> | ResultOf<M>;
};

export interface ClaudeAccountHandlerDeps<C> {
  /** Absent: the list is empty and actions answer INVALID. */
  service: ClaudeAccountService | undefined;
  /** Project the login terminal opens in (the built-in "Mac mini" project). */
  builtinProjectId: string;
  /** Typed into the login terminal (`claude /login`, quoted). */
  loginCommand: string;
  broadcast(msg: ServerMessage): void;
  /** The server's terminal.open path; `claudeAccountId` overrides the project's account. */
  openTerminal(
    ctx: C,
    target: { projectId: string; command: string; claudeAccountId: string },
    size: { cols: number; rows: number },
  ): { terminal: TerminalInfo };
}

export function claudeAccountHandlers<C>(deps: ClaudeAccountHandlerDeps<C>): ClaudeAccountHandlers<C> {
  const svc = (): ClaudeAccountService => {
    if (!deps.service) throw engineError("INVALID", "engine.handlers.claudeAccounts.disabled");
    return deps.service;
  };
  const changed = () => deps.broadcast({ type: "event", name: "claudeAccounts.changed" });
  return {
    "claudeAccounts.list": () => ({ accounts: deps.service ? deps.service.list() : [] }),
    "claudeAccounts.create": (_c, p) => {
      const account = svc().create(p);
      changed();
      return { account };
    },
    "claudeAccounts.update": (_c, p) => {
      const account = svc().update(p);
      changed();
      return { account };
    },
    "claudeAccounts.delete": (_c, p) => {
      svc().delete(p.id);
      changed();
      return {};
    },
    "claudeAccounts.login": (ctx, p) => {
      svc().ensureDir(p.id);
      const target = { projectId: deps.builtinProjectId, command: deps.loginCommand, claudeAccountId: p.id };
      return deps.openTerminal(ctx, target, { cols: p.cols, rows: p.rows });
    },
    "claudeAccounts.shareSkills": (_c, p) => svc().shareSkills(p.id),
  };
}
