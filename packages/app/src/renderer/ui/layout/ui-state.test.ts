// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeUiStateBridge as fakeBridge } from "../test-utils/fake-ui-state.ts";
import { readFileSync } from "node:fs";
import { UI_STATE_LIMITS, UI_STATE_VERSION } from "../../engine/ui-state-ipc.ts";
import { createUiStateStore, emptyUiState, layoutOwnerOf, NO_PROJECT_OWNER, parseUiState, scopeOf } from "./ui-state.ts";

/** A real file written by the last version with one global layout (v1): Ajanlar closed, Harita + Web open. */
const V1_FIXTURE: unknown = JSON.parse(readFileSync(new URL("./fixtures/ui-state-v1.json", import.meta.url), "utf8"));
const P1 = layoutOwnerOf("p1");
const P2 = layoutOwnerOf("p2");

const DEBOUNCE = 50;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("parseUiState", () => {
  it.each([
    ["null", null],
    ["garbage", "x"],
    ["wrong version", { version: 99, layouts: {}, panels: {}, selection: null }],
    ["array", [1]],
  ])("%s → defaults", (_n, raw) => {
    expect(parseUiState(raw)).toEqual(emptyUiState());
  });

  it("drops malformed parts and keeps the valid ones", () => {
    const parsed = parseUiState({
      version: 1,
      layouts: { normal: { grid: {} }, bogus: "bad", other: { grid: {} } },
      panels: { terminals: { "project:p1": { order: ["a"] }, "card:c": "bad" }, nope: 3 },
      selection: { kind: "card", cardId: 7 },
    });
    expect(parsed).toEqual({
      version: UI_STATE_VERSION,
      layouts: { inherited: { normal: { grid: {} } }, projects: {} },
      panels: { terminals: { "project:p1": { order: ["a"] } } },
      selection: null,
    });
  });

  it("keeps a valid selection", () => {
    expect(parseUiState({ version: 1, layouts: {}, panels: {}, selection: { kind: "project", projectId: "p" } }).selection).toEqual({
      kind: "project",
      projectId: "p",
    });
  });
});

describe("scopeOf", () => {
  it("card wins over project; nothing selected is its own scope", () => {
    expect(scopeOf("p", "c")).toBe("card:c");
    expect(scopeOf("p", undefined)).toBe("project:p");
    expect(scopeOf(undefined, undefined)).toBe("none");
  });
});

describe("createUiStateStore", () => {
  it("İş M: isFresh is true only when nothing valid was saved (first launch)", async () => {
    for (const [raw, fresh] of [
      [null, true],
      ["x", true],
      [{ version: 99, layouts: {}, panels: {}, selection: null }, true],
      [{ version: 1, layouts: {}, panels: {}, selection: null }, false],
      [{ version: UI_STATE_VERSION, layouts: { inherited: {}, projects: {} }, panels: {}, selection: null }, false],
      [V1_FIXTURE, false],
    ] as const) {
      const store = createUiStateStore({ bridge: fakeBridge(raw), saveDebounceMs: DEBOUNCE });
      await store.load();
      expect(store.isFresh()).toBe(fresh);
    }
  });

  it("round-trips layout, selection and panel state through the bridge (debounced)", async () => {
    const bridge = fakeBridge();
    const a = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    await a.load();
    a.setLayout(P1, "normal", { grid: { x: 1 } });
    a.setSelection({ kind: "card", cardId: "c1" });
    a.panelState("terminals", "card:c1").set("active", "t2");
    a.panelState("terminals", "card:c1").set("active", "t3");
    expect(bridge.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(bridge.save).toHaveBeenCalledTimes(1);

    const b = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    await b.load();
    expect(b.getLayout(P1, "normal")).toEqual({ grid: { x: 1 } });
    expect(b.getLayout(P2, "normal")).toBeUndefined();
    expect(b.getSelection()).toEqual({ kind: "card", cardId: "c1" });
    expect(b.panelState("terminals", "card:c1").get("active")).toBe("t3");
  });

  it("panel state is scoped per panel and per project/card", async () => {
    const s = createUiStateStore({ bridge: null, saveDebounceMs: DEBOUNCE });
    await s.load();
    s.panelState("terminals", "project:p1").set("k", 1);
    s.panelState("terminals", "card:c1").set("k", 2);
    s.panelState("browser", "project:p1").set("k", 3);
    expect(s.panelState("terminals", "project:p1").get("k")).toBe(1);
    expect(s.panelState("terminals", "card:c1").get("k")).toBe(2);
    expect(s.panelState("browser", "project:p1").get("k")).toBe(3);
    expect(s.panelState("browser", "project:p2").get("k")).toBeUndefined();
    // Same object for the same scope (stable for effects).
    expect(s.panelState("terminals", "project:p1")).toBe(s.panelState("terminals", "project:p1"));
  });

  it("stores a JSON snapshot; undefined removes the key", async () => {
    const s = createUiStateStore({ bridge: null, saveDebounceMs: DEBOUNCE });
    await s.load();
    const st = s.panelState("files", "none");
    const value = { open: ["a"] };
    st.set("tree", value);
    value.open.push("b");
    expect(st.get("tree")).toEqual({ open: ["a"] });
    st.set("tree", undefined);
    expect(st.get("tree")).toBeUndefined();
    expect(() => st.set("bad", () => 1)).not.toThrow();
    expect(st.get("bad")).toBeUndefined();
  });

  it("a corrupt or failing load falls back to defaults and still saves", async () => {
    const bridge = fakeBridge({ version: 1, layouts: 5 });
    const s = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    await s.load();
    expect(s.snapshot()).toEqual(emptyUiState());

    const failing = fakeBridge();
    failing.load.mockRejectedValueOnce(new Error("boom"));
    const t = createUiStateStore({ bridge: failing, saveDebounceMs: DEBOUNCE });
    await t.load();
    expect(t.getSelection()).toBeNull();
    t.setSelection({ kind: "project", projectId: "p" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(failing.saved).toHaveLength(1);
  });

  it("never saves before the load finished (would overwrite the file with defaults)", async () => {
    const bridge = fakeBridge({ version: 1, layouts: {}, panels: {}, selection: { kind: "project", projectId: "keep" } });
    let release!: () => void;
    bridge.load.mockImplementationOnce(() => new Promise((r) => (release = () => r(bridge.stored))));
    const s = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    const loading = s.load();
    s.panelState("files", "none").set("x", 1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(bridge.save).not.toHaveBeenCalled();
    release();
    await loading;
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(bridge.saved.at(-1)).toMatchObject({ selection: { kind: "project", projectId: "keep" }, panels: { files: { none: { x: 1 } } } });
  });

  it("flush saves immediately; a failing save is swallowed", async () => {
    const bridge = fakeBridge();
    bridge.save.mockRejectedValueOnce(new Error("disk full"));
    const s = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    await s.load();
    s.setSelection(null);
    await expect(s.flush()).resolves.toBeUndefined();
    s.setLayout(P1, "normal", { grid: {} });
    await s.flush();
    expect(bridge.saved).toHaveLength(1);
  });
});

describe("İş P: proje sekmeleri ve daraltılmış sol liste", () => {
  it("round-trips open tabs (order, active, card) and the collapsed rail", async () => {
    const bridge = fakeBridge();
    const a = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    await a.load();
    expect(a.getTabs()).toBeUndefined();
    expect(a.getRailCollapsed()).toBe(false);
    const tabs = { tabs: [{ projectId: "b" }, { projectId: "a", cardId: "k" }], active: "a" };
    a.setTabs(tabs);
    a.setRailCollapsed(true);
    await a.flush();

    const b = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    await b.load();
    expect(b.getTabs()).toEqual(tabs);
    expect(b.getRailCollapsed()).toBe(true);
  });

  it("malformed tabs and rail values are dropped; older files without them still load", () => {
    const base = { version: 1, layouts: {}, panels: {}, selection: null };
    const parsed = parseUiState({ ...base, tabs: { tabs: [{ projectId: 3 }, { projectId: "a" }], active: "x" }, railCollapsed: "yes" });
    expect(parsed.tabs).toEqual({ tabs: [{ projectId: "a" }], active: "a" });
    expect(parsed.railCollapsed).toBeUndefined();
    expect(parseUiState({ ...base, tabs: "bad" }).tabs).toBeUndefined();
  });

  it("tabs set while loading win over the file", async () => {
    const bridge = fakeBridge({ version: 1, layouts: {}, panels: {}, selection: null, tabs: { tabs: [{ projectId: "old" }], active: "old" } });
    let release!: () => void;
    bridge.load.mockImplementationOnce(() => new Promise((r) => (release = () => r(bridge.stored))));
    const s = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    const loading = s.load();
    s.setTabs({ tabs: [{ projectId: "new" }], active: "new" });
    release();
    await loading;
    expect(s.getTabs()).toEqual({ tabs: [{ projectId: "new" }], active: "new" });
  });
});

describe("İş D: proje başına düzen", () => {
  const big = (bytes: number) => ({ grid: { pad: "x".repeat(bytes) } });

  it("layouts are kept per owner (project or no project) and per kind", async () => {
    const s = createUiStateStore({ bridge: null, saveDebounceMs: DEBOUNCE });
    await s.load();
    expect(layoutOwnerOf(undefined)).toBe(NO_PROJECT_OWNER);
    expect(P1).not.toBe(P2);
    s.setLayout(P1, "normal", { grid: { a: 1 } });
    s.setLayout(P2, "normal", { grid: { b: 2 } });
    s.setLayout(NO_PROJECT_OWNER, "normal", { grid: { c: 3 } });
    expect(s.getLayout(P1, "normal")).toEqual({ grid: { a: 1 } });
    expect(s.getLayout(P2, "normal")).toEqual({ grid: { b: 2 } });
    expect(s.getLayout(NO_PROJECT_OWNER, "normal")).toEqual({ grid: { c: 3 } });
    s.setLayout(P1, "normal", undefined);
    expect(s.getLayout(P1, "normal")).toBeUndefined();
  });

  it("göç: a real v1 file — its one layout is what every project starts from; nothing else is lost", async () => {
    const v1 = V1_FIXTURE as { version: number; layouts: { normal: unknown }; panels: unknown; selection: unknown; tabs: unknown };
    expect(v1.version).toBe(1);
    const bridge = fakeBridge(JSON.parse(JSON.stringify(v1)));
    const s = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    await s.load();
    expect(s.isFresh()).toBe(false);
    for (const owner of [P1, P2, layoutOwnerOf("yepyeni"), NO_PROJECT_OWNER]) expect(s.getLayout(owner, "normal")).toEqual(v1.layouts.normal);
    expect(s.snapshot().panels).toEqual(v1.panels);
    expect(s.getSelection()).toEqual(v1.selection);
    expect(s.getTabs()).toEqual(v1.tabs);

    // One project changes its layout: the others still start from the old one, also after a restart.
    s.setLayout(P1, "normal", { grid: { mine: true } });
    await s.flush();
    expect(bridge.stored).toMatchObject({
      version: UI_STATE_VERSION,
      layouts: { inherited: { normal: v1.layouts.normal }, projects: { [P1]: { normal: { grid: { mine: true } } } } },
      panels: v1.panels,
    });
    const again = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    await again.load();
    expect(again.getLayout(P1, "normal")).toEqual({ grid: { mine: true } });
    expect(again.getLayout(P2, "normal")).toEqual(v1.layouts.normal);
    // Clearing a project's own layout gives it the inherited one back.
    again.setLayout(P1, "normal", undefined);
    expect(again.getLayout(P1, "normal")).toEqual(v1.layouts.normal);
  });

  it("retainLayouts drops the layouts of projects that no longer exist; no-project and inherited stay", async () => {
    const bridge = fakeBridge(JSON.parse(JSON.stringify(V1_FIXTURE)));
    const s = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    await s.load();
    s.setLayout(P1, "normal", { grid: { a: 1 } });
    s.setLayout(P2, "normal", { grid: { b: 2 } });
    s.setLayout(NO_PROJECT_OWNER, "normal", { grid: { c: 3 } });
    await s.flush();
    const saves = bridge.saved.length;
    s.retainLayouts(new Set(["p1", "p2"]));
    await s.flush();
    expect(bridge.saved).toHaveLength(saves); // nothing to drop: nothing to save
    s.retainLayouts(new Set(["p1"]));
    await s.flush();
    expect(Object.keys((bridge.stored as { layouts: { projects: object } }).layouts.projects).sort()).toEqual([NO_PROJECT_OWNER, P1].sort());
    // A project created later under the same id starts from the inherited layout, not the deleted one's.
    expect(s.getLayout(P2, "normal")).toEqual((V1_FIXTURE as { layouts: { normal: unknown } }).layouts.normal);
  });

  it("size bounds: an oversized layout is not stored; the least recently changed projects are dropped over the cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limits = { ...UI_STATE_LIMITS, maxLayoutBytes: 200, maxProjectLayouts: 3 };
    const s = createUiStateStore({ bridge: null, saveDebounceMs: DEBOUNCE, limits });
    await s.load();
    s.setLayout(P1, "normal", { grid: { ok: 1 } });
    s.setLayout(P1, "normal", big(500));
    expect(s.getLayout(P1, "normal")).toEqual({ grid: { ok: 1 } });
    expect(warn).toHaveBeenCalled();
    for (const id of ["a", "b", "c"]) s.setLayout(layoutOwnerOf(id), "normal", { grid: { id } });
    expect(s.getLayout(P1, "normal")).toBeUndefined();
    s.setLayout(layoutOwnerOf("a"), "normal", { grid: { id: "a2" } }); // "a" is now the most recent
    s.setLayout(layoutOwnerOf("d"), "normal", { grid: { id: "d" } });
    expect(Object.keys(s.snapshot().layouts.projects)).toEqual([layoutOwnerOf("c"), layoutOwnerOf("a"), layoutOwnerOf("d")]);
    warn.mockRestore();
  });

  it("parse: garbage per-project layouts are dropped, oversized ones too, and the cap holds", () => {
    const limits = { ...UI_STATE_LIMITS, maxLayoutBytes: 200, maxProjectLayouts: 2 };
    const parsed = parseUiState(
      {
        version: UI_STATE_VERSION,
        layouts: {
          inherited: { normal: { grid: { i: 1 } }, bogus: 7, evil: { grid: {} } },
          projects: {
            [P1]: { normal: { grid: { a: 1 } }, bogus: "x", other: { grid: {} } },
            bad: "string",
            arr: [1, 2],
            empty: {},
            [P2]: { normal: big(500) },
            [layoutOwnerOf("p3")]: { normal: { grid: { c: 3 } } },
            [layoutOwnerOf("p4")]: { normal: { grid: { d: 4 } } },
          },
        },
        panels: {},
        selection: null,
      },
      limits,
    );
    expect(parsed.layouts).toEqual({
      inherited: { normal: { grid: { i: 1 } } },
      projects: { [layoutOwnerOf("p3")]: { normal: { grid: { c: 3 } } }, [layoutOwnerOf("p4")]: { normal: { grid: { d: 4 } } } },
    });
    for (const layouts of [null, 5, [], { inherited: [], projects: "x" }, { projects: null }]) {
      expect(parseUiState({ version: UI_STATE_VERSION, layouts, panels: {}, selection: null }).layouts).toEqual({ inherited: {}, projects: {} });
    }
  });

  it("layouts set while loading win over the file", async () => {
    const bridge = fakeBridge({
      version: UI_STATE_VERSION,
      layouts: { inherited: {}, projects: { [P1]: { normal: { grid: { old: 1 } } }, [P2]: { normal: { grid: { keep: 1 } } } } },
      panels: {},
      selection: null,
    });
    const s = createUiStateStore({ bridge, saveDebounceMs: DEBOUNCE });
    s.setLayout(P1, "normal", { grid: { fresh: 1 } });
    await s.load();
    expect(s.getLayout(P1, "normal")).toEqual({ grid: { fresh: 1 } });
    expect(s.getLayout(P2, "normal")).toEqual({ grid: { keep: 1 } });
  });
});
