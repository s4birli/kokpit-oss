import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver } from "../test-utils/fake-view.ts";
import { defaultLayoutConfig } from "./config.ts";
import { addPanelAt, applySizes, buildDefault, isRestorable, restoreLayout, serializeLayout } from "./dock.ts";
import { PANELS } from "./registry.ts";

function fakeApi(width: number, height: number) {
  const setSize = vi.fn();
  const api = { width, height, getPanel: (id: string) => (id === "terminals" || id === "files" ? { group: { api: { setSize } } } : undefined) };
  return { api: api as unknown as DockviewApi, setSize };
}

const layout = { panels: [], sizes: [{ id: "files" as const, width: 0.2 }, { id: "terminals" as const, height: 0.5 }, { id: "map" as const, width: 0.3 }] };

describe("applySizes", () => {
  it("waits while the dock has no size", () => {
    const { api, setSize } = fakeApi(0, 0);
    expect(applySizes(api, layout)).toBe(false);
    expect(setSize).not.toHaveBeenCalled();
  });

  it("gives each open panel's group its share; missing panels are skipped", () => {
    const { api, setSize } = fakeApi(1000, 800);
    expect(applySizes(api, layout)).toBe(true);
    expect(setSize.mock.calls).toEqual([[{ width: 200 }], [{ height: 400 }]]);
  });
});

describe("isRestorable", () => {
  const leaf = (...views: unknown[]) => ({ type: "leaf", data: { views } });
  const branch = (...data: unknown[]) => ({ type: "branch", data });
  const panel = (id: string) => ({ id, contentComponent: id });
  const ok = { grid: { root: branch(leaf("files")) }, panels: { files: panel("files") } };
  it("accepts our own panels only", () => {
    expect(isRestorable(ok, PANELS)).toBe(true);
    expect(isRestorable({ ...ok, panels: { x: { id: "x", contentComponent: "x" } } }, PANELS)).toBe(false);
    expect(isRestorable({ ...ok, panels: { files: { id: "browser", contentComponent: "files" } } }, PANELS)).toBe(false);
  });
  it("rejects floating/popout groups and wrong shapes", () => {
    expect(isRestorable({ ...ok, floatingGroups: [{}] }, PANELS)).toBe(false);
    expect(isRestorable({ ...ok, popoutGroups: [{}] }, PANELS)).toBe(false);
    expect(isRestorable({ ...ok, grid: [] }, PANELS)).toBe(false);
    expect(isRestorable(null, PANELS)).toBe(false);
  });
  it("İş D: the grid and the panel list must agree (a stored layout is untrusted)", () => {
    const two = { files: panel("files"), browser: panel("browser") };
    expect(isRestorable({ grid: { root: branch(leaf("files"), branch(leaf("browser"))) }, panels: two }, PANELS)).toBe(true);
    // Every panel closed is a layout too.
    expect(isRestorable({ grid: { root: branch() }, panels: {} }, PANELS)).toBe(true);
    for (const root of [
      leaf("files", "browser"), // dockview's root is always a branch
      branch(leaf("files")), // a panel that is in no group
      branch(leaf("files", "browser", "agents")), // a view without a panel
      branch(leaf("files", "browser"), leaf("files")), // a panel in two groups
      branch(leaf("files", 7), leaf("browser")),
      branch(leaf("files"), { type: "nonsense", data: { views: ["browser"] } }),
      branch(leaf("files"), { type: "leaf", data: "browser" }),
      branch(leaf("files"), { type: "branch", data: "browser" }),
      branch("files", "browser"),
    ]) {
      expect(isRestorable({ grid: { root }, panels: two }, PANELS)).toBe(false);
    }
    // Absurd nesting is refused instead of walked.
    let deep: unknown = leaf("files", "browser");
    for (let i = 0; i < 200; i++) deep = branch(deep);
    expect(isRestorable({ grid: { root: deep }, panels: two }, PANELS)).toBe(false);
  });
});


// D1: dockview writes each group's size with the gap between groups already taken off, and reads that number back
// as the size before the gap is taken off — so a layout that went through toJSON → fromJSON was a little different
// every time, and a project switch (restore + save) moved a resized panel by a pixel per visit.
describe("serializeLayout: saving and restoring a layout changes nothing", () => {
  const ROUND_TRIPS = 30;
  const DOCK = { width: 1385, height: 811 };
  const normal = defaultLayoutConfig.defaults.normal;
  const docks: DockviewApi[] = [];

  function dock(gap: number): DockviewApi {
    const api = createDockview(document.createElement("div"), {
      createComponent: () => ({ element: document.createElement("div"), init: () => {} }),
      disableFloatingGroups: true,
      theme: { name: "test", className: "test", gap },
    });
    api.layout(DOCK.width, DOCK.height);
    docks.push(api);
    return api;
  }
  /** Width and height of every panel's group, as rendered. */
  const rendered = (api: DockviewApi) => Object.fromEntries(api.panels.map((p) => [p.id, [p.group.api.width, p.group.api.height]]));

  beforeEach(() => vi.stubGlobal("ResizeObserver", FakeResizeObserver));
  afterEach(() => {
    for (const api of docks.splice(0)) api.dispose();
    vi.unstubAllGlobals();
  });

  for (const gap of [0, defaultLayoutConfig.gap, 7]) {
    it(`${ROUND_TRIPS} switches between a resized and a default layout leave both exactly as they were (gap ${gap})`, () => {
      const api = dock(gap);
      buildDefault(api, normal, PANELS);
      const plain = serializeLayout(api, gap);
      const plainRendered = rendered(api);
      // The user's arrangement: sashes dragged to odd sizes, a panel added in a nested split.
      api.getPanel("terminals")!.group.api.setSize({ height: 437 });
      api.getPanel("files")!.group.api.setSize({ width: 251 });
      addPanelAt(api, PANELS.find((p) => p.id === "map")!, { near: ["terminals"], direction: "right" });
      api.getPanel("map")!.group.api.setSize({ width: 333 });
      const dragged = serializeLayout(api, gap);
      const draggedRendered = rendered(api);
      // An odd gap can leave half pixels, which dockview rounds once when it loads them: the first restore may move
      // a group by less than a pixel, and from then on nothing moves at all. With the app's own gap it is exact.
      expect(restoreLayout(api, dragged, normal, PANELS)).toBe(true);
      const resized = serializeLayout(api, gap);
      const resizedRendered = rendered(api);
      for (const [id, [width, height]] of Object.entries(draggedRendered)) {
        expect(Math.abs(resizedRendered[id]![0]! - width!)).toBeLessThanOrEqual(1);
        expect(Math.abs(resizedRendered[id]![1]! - height!)).toBeLessThanOrEqual(1);
      }
      if (gap === defaultLayoutConfig.gap) expect(resized).toEqual(dragged);

      for (let i = 0; i < ROUND_TRIPS; i++) {
        expect(restoreLayout(api, plain, normal, PANELS)).toBe(true);
        expect(serializeLayout(api, gap)).toEqual(plain);
        expect(rendered(api)).toEqual(plainRendered);
        expect(restoreLayout(api, resized, normal, PANELS)).toBe(true);
        expect(serializeLayout(api, gap)).toEqual(resized);
        expect(rendered(api)).toEqual(resizedRendered);
      }
    });
  }

  it("the sizes it stores add up to the dock: the gaps belong to the groups, they are not lost", () => {
    const gap = defaultLayoutConfig.gap;
    const api = dock(gap);
    buildDefault(api, normal, PANELS);
    const saved = serializeLayout(api, gap) as unknown as { grid: { root: { data: [{ size: number; data: { size: number }[] }, { size: number }] } } };
    const [top, bottom] = saved.grid.root.data;
    expect(top.size + bottom.size).toBe(DOCK.height);
    expect(top.data.reduce((sum, child) => sum + child.size, 0)).toBe(DOCK.width);
  });
});
