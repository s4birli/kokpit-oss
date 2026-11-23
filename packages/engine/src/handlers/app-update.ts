// Kendini güncelleme: app.update.* requests (see @kokpit/shared app-update.ts and ../app-updates.ts).
import type { EngineIdentity, ParamsOf, ResultOf } from "@kokpit/shared";
import type { AppUpdateService } from "../app-updates.ts";
import { engineError } from "../contracts.ts";

export interface AppUpdateHandlerDeps {
  /** Absent = this engine publishes no app builds: checks answer "no update", downloads NOT_FOUND. */
  updates: AppUpdateService | undefined;
  identity: EngineIdentity;
}


export function createAppUpdateHandlers<C extends { conn: object }>(deps: AppUpdateHandlerDeps) {
  return {
    "app.update.check": (_ctx: C, p: ParamsOf<"app.update.check">): ResultOf<"app.update.check"> => {
      deps.updates?.seen({ clientId: p.clientId, buildId: p.app.buildId, version: p.app.version });
      return { engine: deps.identity, update: deps.updates?.current() ?? null };
    },
    "app.update.download": (ctx: C, p: ParamsOf<"app.update.download">): ResultOf<"app.update.download"> => {
      if (!deps.updates) throw engineError("NOT_FOUND", "engine.handlers.appUpdate.notPublishing");
      return deps.updates.issue(ctx.conn, p.buildId);
    },
    "app.update.report": (_ctx: C, p: ParamsOf<"app.update.report">): ResultOf<"app.update.report"> => {
      deps.updates?.report({ clientId: p.clientId, buildId: p.buildId, outcome: p.outcome, ...(p.detail !== undefined ? { detail: p.detail } : {}) });
      return {};
    },
    "app.update.clients": (): ResultOf<"app.update.clients"> => ({ current: deps.updates?.current() ?? null, clients: deps.updates?.clients() ?? [] }),
  };
}
