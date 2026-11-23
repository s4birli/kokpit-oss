// Shared wording and values for "which tool does a new terminal start with" pickers.
import type { Tool } from "@kokpit/shared";
import { t } from "../../i18n/index.ts";

/** The tools a terminal of a project may start with (every tool in this edition). */
export function toolsForProject(tools: readonly Tool[], _project?: unknown): readonly Tool[] {
  return tools;
}

/** Select value for "no tool": a plain shell. */
export const SHELL_ONLY = "";
/** The "no tool" choice, in the current language. */
export const shellOnlyLabel = (): string => t("workbench.tools.shellOnly");

/** Display name of a tool id; a plain shell when the id is absent or the tool is gone. */
export function toolLabel(tools: readonly Tool[], toolId: string | undefined): string {
  return tools.find((t) => t.id === toolId)?.name ?? shellOnlyLabel();
}
