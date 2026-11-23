import { describe, expect, it } from "vitest";
import { clampRatio, EMPTY_PREFS, moveTab, neighbourOf, readPrefs, reconcileTabs, type TabPrefs } from "./terminal-tabs.ts";

const prefs = (p: Partial<TabPrefs>): TabPrefs => ({ ...EMPTY_PREFS, ...p });

describe("reconcileTabs", () => {
  it("keeps the saved order, drops unknown ids, appends new terminals in engine order", () => {
    const r = reconcileTabs(prefs({ order: ["c", "gone", "a"] }), ["a", "b", "c", "d"]);
    expect(r.order).toEqual(["c", "a", "b", "d"]);
  });

  it("falls back to the first tab when the active one is unknown", () => {
    expect(reconcileTabs(prefs({ active: "gone" }), ["a", "b"]).active).toBe("a");
    expect(reconcileTabs(prefs({ active: "b" }), ["a", "b"]).active).toBe("b");
    expect(reconcileTabs(prefs({ active: "a" }), []).active).toBeNull();
  });

  it("drops a split partner that is gone or equal to the active tab", () => {
    expect(reconcileTabs(prefs({ active: "a", split: "b" }), ["a", "b"]).split).toBe("b");
    expect(reconcileTabs(prefs({ active: "a", split: "gone" }), ["a", "b"]).split).toBeNull();
    expect(reconcileTabs(prefs({ active: "a", split: "a" }), ["a", "b"]).split).toBeNull();
  });

  it("ignores duplicate ids", () => {
    expect(reconcileTabs(prefs({ order: ["a", "a", "b"] }), ["b", "a", "a"]).order).toEqual(["a", "b"]);
  });
});

describe("readPrefs", () => {
  it("reads well-formed values", () => {
    expect(readPrefs({ order: ["a", "b"], active: "b", split: "a", ratio: 0.3 })).toEqual({
      order: ["a", "b"],
      active: "b",
      split: "a",
      ratio: 0.3,
    });
  });

  it.each([undefined, null, 42, "x", [], { order: "a" }, { order: [1, null, "a"], active: 3, split: {}, ratio: "x" }])(
    "survives malformed input %#",
    (raw) => {
      const p = readPrefs(raw);
      expect(Array.isArray(p.order)).toBe(true);
      expect(p.order.every((x) => typeof x === "string")).toBe(true);
      expect(p.active === null || typeof p.active === "string").toBe(true);
      expect(p.split === null || typeof p.split === "string").toBe(true);
      expect(p.ratio === null || Number.isFinite(p.ratio)).toBe(true);
    },
  );

  it("drops non-finite ratios", () => {
    expect(readPrefs({ ratio: Number.NaN }).ratio).toBeNull();
    expect(readPrefs({ ratio: Infinity }).ratio).toBeNull();
  });
});

describe("neighbourOf", () => {
  it("prefers the tab to the right, then the left", () => {
    expect(neighbourOf(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourOf(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourOf(["a"], "a")).toBeNull();
    expect(neighbourOf(["a"], "x")).toBe("a");
  });
});

describe("moveTab", () => {
  it("moves a tab before another", () => {
    expect(moveTab(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveTab(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(moveTab(["a", "b", "c"], "a", "a")).toEqual(["a", "b", "c"]);
    expect(moveTab(["a", "b"], "x", "a")).toEqual(["a", "b"]);
  });
});

describe("clampRatio", () => {
  it("keeps the ratio inside [min, 1 - min]", () => {
    expect(clampRatio(0.05, 0.2)).toBe(0.2);
    expect(clampRatio(0.95, 0.2)).toBe(0.8);
    expect(clampRatio(0.5, 0.2)).toBe(0.5);
    expect(clampRatio(Number.NaN, 0.2)).toBe(0.5);
  });
});
