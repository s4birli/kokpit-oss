// Girişler: protocol endpoints of the saved logins (logins.ts). server.ts spreads these into its handler map.
//
// Who may ask: the app's connection only. server.ts already answers FORBIDDEN to a scoped connection
// (`hello.screen`) for every method outside its scope before a handler runs; each handler here checks again, so a
// later change to that list cannot open the logins by accident.
//
// Nothing here logs: the params hold a password (save) and personal data (username, site).
import type { ParamsOf, Project, ResultMap } from "@kokpit/shared";
import { EngineError, engineError } from "../contracts.ts";
import type { LoginService } from "../logins.ts";

type LoginMethod = "logins.list" | "logins.save" | "logins.delete" | "logins.fill" | "logins.risk.set";
/** Structural subset of the server's per-request context. `scope` = a scoped (non-app) connection. */
interface LoginCtx {
  conn: { scope?: unknown };
}
type LoginHandler<M extends LoginMethod> = (ctx: LoginCtx, params: ParamsOf<M>) => Promise<ResultMap[M]> | ResultMap[M];

export interface LoginHandlerDeps {
  /** Absent = an engine without saved logins: the list is empty, everything else INVALID. */
  logins: LoginService | undefined;
  requireProject(projectId: string): Project;
}

export function createLoginHandlers(deps: LoginHandlerDeps): { [M in LoginMethod]: LoginHandler<M> } {
  function appOnly(ctx: LoginCtx): void {
    if (ctx.conn.scope !== undefined) throw engineError("FORBIDDEN", "engine.handlers.logins.appOnly");
  }
  function service(): LoginService {
    if (!deps.logins) throw engineError("INVALID", "engine.handlers.logins.none");
    return deps.logins;
  }
  /** The project must exist and run its browser on the engine (no client-side browser, no project kind without one). */
  function engineProject(projectId: string): string {
    const project = deps.requireProject(projectId);
    if (project.browser?.runOn === "client") throw engineError("INVALID", "engine.handlers.logins.clientBrowser");
    return project.id;
  }

  /**
   * An unexpected failure below is reported by its NAME only: the server logs unexpected errors with their text and
   * stack, and an error thrown while a password is in hand could quote it.
   */
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new Error(`logins: unexpected ${err instanceof Error ? err.name : "failure"}`);
    }
  }

  return {
    "logins.list": async (ctx, p) => {
      appOnly(ctx);
      const id = deps.requireProject(p.projectId).id;
      if (!deps.logins) return { logins: [], policy: { keychainAccess: "confirm", agentRiskAccepted: false, agentsPresent: false } };
      return { logins: deps.logins.list(id), policy: await deps.logins.policy(id) };
    },
    "logins.save": async (ctx, p) => {
      appOnly(ctx);
      const projectId = engineProject(p.projectId);
      return guarded(async () => ({ login: await service().save({ ...p, projectId }) }));
    },
    "logins.delete": async (ctx, p) => {
      appOnly(ctx);
      return guarded(async () => {
        await service().delete(p.id);
        return {};
      });
    },
    "logins.fill": async (ctx, p) => {
      appOnly(ctx);
      const projectId = engineProject(p.projectId);
      return guarded(async () => ({ filled: await service().fill(projectId, p.id, { confirmAgentRisk: p.confirmAgentRisk }) }));
    },
    "logins.risk.set": async (ctx, p) => {
      appOnly(ctx);
      const projectId = engineProject(p.projectId);
      return { policy: await service().setRisk(projectId, p.accepted) };
    },
  };
}
