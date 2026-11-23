// İş A — ajan özeti: `agents.summary` and the `terminal.activity` event.
import type { AgentProjectSummary, ParamsOf, Project, ResultOf, ServerMessage } from "@kokpit/shared";
import type { ActivityTracker } from "../activity.ts";
import type { PtyManager } from "../contracts.ts";

export interface AgentsHandlerDeps {
  /** Terminals with `activity` (the PtyManager wrapped by `withActivity`). */
  ptys: PtyManager;
  projects: { list(): Project[] };
  /** Absent: no events are sent and terminals carry no activity. */
  activity?: ActivityTracker | undefined;
  broadcast(msg: ServerMessage): void;
}

export function agentsHandlers(deps: AgentsHandlerDeps) {
  deps.activity?.onChange((c) => deps.broadcast({ type: "event", name: "terminal.activity", ...c }));

  return {
    "agents.summary": (_ctx: unknown, _p: ParamsOf<"agents.summary">): ResultOf<"agents.summary"> => {
      const projects: AgentProjectSummary[] = [];
      for (const project of deps.projects.list()) {
        const terminals = deps.ptys.list({ projectId: project.id });
        if (terminals.length > 0) projects.push({ projectId: project.id, terminals });
      }
      return { projects };
    },
  };
}
