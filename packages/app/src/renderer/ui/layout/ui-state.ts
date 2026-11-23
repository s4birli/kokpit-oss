// İş L: the persisted UI state of the layout host — dockview layouts, per-panel state scoped to project/card, and the
// selected project/card. Lives in memory, saved debounced through the preload bridge.
// İş D: every project (and "no project") owns its dock layout; the single layout of older files is what a project
// starts from the first time it is opened.
import {
  jsonBytes,
  UI_STATE_LIMITS,
  UI_STATE_READABLE_VERSIONS,
  UI_STATE_VERSION,
  type UiStateBridge,
  type UiStateLimits,
} from "../../engine/ui-state-ipc.ts";
import type { PanelStateStore } from "./contract.ts";
import { parseTabs, type ProjectTabsState } from "../project-tabs.ts";

/** The shape of a project's dock (an optional module may add its own). A project's layout is kept per kind. */
export type LayoutKind = "normal";
export const LAYOUT_KINDS: readonly LayoutKind[] = ["normal"];

export type SavedSelection = { kind: "project"; projectId: string } | { kind: "card"; cardId: string } | null;

type Json = Record<string, unknown>;
type KindLayouts = Partial<Record<LayoutKind, Json>>;

/** İş D: the dock layouts. */
export interface LayoutsState {
  /**
   * The one layout every project shared before İş D (format 1). Only ever written by the migration: it is what a
   * project without a layout of its own starts from, so nothing the user arranged is lost.
   */
  inherited: KindLayouts;
  /** Owner (see layoutOwnerOf) → that project's own layouts. Insertion order = least recently changed first. */
  projects: Record<string, KindLayouts>;
}

export interface UiState {
  version: typeof UI_STATE_VERSION;
  /** Serialized dockview layouts (opaque here; the host validates them when restoring). */
  layouts: LayoutsState;
  /** panelId → scope ("project:<id>" | "card:<id>" | "none") → key → value. */
  panels: Record<string, Record<string, Json>>;
  selection: SavedSelection;
  /** İş P: open project tabs; absent in files written before them (the selection then becomes the only tab). */
  tabs?: ProjectTabsState;
  /** İş P: the left project list is collapsed. */
  railCollapsed?: boolean;
}

export function emptyUiState(): UiState {
  return { version: UI_STATE_VERSION, layouts: { inherited: {}, projects: {} }, panels: {}, selection: null };
}

const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

function parseSelection(v: unknown): SavedSelection {
  if (!isRecord(v)) return null;
  if (v.kind === "project" && typeof v.projectId === "string") return { kind: "project", projectId: v.projectId };
  if (v.kind === "card" && typeof v.cardId === "string") return { kind: "card", cardId: v.cardId };
  return null;
}

const isReadable = (raw: unknown): raw is Json => isRecord(raw) && UI_STATE_READABLE_VERSIONS.includes(raw.version as number);

/** A layout we are willing to keep: an object whose JSON fits the bound. */
function fitsLayout(layout: unknown, limits: UiStateLimits): layout is Json {
  if (!isRecord(layout)) return false;
  const bytes = jsonBytes(layout);
  return bytes !== undefined && bytes <= limits.maxLayoutBytes;
}

/** The known kinds of `raw` that hold a storable layout. */
function parseKindLayouts(raw: unknown, limits: UiStateLimits): KindLayouts {
  const out: KindLayouts = {};
  if (!isRecord(raw)) return out;
  for (const kind of LAYOUT_KINDS) {
    const l = raw[kind];
    if (fitsLayout(l, limits)) out[kind] = l;
  }
  return out;
}

/** Format 1 → the old shared layout becomes `inherited`; format 2 → validated, the most recent projects up to the cap. */
function parseLayouts(version: unknown, raw: unknown, limits: UiStateLimits): LayoutsState {
  if (version !== UI_STATE_VERSION) return { inherited: parseKindLayouts(raw, limits), projects: {} };
  const out: LayoutsState = { inherited: {}, projects: {} };
  if (!isRecord(raw)) return out;
  out.inherited = parseKindLayouts(raw.inherited, limits);
  if (!isRecord(raw.projects)) return out;
  const kept: [string, KindLayouts][] = [];
  for (const [owner, layouts] of Object.entries(raw.projects)) {
    const own = parseKindLayouts(layouts, limits);
    if (Object.keys(own).length > 0) kept.push([owner, own]);
  }
  out.projects = Object.fromEntries(limits.maxProjectLayouts > 0 ? kept.slice(-limits.maxProjectLayouts) : []);
  return out;
}

/**
 * Whatever came from disk → a valid state in the current format; malformed parts are dropped, an unreadable version
 * gives defaults, an older readable one is migrated.
 */
export function parseUiState(raw: unknown, limits: UiStateLimits = UI_STATE_LIMITS): UiState {
  const out = emptyUiState();
  if (!isReadable(raw)) return out;
  out.layouts = parseLayouts(raw.version, raw.layouts, limits);
  if (isRecord(raw.panels)) {
    for (const [panel, scopes] of Object.entries(raw.panels)) {
      if (!isRecord(scopes)) continue;
      const kept: Record<string, Json> = {};
      for (const [scope, values] of Object.entries(scopes)) if (isRecord(values)) kept[scope] = values;
      if (Object.keys(kept).length > 0) out.panels[panel] = kept;
    }
  }
  out.selection = parseSelection(raw.selection);
  if (isRecord(raw.tabs)) out.tabs = parseTabs(raw.tabs);
  if (typeof raw.railCollapsed === "boolean") out.railCollapsed = raw.railCollapsed;
  return out;
}

/** The PanelStateStore scope of a selection: the card when one is selected, else the project. */
export function scopeOf(projectId: string | undefined, cardId: string | undefined): string {
  if (cardId !== undefined) return `card:${cardId}`;
  if (projectId !== undefined) return `project:${projectId}`;
  return "none";
}

/** İş D: who owns a dock layout — the project, or "no project" when nothing is selected. Cards share their project's. */
export function layoutOwnerOf(projectId: string | undefined): string {
  return scopeOf(projectId, undefined);
}
export const NO_PROJECT_OWNER = layoutOwnerOf(undefined);

export interface UiStateStore {
  load(): Promise<void>;
  /** The owner's own layout; without one, the layout inherited from before per-project layouts (if any). */
  getLayout(owner: string, kind: LayoutKind): Json | undefined;
  /** undefined drops the owner's own layout (it inherits again). A layout over the size bound is not stored. */
  setLayout(owner: string, kind: LayoutKind, layout: Json | undefined): void;
  /** İş D: forgets the layouts of projects whose id is not in `projectIds` (deleted projects). */
  retainLayouts(projectIds: ReadonlySet<string>): void;
  getSelection(): SavedSelection;
  setSelection(selection: SavedSelection): void;
  /** İş P: undefined when never saved. */
  getTabs(): ProjectTabsState | undefined;
  setTabs(tabs: ProjectTabsState): void;
  getRailCollapsed(): boolean;
  setRailCollapsed(collapsed: boolean): void;
  /** Stable object per (panel, scope). */
  panelState(panelId: string, scope: string): PanelStateStore;
  /** Saves now (pending debounce included). Never rejects. */
  flush(): Promise<void>;
  snapshot(): UiState;
  /** İş M: true after load() found no (valid) saved state, i.e. the app's very first launch on this machine. */
  isFresh(): boolean;
}

export interface UiStateStoreOptions {
  /** null: nothing is persisted (tests, no preload). */
  bridge: UiStateBridge | null;
  saveDebounceMs: number;
  /** Bounds on the stored layouts (default: UI_STATE_LIMITS). */
  limits?: UiStateLimits;
}

/** A JSON copy of `value`, or undefined when it isn't JSON-serializable. */
function jsonCopy(value: unknown): unknown {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? undefined : (JSON.parse(s) as unknown);
  } catch {
    return undefined;
  }
}

export function createUiStateStore({ bridge, saveDebounceMs, limits = UI_STATE_LIMITS }: UiStateStoreOptions): UiStateStore {
  let state = emptyUiState();
  let loaded = bridge === null;
  let dirty = false;
  let fresh = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stores = new Map<string, PanelStateStore>();

  const save = async (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!bridge || !loaded || !dirty) return;
    dirty = false;
    try {
      await bridge.save(state);
    } catch (err) {
      console.warn("[kokpit] arayüz durumu kaydedilemedi", err);
    }
  };

  const changed = (): void => {
    dirty = true;
    if (!bridge || !loaded) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void save(), saveDebounceMs);
  };

  /** Stores (or drops) one layout; the owner becomes the most recently changed, the oldest go over the cap. */
  const putLayout = (owner: string, kind: LayoutKind, layout: Json | undefined): void => {
    const projects = state.layouts.projects;
    const own: KindLayouts = { ...projects[owner] };
    if (layout === undefined) delete own[kind];
    else own[kind] = layout;
    delete projects[owner];
    if (Object.keys(own).length === 0) return;
    projects[owner] = own;
    const owners = Object.keys(projects);
    for (const old of owners.slice(0, Math.max(0, owners.length - limits.maxProjectLayouts))) delete projects[old];
  };

  return {
    async load() {
      if (!bridge) return;
      let raw: unknown = null;
      try {
        raw = await bridge.load();
      } catch {
        raw = null;
      }
      // Changes made while loading win over the file.
      const pending = state;
      state = parseUiState(raw, limits);
      fresh = !isReadable(raw);
      for (const [owner, layouts] of Object.entries(pending.layouts.projects)) {
        for (const kind of LAYOUT_KINDS) if (layouts[kind]) putLayout(owner, kind, layouts[kind]);
      }
      for (const [panel, scopes] of Object.entries(pending.panels)) {
        for (const [scope, values] of Object.entries(scopes)) {
          state.panels[panel] = { ...state.panels[panel], [scope]: { ...state.panels[panel]?.[scope], ...values } };
        }
      }
      if (pending.selection) state.selection = pending.selection;
      if (pending.tabs) state.tabs = pending.tabs;
      if (pending.railCollapsed !== undefined) state.railCollapsed = pending.railCollapsed;
      loaded = true;
      if (dirty) changed();
    },
    getLayout: (owner, kind) => state.layouts.projects[owner]?.[kind] ?? state.layouts.inherited[kind],
    setLayout(owner, kind, layout) {
      if (layout !== undefined && !fitsLayout(layout, limits)) {
        console.warn("[kokpit] düzen saklanamayacak kadar büyük; önceki düzen korunuyor", owner, kind);
        return;
      }
      putLayout(owner, kind, layout);
      changed();
    },
    retainLayouts(projectIds) {
      const keep = new Set([NO_PROJECT_OWNER, ...[...projectIds].map(layoutOwnerOf)]);
      const gone = Object.keys(state.layouts.projects).filter((owner) => !keep.has(owner));
      if (gone.length === 0) return;
      for (const owner of gone) delete state.layouts.projects[owner];
      changed();
    },
    getSelection: () => state.selection,
    setSelection(selection) {
      state.selection = selection;
      changed();
    },
    getTabs: () => state.tabs,
    setTabs(tabs) {
      state.tabs = tabs;
      changed();
    },
    getRailCollapsed: () => state.railCollapsed ?? false,
    setRailCollapsed(collapsed) {
      state.railCollapsed = collapsed;
      changed();
    },
    panelState(panelId, scope) {
      const id = `${panelId}\u0000${scope}`;
      let store = stores.get(id);
      if (!store) {
        store = {
          get: <T>(key: string): T | undefined => state.panels[panelId]?.[scope]?.[key] as T | undefined,
          set(key, value) {
            const copy = jsonCopy(value);
            const values = { ...state.panels[panelId]?.[scope] };
            if (copy === undefined) delete values[key];
            else values[key] = copy;
            state.panels[panelId] = { ...state.panels[panelId], [scope]: values };
            changed();
          },
        };
        stores.set(id, store);
      }
      return store;
    },
    flush: save,
    snapshot: () => state,
    isFresh: () => fresh,
  };
}
