// İş Z: pure parts of the page zoom — the device-metrics override that makes the page render zoomed.
import { describe, expect, it } from "vitest";
import { BROWSER_LIMITS } from "@kokpit/shared";
import { decideZoom, mergeScreencast, panelOverride, zoomOverride } from "./browser.ts";

describe("zoomOverride", () => {
  it("1 = no override; otherwise the page gets window px / zoom CSS px, device scale untouched", () => {
    expect(zoomOverride({ width: 1280, height: 800 }, 1)).toBeNull();
    expect(zoomOverride({ width: 1280, height: 800 }, 0.8)).toEqual({ width: 1600, height: 1000, deviceScaleFactor: 0, mobile: false });
    expect(zoomOverride({ width: 1280, height: 800 }, 1.25)).toEqual({ width: 1024, height: 640, deviceScaleFactor: 0, mobile: false });
    expect(zoomOverride({ width: 1000, height: 700 }, 0.67)).toEqual({ width: 1493, height: 1045, deviceScaleFactor: 0, mobile: false });
  });

  it("unusable input gives no override (never a broken viewport)", () => {
    const cases: Array<[{ width: number; height: number }, number]> = [
      [{ width: 0, height: 800 }, 0.8],
      [{ width: Number.NaN, height: 800 }, 0.8],
      [{ width: 1280, height: -1 }, 0.8],
      [{ width: 1280, height: 800 }, 0],
      [{ width: 1280, height: 800 }, Number.POSITIVE_INFINITY],
      [{ width: 1280, height: 800 }, -2],
    ];
    for (const [vp, z] of cases) expect(zoomOverride(vp, z), JSON.stringify([vp, z])).toBeNull();
  });

  it("monkey: width/height stay whole and positive", () => {
    for (let i = 0; i < 500; i++) {
      const vp = { width: 1 + ((i * 7919) % 5000), height: 1 + ((i * 104729) % 3000) };
      const z = 0.25 + ((i * 31) % 476) / 100;
      const o = zoomOverride(vp, z);
      if (!o) continue;
      expect(Number.isInteger(o.width) && Number.isInteger(o.height)).toBe(true);
      expect(o.width).toBeGreaterThanOrEqual(1);
      expect(o.height).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("panelOverride: the page viewport follows the app's panel", () => {
  it("page CSS px = panel px / zoom (also at 100 %: the size never depends on Chrome's window); device scale untouched", () => {
    expect(panelOverride({ width: 800, height: 500 }, 0.8)).toEqual({ width: 1000, height: 625, deviceScaleFactor: 0, mobile: false });
    expect(panelOverride({ width: 800, height: 500 }, 1)).toEqual({ width: 800, height: 500, deviceScaleFactor: 0, mobile: false });
    expect(panelOverride({ width: 667, height: 380 }, 1.25)).toEqual({ width: 534, height: 304, deviceScaleFactor: 0, mobile: false });
  });

  it("unusable input gives no override", () => {
    for (const [view, zoom] of [
      [{ width: 0, height: 500 }, 1],
      [{ width: 800, height: 0 }, 1],
      [{ width: Number.NaN, height: 500 }, 1],
      [{ width: 800, height: Number.POSITIVE_INFINITY }, 1],
      [{ width: 800, height: 500 }, 0],
      [{ width: 800, height: 500 }, Number.NaN],
    ] as const) {
      expect(panelOverride(view, zoom), JSON.stringify([view, zoom])).toBeNull();
    }
  });

  it("monkey: whole positive sizes within the limits, aspect kept", () => {
    for (let i = 0; i < 500; i++) {
      const view = { width: 16 + ((i * 7919) % 4000), height: 16 + ((i * 104729) % 3000) };
      const zoom = 0.25 + ((i * 31) % 476) / 100;
      const o = panelOverride(view, zoom)!;
      expect(Number.isInteger(o.width) && Number.isInteger(o.height)).toBe(true);
      expect(o.width).toBeGreaterThanOrEqual(1);
      expect(o.width).toBeLessThanOrEqual(BROWSER_LIMITS.maxViewportDim);
      expect(o.height).toBeGreaterThanOrEqual(1);
      expect(o.height).toBeLessThanOrEqual(BROWSER_LIMITS.maxViewportDim);
    }
  });
});

describe("decideZoom: the zoom is the project's and only a user action changes it", () => {
  const DEFAULT = 0.67;

  it("a user step is always stored; null stores the default as a choice", () => {
    for (const stored of [undefined, null, 1.25]) {
      expect(decideZoom(stored, DEFAULT, 0.9, "user")).toEqual({ kind: "store", value: 0.9 });
      expect(decideZoom(stored, DEFAULT, null, "user")).toEqual({ kind: "store", value: null });
      // Also the default itself and the value already in effect: the answer is "this is now the user's choice".
      expect(decideZoom(stored, DEFAULT, DEFAULT, "user")).toEqual({ kind: "store", value: DEFAULT });
    }
  });

  it("a hand-over is used only while nobody chose a zoom (a chosen default counts as chosen)", () => {
    expect(decideZoom(undefined, DEFAULT, 1.1, "adopt")).toEqual({ kind: "store", value: 1.1 });
    expect(decideZoom(1.25, DEFAULT, 1.1, "adopt")).toEqual({ kind: "keep" });
    expect(decideZoom(null, DEFAULT, 1.1, "adopt")).toEqual({ kind: "keep" });
    expect(decideZoom(undefined, DEFAULT, null, "adopt")).toEqual({ kind: "refuse" });
  });

  it("an old app's copy: its default says nothing, a real value is adopted once, a change of a chosen zoom is refused", () => {
    // Old apps sent the default for every project nobody zoomed: it must not block a real hand-over later.
    expect(decideZoom(undefined, DEFAULT, DEFAULT, undefined)).toEqual({ kind: "keep" });
    expect(decideZoom(undefined, DEFAULT, 1.1, undefined)).toEqual({ kind: "store", value: 1.1 });
    expect(decideZoom(1.25, DEFAULT, 1.25, undefined)).toEqual({ kind: "keep" });
    expect(decideZoom(null, DEFAULT, DEFAULT, undefined)).toEqual({ kind: "keep" });
    expect(decideZoom(1.25, DEFAULT, DEFAULT, undefined)).toEqual({ kind: "refuse" });
    expect(decideZoom(null, DEFAULT, 1.1, undefined)).toEqual({ kind: "refuse" });
    expect(decideZoom(undefined, DEFAULT, null, undefined)).toEqual({ kind: "refuse" });
  });

  it("monkey: whatever non-user requests arrive, a chosen zoom never changes", () => {
    const zooms = [0.5, DEFAULT, 0.8, 1, 1.25, 2];
    for (let i = 0; i < 400; i++) {
      const stored = i % 5 === 0 ? null : zooms[(i * 7) % zooms.length]!;
      const zoom = zooms[(i * 13) % zooms.length]!;
      const mode = i % 2 === 0 ? "adopt" : undefined;
      expect(decideZoom(stored, DEFAULT, zoom, mode).kind, JSON.stringify([stored, zoom, mode])).not.toBe("store");
    }
  });
});

describe("mergeScreencast: one stream for every viewer", () => {
  it("nobody watches → nothing; one viewer → its own bounds", () => {
    expect(mergeScreencast([])).toBeUndefined();
    const one = { maxWidth: 900, maxHeight: 600, quality: 70 };
    expect(mergeScreencast([one])).toEqual(one);
    expect(mergeScreencast([one])).not.toBe(one);
  });

  it("several viewers: the largest bound in each direction and the best quality — no (re)start makes another's picture coarser", () => {
    expect(
      mergeScreencast([
        { maxWidth: 900, maxHeight: 600, quality: 70 },
        { maxWidth: 700, maxHeight: 840, quality: 80 },
        { maxWidth: 1800, maxHeight: 300, quality: 50 },
      ]),
    ).toEqual({ maxWidth: 1800, maxHeight: 840, quality: 80 });
  });
});
