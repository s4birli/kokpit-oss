// İş C (Adım 8) — Claude envanteri: claude.inventory / claude.inventory.read. Picks the project part's folder (card
// worktree or project folder on this machine); projects without one get only the account (user/plugin) part.
import { projectGitPath, type Card, type ParamsOf, type Project, type ResultOf } from "@kokpit/shared";
import type { ClaudeInventoryService, InventoryTarget } from "../claude-inventory.ts";
import { st } from "@kokpit/shared/i18n";
import { engineError } from "../contracts.ts";
import { fitResultList } from "../frame-fit.ts";

export interface ClaudeHandlerDeps {
  /** Absent = disabled: every request answers INVALID. */
  inventory: ClaudeInventoryService | undefined;
  requireProject(projectId: string): Project;
  requireCard(cardId: string): Card;
}

type Ref = { projectId?: string | undefined; cardId?: string | undefined };


export function createClaudeHandlers(deps: ClaudeHandlerDeps) {
  function service(): ClaudeInventoryService {
    if (!deps.inventory) throw engineError("INVALID", "engine.handlers.claude.inventoryOff");
    return deps.inventory;
  }

  function targetOf(r: Ref): InventoryTarget {
    if (r.cardId !== undefined) {
      const card = deps.requireCard(r.cardId);
      return { project: deps.requireProject(card.projectId), projectRoot: card.worktreePath };
    }
    const project = deps.requireProject(r.projectId ?? "");
    const root = projectGitPath(project);
    if (root !== null) return { project, projectRoot: root };
    const kind = project.location.kind;
    const note = st(kind === "ssh" ? "engine.handlers.claude.noteSsh" : "engine.handlers.claude.noteClone");
    return { project, projectRoot: null, note };
  }

  return {
    "claude.inventory": (_ctx: unknown, p: ParamsOf<"claude.inventory">): ResultOf<"claude.inventory"> => {
      const inv = service();
      // The item and description caps bound each part, not their product: the list is cut to what one frame holds.
      const fit = fitResultList(inv.inventory(targetOf(p)), "items");
      return fit.cut ? { ...fit.result, truncated: true } : fit.result;
    },
    "claude.inventory.read": (_ctx: unknown, p: ParamsOf<"claude.inventory.read">): ResultOf<"claude.inventory.read"> => {
      const inv = service();
      return inv.read(targetOf(p), p.id);
    },
  };
}
