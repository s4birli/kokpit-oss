// İş P — proje sekmeleri: the open projects shown as tabs above the work area. Pure state: which projects are open
// (in order), which one is active, and the card each tab has selected. The active tab is the workbench selection.
import type { SavedSelection } from "./layout/ui-state.ts";

export interface ProjectTab {
  projectId: string;
  /** The card selected within the project; absent = the project itself. */
  cardId?: string;
}

export interface ProjectTabsState {
  tabs: readonly ProjectTab[];
  /** projectId of the active tab; null iff there are no tabs. */
  active: string | null;
}

export function emptyTabs(): ProjectTabsState {
  return { tabs: [], active: null };
}

const tab = (projectId: string, cardId: string | undefined): ProjectTab =>
  cardId === undefined ? { projectId } : { projectId, cardId };

/**
 * Opens (or just activates) a project's tab. `cardId`: undefined keeps the tab's card (none for a new tab), null
 * selects the project itself, a string selects that card.
 */
export function openTab(s: ProjectTabsState, projectId: string, cardId?: string | null): ProjectTabsState {
  const i = s.tabs.findIndex((t) => t.projectId === projectId);
  if (i < 0) return { tabs: [...s.tabs, tab(projectId, cardId ?? undefined)], active: projectId };
  const cur = s.tabs[i]!;
  const nextCard = cardId === undefined ? cur.cardId : (cardId ?? undefined);
  if (s.active === projectId && nextCard === cur.cardId) return s;
  const tabs = nextCard === cur.cardId ? s.tabs : s.tabs.map((t, j) => (j === i ? tab(projectId, nextCard) : t));
  return { tabs, active: projectId };
}

export function activateTab(s: ProjectTabsState, projectId: string): ProjectTabsState {
  if (s.active === projectId || !s.tabs.some((t) => t.projectId === projectId)) return s;
  return { ...s, active: projectId };
}

/** Closes a tab (nothing is deleted). Closing the active tab activates its right neighbour, else its left one. */
export function closeTab(s: ProjectTabsState, projectId: string): ProjectTabsState {
  const i = s.tabs.findIndex((t) => t.projectId === projectId);
  if (i < 0) return s;
  const tabs = s.tabs.filter((_, j) => j !== i);
  if (s.active !== projectId) return { tabs, active: s.active };
  const next = tabs[i] ?? tabs[i - 1];
  return { tabs, active: next?.projectId ?? null };
}

/** Moves a tab to `index` (clamped into range). */
export function moveTab(s: ProjectTabsState, projectId: string, index: number): ProjectTabsState {
  const from = s.tabs.findIndex((t) => t.projectId === projectId);
  if (from < 0) return s;
  const to = Math.max(0, Math.min(s.tabs.length - 1, Math.trunc(index)));
  if (to === from) return s;
  const tabs = [...s.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved!);
  return { tabs, active: s.active };
}

/** Moves a tab one or more places left (negative) or right; stops at the ends. */
export function moveTabBy(s: ProjectTabsState, projectId: string, delta: number): ProjectTabsState {
  const from = s.tabs.findIndex((t) => t.projectId === projectId);
  return from < 0 ? s : moveTab(s, projectId, from + delta);
}

/** The workbench selection of the active tab. */
export function selectionOf(s: ProjectTabsState): SavedSelection {
  const t = s.tabs.find((x) => x.projectId === s.active);
  if (!t) return null;
  return t.cardId === undefined ? { kind: "project", projectId: t.projectId } : { kind: "card", cardId: t.cardId };
}

/** A card that no longer exists: its tab falls back to the project. */
export function dropCard(s: ProjectTabsState, cardId: string): ProjectTabsState {
  if (!s.tabs.some((t) => t.cardId === cardId)) return s;
  return { ...s, tabs: s.tabs.map((t) => (t.cardId === cardId ? { projectId: t.projectId } : t)) };
}

/** Tabs whose card is missing from its project's loaded card list fall back to the project (unloaded lists: kept). */
export function dropMissingCards(
  s: ProjectTabsState,
  cardsOf: (projectId: string) => readonly { id: string }[] | undefined,
): ProjectTabsState {
  let out = s;
  for (const t of s.tabs) {
    const cards = t.cardId === undefined ? undefined : cardsOf(t.projectId);
    if (cards && !cards.some((c) => c.id === t.cardId)) out = dropCard(out, t.cardId!);
  }
  return out;
}

/** Closes the tabs of projects not in `known`. */
export function retainProjects(s: ProjectTabsState, known: ReadonlySet<string>): ProjectTabsState {
  let out = s;
  for (const t of s.tabs) if (!known.has(t.projectId)) out = closeTab(out, t.projectId);
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whatever came from disk → valid tabs; malformed entries and duplicates are dropped. */
export function parseTabs(raw: unknown): ProjectTabsState {
  if (!isRecord(raw) || !Array.isArray(raw.tabs)) return emptyTabs();
  const tabs: ProjectTab[] = [];
  for (const t of raw.tabs) {
    if (!isRecord(t) || typeof t.projectId !== "string" || t.projectId === "") continue;
    if (tabs.some((x) => x.projectId === t.projectId)) continue;
    tabs.push(tab(t.projectId, typeof t.cardId === "string" && t.cardId !== "" ? t.cardId : undefined));
  }
  const active = tabs.find((t) => t.projectId === raw.active)?.projectId ?? tabs[0]?.projectId ?? null;
  return { tabs, active };
}

/**
 * First launch with tabs: the previously selected project (or card) becomes the only tab. Null while a saved card's
 * project is not known yet.
 */
export function tabsFromSelection(
  selection: SavedSelection,
  projectOfCard: (cardId: string) => string | undefined,
): ProjectTabsState | null {
  if (!selection) return emptyTabs();
  if (selection.kind === "project") return openTab(emptyTabs(), selection.projectId);
  const projectId = projectOfCard(selection.cardId);
  return projectId === undefined ? null : openTab(emptyTabs(), projectId, selection.cardId);
}

/** Saved tabs with the tabs opened while they were loading on top (those win, including the active one). */
export function mergeTabs(saved: ProjectTabsState, live: ProjectTabsState): ProjectTabsState {
  if (live.tabs.length === 0) return saved;
  let out = saved;
  for (const t of live.tabs) out = openTab(out, t.projectId, t.cardId ?? null);
  return live.active === null ? out : activateTab(out, live.active);
}
