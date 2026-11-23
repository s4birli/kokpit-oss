// İş W — Akış: flow.info / flow.list / flow.read. Picks the folder (card worktree or project folder on this
// machine); FlowService keeps every access inside its flow folder.
import { projectGitPath, type Card, type ParamsOf, type Project, type ResultOf } from "@kokpit/shared";
import { engineError } from "../contracts.ts";
import type { FlowService } from "../flow.ts";

export interface FlowHandlerDeps {
  /** Absent = flows disabled: info says unavailable, list/read answer INVALID. */
  flow: FlowService | undefined;
  requireProject(projectId: string): Project;
  requireCard(cardId: string): Card;
}

type Target = { projectId?: string | undefined; cardId?: string | undefined };


export function createFlowHandlers(deps: FlowHandlerDeps) {
  function service(): FlowService {
    if (!deps.flow) throw engineError("INVALID", "engine.handlers.flow.off");
    return deps.flow;
  }

  /** Root folder of a request, or null for projects without a folder on this machine (ssh, not cloned). */
  function rootOrNull(t: Target): { root: string | null; project: Project } {
    if (t.cardId !== undefined) {
      const card = deps.requireCard(t.cardId);
      return { root: card.worktreePath, project: deps.requireProject(card.projectId) };
    }
    const project = deps.requireProject(t.projectId ?? "");
    return { root: project.location.kind === "ssh" ? null : projectGitPath(project), project };
  }

  function rootOf(t: Target): string {
    const { root, project } = rootOrNull(t);
    if (root !== null) return root;
    if (project.location.kind === "ssh") throw engineError("INVALID", "engine.handlers.flow.ssh");
    throw project.location.kind === "github"
      ? engineError("NOT_FOUND", "engine.handlers.flow.notCloned")
      : engineError("INVALID", "engine.handlers.flow.noFolder");
  }

  return {
    "flow.info": (_ctx: unknown, p: ParamsOf<"flow.info">): ResultOf<"flow.info"> => {
      const { root } = rootOrNull(p);
      if (root === null || !deps.flow) return { available: false };
      return { available: true, dir: deps.flow.dir, updateCommand: deps.flow.updateCommand };
    },
    "flow.list": (_ctx: unknown, p: ParamsOf<"flow.list">): ResultOf<"flow.list"> => {
      const flow = service();
      return flow.list(rootOf(p));
    },
    "flow.read": (_ctx: unknown, p: ParamsOf<"flow.read">): ResultOf<"flow.read"> => {
      const flow = service();
      return flow.read(rootOf(p), p.id);
    },
  };
}
