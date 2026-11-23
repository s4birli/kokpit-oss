// İş T — pure helpers of the Terminaller panel: persisted tab preferences and their reconciliation with the
// terminals the engine actually has.

/** What the panel remembers per project/card (through the host's PanelStateStore). */
export interface TabPrefs {
  /** Tab order (terminal ids). */
  order: string[];
  active: string | null;
  /** Second terminal shown next to the active one ("böl"); null = not split. */
  split: string | null;
  /** Width share of the active pane while split; null = the configured default. */
  ratio: number | null;
}

export const EMPTY_PREFS: TabPrefs = { order: [], active: null, split: null, ratio: null };

/** Key under which the prefs live in the panel's state store. */
export const PREFS_KEY = "tabs";

const str = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);

/** Persisted (untrusted, possibly older or hand-edited) value → well-formed prefs. */
export function readPrefs(raw: unknown): TabPrefs {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...EMPTY_PREFS };
  const r = raw as Record<string, unknown>;
  const order = Array.isArray(r.order) ? r.order.map(str).filter((x): x is string => x !== null) : [];
  const ratio = typeof r.ratio === "number" && Number.isFinite(r.ratio) ? r.ratio : null;
  return { order, active: str(r.active), split: str(r.split), ratio };
}

/** Prefs restricted to the terminals that exist: unknown ids dropped, new ones appended in engine order. */
export function reconcileTabs(prefs: TabPrefs, ids: readonly string[]): TabPrefs {
  const known = new Set(ids);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const id of [...prefs.order, ...ids]) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  const active = prefs.active !== null && known.has(prefs.active) ? prefs.active : (order[0] ?? null);
  const split = prefs.split !== null && known.has(prefs.split) && prefs.split !== active ? prefs.split : null;
  return { order, active, split, ratio: prefs.ratio };
}

/** The tab to show after `id` goes away: the one to its right, else to its left. */
export function neighbourOf(order: readonly string[], id: string): string | null {
  const i = order.indexOf(id);
  if (i < 0) return order[0] ?? null;
  return order[i + 1] ?? order[i - 1] ?? null;
}

/** `id` moved to just before `beforeId` (drag-and-drop on the tab strip). */
export function moveTab(order: readonly string[], id: string, beforeId: string): string[] {
  if (id === beforeId || !order.includes(id) || !order.includes(beforeId)) return [...order];
  const rest = order.filter((x) => x !== id);
  rest.splice(rest.indexOf(beforeId), 0, id);
  return rest;
}

/** Split share kept inside [min, 1 - min]; an unreadable value becomes the middle. */
export function clampRatio(ratio: number, min: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(1 - min, Math.max(min, ratio));
}
