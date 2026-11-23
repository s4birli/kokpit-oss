// İş A (Adım 7) — arka plan ajanları: protocol handlers. Registered in server.ts with one spread line.
import type { ParamsOf, ResultOf, TerminalInfo } from "@kokpit/shared";
import type { BgAgentsService } from "../bg-agents.ts";
import { engineError } from "../contracts.ts";

type BgAgentsMethod = "bgAgents.list" | "bgAgents.attach" | "bgAgents.logs" | "bgAgents.stop";

/** Same shape as server.ts' handlers; the request context is passed through to `openTerminal`. */
export type BgAgentsHandlers<C> = {
  [M in BgAgentsMethod]: (ctx: C, params: ParamsOf<M>) => Promise<ResultOf<M>> | ResultOf<M>;
};

export interface BgAgentsHandlerDeps<C> {
  /** Absent: the list is empty and actions answer INVALID. */
  service: BgAgentsService | undefined;
  /** The server's terminal.open path: a normal terminal in that project/card typing `command`. */
  openTerminal(
    ctx: C,
    /** `accountId` (İş H): the session's Claude account; the terminal gets its config dir. */
    target: { projectId: string; cardId?: string; command: string; accountId?: string },
    size: { cols: number; rows: number },
  ): { terminal: TerminalInfo };
}

export function bgAgentsHandlers<C>(deps: BgAgentsHandlerDeps<C>): BgAgentsHandlers<C> {
  const svc = (): BgAgentsService => {
    if (!deps.service) throw engineError("INVALID", "engine.handlers.bgagents.disabled");
    return deps.service;
  };
  return {
    "bgAgents.list": async () => (deps.service ? deps.service.list() : { sessions: [] }),
    "bgAgents.attach": async (ctx, p) => {
      const target = await svc().attachTarget(p.id);
      return deps.openTerminal(ctx, target, { cols: p.cols, rows: p.rows });
    },
    "bgAgents.logs": (_c, p) => svc().logs(p.id),
    "bgAgents.stop": async (_c, p) => {
      await svc().stop(p.id);
      return {};
    },
  };
}
