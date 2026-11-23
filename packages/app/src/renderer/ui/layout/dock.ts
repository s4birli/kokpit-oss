// İş L: layout operations on the dockview API — kept apart from React so the host stays small.
import { createDockview, type DockviewApi, type SerializedDockview } from "dockview-react";
import type { DefaultLayout, Placement } from "./config.ts";
import type { PanelDefinition } from "./contract.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Adds `def` next to the first open panel of `placement.near`, else at the dock's edge. */
export function addPanelAt(api: DockviewApi, def: PanelDefinition, placement: Placement): void {
  const reference = placement.near.find((id) => api.getPanel(id) !== undefined);
  const base = { id: def.id, component: def.id, title: def.title };
  if (reference !== undefined) {
    api.addPanel({ ...base, position: { referencePanel: reference, direction: placement.direction } });
  } else if (placement.direction === "within" || api.panels.length === 0) {
    api.addPanel(base);
  } else {
    api.addPanel({ ...base, position: { direction: placement.direction } });
  }
  growGroup(api, def.id, placement.minSize);
}

/** Grows the group of panel `id` to `minSize` (fractions of the dock); never shrinks it. Nothing while unmeasured. */
function growGroup(api: DockviewApi, id: string, minSize: Placement["minSize"]): void {
  const group = api.getPanel(id)?.group;
  if (!group || !minSize || api.width <= 0 || api.height <= 0) return;
  const width = minSize.width === undefined ? undefined : Math.round(api.width * minSize.width);
  const height = minSize.height === undefined ? undefined : Math.round(api.height * minSize.height);
  if (width !== undefined && group.api.width < width) group.api.setSize({ width });
  if (height !== undefined && group.api.height < height) group.api.setSize({ height });
}

/** Builds `layout` into an empty dock, sizes included when the dock is measured (see applySizes). */
export function buildDefault(api: DockviewApi, layout: DefaultLayout, defs: readonly PanelDefinition[]): void {
  for (const entry of layout.panels) {
    const def = defs.find((d) => d.id === entry.id);
    if (def) addPanelAt(api, def, entry.placement ?? { near: [], direction: "right" });
  }
  applySizes(api, layout);
}

/** Gives the default layout's groups their share of the dock. False (nothing done) while the dock has no size yet. */
export function applySizes(api: DockviewApi, layout: DefaultLayout): boolean {
  if (api.width <= 0 || api.height <= 0) return false;
  for (const size of layout.sizes ?? []) {
    const group = api.getPanel(size.id)?.group;
    if (!group) continue;
    if (size.width !== undefined) group.api.setSize({ width: Math.round(api.width * size.width) });
    if (size.height !== undefined) group.api.setSize({ height: Math.round(api.height * size.height) });
  }
  return true;
}

/**
 * İş D: the default layout as dockview's own JSON, built in a throwaway dock of the real dock's size that is never
 * attached to the page. Loading that JSON moves the panels that are already open instead of recreating them, which
 * clearing the dock and adding the defaults one by one cannot do. Null when it cannot be built.
 */
export function serializeDefault(layout: DefaultLayout, defs: readonly PanelDefinition[], size: { width: number; height: number }): SerializedDockview | null {
  let scratch: DockviewApi | undefined;
  try {
    scratch = createDockview(document.createElement("div"), {
      createComponent: () => ({ element: document.createElement("div"), init: () => {} }),
      disableFloatingGroups: true,
    });
    if (size.width > 0 && size.height > 0) scratch.layout(size.width, size.height);
    buildDefault(scratch, layout, defs);
    return scratch.toJSON();
  } catch {
    return null;
  } finally {
    scratch?.dispose();
  }
}

/** Sizes are stored to this many decimals: enough for thirds of a pixel, none of the float noise. */
const SIZE_DECIMALS = 3;

/**
 * The dock's layout as JSON that restores to exactly what is on screen (D1).
 * dockview writes each child of a split with the gap between groups already taken off (`n` children share `n - 1`
 * gaps, each gives up `gap * (n - 1) / n`), but reads that number back as the size before the gap is taken off. Its
 * own JSON therefore restores to a slightly different layout, and each save → restore moved a resized panel a
 * little further. Here every visible child gets its share of the gaps back, so the children of a split add up to
 * the split again and loading the result is exact. `gap` is the theme's gap the dock was created with.
 */
export function serializeLayout(api: DockviewApi, gap: number): SerializedDockview {
  const json = api.toJSON();
  if (gap === 0) return json;
  const scale = 10 ** SIZE_DECIMALS;
  const visible = (n: unknown): boolean => isRecord(n) && n.visible !== false;
  const node = (n: unknown): unknown => {
    if (!isRecord(n) || n.type !== "branch" || !Array.isArray(n.data)) return n;
    const count = n.data.filter(visible).length;
    const share = count > 1 ? (gap * (count - 1)) / count : 0;
    const data = n.data.map((child) => {
      const next = node(child);
      if (!isRecord(next) || !visible(next) || typeof next.size !== "number") return next;
      return { ...next, size: Math.round((next.size + share) * scale) / scale };
    });
    return { ...n, data };
  };
  return { ...json, grid: { ...json.grid, root: node(json.grid.root) as SerializedDockview["grid"]["root"] } };
}

/** Loads a serialized layout, keeping the panels that are already open; titles come from the registry. */
function load(api: DockviewApi, layout: SerializedDockview, defs: readonly PanelDefinition[]): boolean {
  try {
    api.fromJSON(layout, { reuseExistingPanels: true });
    for (const panel of api.panels) {
      const def = defs.find((d) => d.id === panel.id);
      if (def) panel.api.setTitle(def.title);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The panel ids in the groups of a serialized grid, in order; null when the tree is not one dockview can build (a
 * node that is neither branch nor leaf, views that are not ids) or is nested deeper than any real layout: every
 * split adds at most one level, so a dock of `maxPanels` panels is never deeper than that.
 */
function gridViews(root: unknown, maxPanels: number): string[] | null {
  const views: string[] = [];
  const walk = (node: unknown, depth: number): boolean => {
    if (!isRecord(node) || depth > maxPanels + 1) return false;
    if (node.type === "branch") return Array.isArray(node.data) && node.data.every((child) => walk(child, depth + 1));
    if (node.type !== "leaf" || !isRecord(node.data) || !Array.isArray(node.data.views)) return false;
    for (const view of node.data.views) {
      if (typeof view !== "string") return false;
      views.push(view);
    }
    return true;
  };
  return isRecord(root) && root.type === "branch" && walk(root, 0) ? views : null;
}

/**
 * A saved layout we are willing to hand to dockview: right shape, only our panels, each of them in exactly one group
 * of the grid, no floating/popout groups. Stored layouts are untrusted (İş D: one per project, any of them may be
 * damaged); what fails here gets the default layout.
 */
export function isRestorable(saved: unknown, defs: readonly PanelDefinition[]): saved is SerializedDockview {
  if (!isRecord(saved) || !isRecord(saved.grid) || !isRecord(saved.grid.root) || !isRecord(saved.panels)) return false;
  if ((Array.isArray(saved.floatingGroups) && saved.floatingGroups.length > 0) || (Array.isArray(saved.popoutGroups) && saved.popoutGroups.length > 0)) {
    return false;
  }
  const ids = Object.keys(saved.panels);
  const known = Object.entries(saved.panels).every(
    ([id, p]) => isRecord(p) && p.id === id && p.contentComponent === id && defs.some((d) => d.id === id),
  );
  if (!known) return false;
  const views = gridViews(saved.grid.root, defs.length);
  return views !== null && views.length === ids.length && ids.every((id) => views.includes(id));
}

/** Panel ids that were renamed: a layout saved under the old id keeps its place under the new one. */
export const RENAMED_PANELS: Readonly<Record<string, string>> = {};

/**
 * A saved layout with renamed panel ids rewritten (panel map keys, ids, components, and the grid's view lists),
 * so an app update never throws the user's arrangement away. Anything that is not a layout is returned as is.
 */
export function migratePanelIds(saved: unknown, renamed: Readonly<Record<string, string>> = RENAMED_PANELS): unknown {
  if (!isRecord(saved) || !isRecord(saved.panels)) return saved;
  const name = (id: unknown): unknown => (typeof id === "string" && Object.hasOwn(renamed, id) ? renamed[id] : id);
  if (!Object.keys(saved.panels).some((id) => Object.hasOwn(renamed, id))) return saved;
  const panels: Record<string, unknown> = {};
  for (const [id, p] of Object.entries(saved.panels)) {
    const next = name(id) as string;
    // The new id already has a panel: the old entry is dropped rather than overwriting it.
    if (next !== id && Object.hasOwn(saved.panels, next)) continue;
    panels[next] = isRecord(p) ? { ...p, id: name(p.id), contentComponent: name(p.contentComponent) } : p;
  }
  const node = (n: unknown): unknown => {
    if (!isRecord(n)) return n;
    if (Array.isArray(n.data)) return { ...n, data: n.data.map(node) };
    if (isRecord(n.data) && Array.isArray(n.data.views)) {
      const views = [...new Set(n.data.views.map(name))];
      return { ...n, data: { ...n.data, views, activeView: name(n.data.activeView) } };
    }
    return n;
  };
  const grid = isRecord(saved.grid) ? { ...saved.grid, root: node(saved.grid.root) } : saved.grid;
  return { ...saved, grid, panels, activePanel: name(saved.activePanel) };
}

/**
 * Replaces the dock's content with `saved` (when restorable) or the default layout. Titles always come from the
 * registry, so a renamed panel shows its new name after restart. Returns whether the saved layout was used.
 * İş D: panels that are open now and also in the new layout are moved, not recreated — their React tree (a global
 * panel's content, a native view's placeholder) stays mounted across a project switch.
 */
export function restoreLayout(api: DockviewApi, stored: unknown, fallback: DefaultLayout, defs: readonly PanelDefinition[]): boolean {
  const saved = migratePanelIds(stored);
  if (isRestorable(saved, defs) && load(api, saved, defs)) return true;
  // Corrupt or absent: the default. An empty dock is simply built; a dock that already shows panels (project
  // switch, Varsayılan düzen) gets the default as JSON so those panels are kept.
  const json = api.panels.length > 0 ? serializeDefault(fallback, defs, api) : null;
  if (json && load(api, json, defs)) return false;
  api.clear();
  buildDefault(api, fallback, defs);
  return false;
}
