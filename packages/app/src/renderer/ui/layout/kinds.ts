// İş L: which layout a selection uses. A project kind of an optional module may have a layout of its own, with no
// terminals, files or browser (an app-only project).
import type { Project } from "@kokpit/shared";
import type { LayoutKind } from "./ui-state.ts";

/** A project that only shows an app panel (no terminals, cards, browser, map or files). */
export function isAppOnlyProject(project: Project | null | undefined): boolean {
  return false;
}

export function layoutKindOf(project: Project | null | undefined): LayoutKind {
  return "normal";
}
