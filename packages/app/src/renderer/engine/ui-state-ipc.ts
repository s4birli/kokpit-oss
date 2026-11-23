// İş L: contract between the renderer, the preload and Electron main for the persisted UI state (panel layout,
// per-panel state, selected project/card). Main validates with the same rule; the content is data, never executed.
import { t } from "../../i18n/index.ts";

export const UI_STATE_IPC = { load: "uiState:load", save: "uiState:save" } as const;

/** Exposed as `window.kokpit.uiState`. `load` resolves to null when nothing (valid) is stored. */
export interface UiStateBridge {
  load(): Promise<unknown>;
  save(state: unknown): Promise<void>;
}

export interface UiStateLimits {
  /** Max size of the serialized state (UTF-8 bytes). */
  maxBytes: number;
  /** İş D: max size of one serialized dock layout (UTF-8 bytes); a bigger one is not stored. */
  maxLayoutBytes: number;
  /** İş D: max number of projects with a layout of their own; over it the least recently changed ones go. */
  maxProjectLayouts: number;
}

export const UI_STATE_LIMITS: UiStateLimits = { maxBytes: 1024 * 1024, maxLayoutBytes: 32 * 1024, maxProjectLayouts: 100 };

/**
 * Current format. 2 (İş D): `layouts` is `{ inherited, projects }` — one dock layout per project. 1: `layouts` was
 * the single layout shared by every project; such a file is migrated when read (layout/ui-state.ts).
 */
export const UI_STATE_VERSION = 2;
/** Formats the app can read; a file with any other version is ignored (defaults). */
export const UI_STATE_READABLE_VERSIONS: readonly number[] = [1, UI_STATE_VERSION];

/** UTF-8 size of a value's JSON; undefined when it has none (cycles, functions). */
export function jsonBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : new TextEncoder().encode(json).length;
  } catch {
    return undefined;
  }
}

export type UiStateCheck = { ok: true; json: string } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Top-level shape + size check. The renderer parses the details (and falls back to defaults). */
export function checkUiState(input: unknown, limits: UiStateLimits = UI_STATE_LIMITS): UiStateCheck {
  if (!isRecord(input)) return { ok: false, error: t("common.uiState.invalid") };
  if (typeof input.version !== "number") return { ok: false, error: t("common.uiState.noVersion") };
  if (!isRecord(input.layouts) || !isRecord(input.panels)) return { ok: false, error: t("common.uiState.invalid") };
  if (input.selection !== null && !isRecord(input.selection)) return { ok: false, error: t("common.uiState.invalid") };
  // İş D: per-project layouts (absent in the old format) — a record, and not more of them than the cap.
  const projects = input.layouts.projects;
  if (projects !== undefined) {
    if (!isRecord(projects)) return { ok: false, error: t("common.uiState.invalid") };
    if (Object.keys(projects).length > limits.maxProjectLayouts) return { ok: false, error: t("common.uiState.tooManyLayouts") };
  }
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return { ok: false, error: t("common.uiState.notJson") };
  }
  if (new TextEncoder().encode(json).length > limits.maxBytes) return { ok: false, error: t("common.uiState.tooLarge") };
  return { ok: true, json };
}
