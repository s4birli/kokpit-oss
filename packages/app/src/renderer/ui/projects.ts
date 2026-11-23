// Pure helpers about projects, shared by the rail, the headers and the settings screen.
import type { Project, ProjectLocation, SshHost, Tool } from "@kokpit/shared";
import { t } from "../../i18n/index.ts";

/**
 * Cards need a git repo on the engine machine: local folders and GitHub clones, never SSH, and never the
 * built-in project (the home folder). A local folder that is not a repo is refused by the engine.
 */
export function supportsCards(p: Project): boolean {
  return p.location.kind !== "ssh" && !isAppOnlyKind(p.location.kind) && !p.builtin;
}

/** A location kind of an optional module with no terminals, browser or files on the engine (only an app panel). */
export function isAppOnlyKind(kind: ProjectLocation["kind"]): boolean {
  return false;
}

/** Built-in project first, otherwise the engine's order. */
export function sortProjects(list: readonly Project[]): Project[] {
  return [...list].sort((a, b) => Number(Boolean(b.builtin)) - Number(Boolean(a.builtin)));
}

/** Tool a new terminal starts with when nothing is chosen: the project's default, else the global one (if it exists). */
export function effectiveDefaultToolId(
  project: Project | undefined,
  globalDefaultToolId: string | undefined,
  tools: readonly Tool[],
): string | undefined {
  const exists = (id: string | undefined) => id !== undefined && tools.some((t) => t.id === id);
  if (exists(project?.defaultToolId)) return project?.defaultToolId;
  return exists(globalDefaultToolId) ? globalDefaultToolId : undefined;
}

/** One-line description of where a project's terminals open. */
export function locationLabel(p: Project, hosts: readonly SshHost[], machineName: string): string {
  const loc = p.location;
  switch (loc.kind) {
    case "local":
      return `${machineName}: ${loc.path}`;
    case "github":
      return `GitHub: ${loc.url}`;
    case "ssh": {
      const host = hosts.find((h) => h.id === loc.hostId);
      return `SSH: ${host?.name ?? loc.hostId}${loc.path ? `:${loc.path}` : ""}`;
    }
  }
}
