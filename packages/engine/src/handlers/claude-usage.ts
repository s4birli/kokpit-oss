// Claude kullanımı — protocol handlers. Registered in server.ts with one spread line.
import type { ParamsOf, ResultOf } from "@kokpit/shared";
import type { ClaudeUsageService } from "../claude-usage.ts";
import { engineError } from "../contracts.ts";

export interface ClaudeUsageHandlerDeps {
  /** Absent = disabled: every request answers INVALID. */
  service: ClaudeUsageService | undefined;
}

export function claudeUsageHandlers(deps: ClaudeUsageHandlerDeps) {
  const svc = (): ClaudeUsageService => {
    if (!deps.service) throw engineError("INVALID", "engine.handlers.claudeUsage.disabled");
    return deps.service;
  };
  return {
    "claudeUsage.get": (_ctx: unknown, p: ParamsOf<"claudeUsage.get">): ResultOf<"claudeUsage.get"> => svc().get(p),
    "claudeUsage.probe": (_ctx: unknown, p: ParamsOf<"claudeUsage.probe">): Promise<ResultOf<"claudeUsage.probe">> | ResultOf<"claudeUsage.probe"> =>
      svc().probe(p.accountId),
  };
}
