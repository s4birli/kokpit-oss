// Chrome-like zoom gestures of the Tarayıcı panel, pure parts: a trackpad pinch (Chromium: `wheel` + ctrlKey,
// deltaY < 0 = in) or Ctrl + mouse wheel → discrete zoom steps; the "%80 − + Sıfırla" bubble's show / hide timing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinchZoom, createZoomBubble, type PinchInput } from "./browser-zoom-gestures.ts";
import { defaultUiConfig } from "./config.ts";

const cfg = defaultUiConfig;
const T = cfg.browserPinchStepDelta;
const IDLE = cfg.browserPinchIdleMs;
const anyStep = () => true;

/** Feeds wheel deltas (px, `gap` ms apart) and returns the steps they made. */
function run(deltas: number[], opts: { gap?: number; can?: (s: "larger" | "smaller") => boolean; mode?: number } = {}) {
  const pinch = createPinchZoom(() => cfg);
  let t = 1000;
  const out: string[] = [];
  for (const d of deltas) {
    const e: PinchInput = { deltaY: d, deltaMode: opts.mode ?? 0, timeStamp: t };
    t += opts.gap ?? 8;
    const s = pinch.feed(e, opts.can ?? anyStep);
    if (s) out.push(s);
  }
  return out;
}

describe("pinch → zoom steps", () => {
  it("the configuration has sane values", () => {
    expect(T).toBeGreaterThan(0);
    expect(IDLE).toBeGreaterThan(0);
    expect(cfg.browserZoomBubbleMs).toBeGreaterThan(0);
  });

  it("fingers apart (deltaY < 0) zoom in, together zoom out, one step per threshold", () => {
    expect(run([-T])).toEqual(["larger"]);
    expect(run([T])).toEqual(["smaller"]);
    expect(run([-(T - 0.01)])).toEqual([]);
  });

  it("many small deltas add up: a pinch worth three thresholds makes three steps", () => {
    const small = Array.from({ length: 60 }, () => -(3 * T) / 60);
    expect(run(small)).toEqual(["larger", "larger", "larger"]);
  });

  it("one very large delta (a mouse notch, a fast pinch frame) is one step, like a Ctrl+wheel notch in Chrome", () => {
    expect(run([-1000])).toEqual(["larger"]);
    expect(run([1e9, 1e9])).toEqual(["smaller", "smaller"]);
    // nothing left over: a tiny delta after it does not step again
    expect(run([-1000, -1])).toEqual(["larger"]);
  });

  it("changing direction starts afresh: going back takes one whole threshold", () => {
    // in by 1.5 thresholds (one step, half left), then back out by 0.6 → nothing, 1.0 → one step out
    expect(run([-1.5 * T, 0.6 * T])).toEqual(["larger"]);
    expect(run([-1.5 * T, T])).toEqual(["larger", "smaller"]);
  });

  it("a pause ends the gesture: what was left over is dropped", () => {
    expect(run([-0.6 * T, -0.6 * T], { gap: IDLE + 1 })).toEqual([]);
    expect(run([-0.6 * T, -0.6 * T], { gap: IDLE - 1 })).toEqual(["larger"]);
  });

  it("at the end of the levels nothing builds up: zooming back works at once", () => {
    const atMax = (s: "larger" | "smaller") => s !== "larger";
    expect(run([-T, -T, -T, -T, T], { can: atMax })).toEqual(["smaller"]);
    const atMin = (s: "larger" | "smaller") => s !== "smaller";
    expect(run([5 * T, -T], { can: atMin })).toEqual(["larger"]);
  });

  it("line / page deltas are scaled like the page's wheel", () => {
    expect(run([-T / cfg.browserWheelLineHeight], { mode: 1 })).toEqual(["larger"]);
    expect(run([-T / cfg.browserWheelPageHeight], { mode: 2 })).toEqual(["larger"]);
  });

  it("junk is ignored", () => {
    expect(run([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0])).toEqual([]);
    const pinch = createPinchZoom(() => cfg);
    // a clock going backwards (another event source) is a new gesture, not an error
    expect(pinch.feed({ deltaY: -0.6 * T, deltaMode: 0, timeStamp: 500 }, anyStep)).toBeNull();
    expect(pinch.feed({ deltaY: -0.6 * T, deltaMode: 0, timeStamp: 100 }, anyStep)).toBeNull();
    expect(pinch.feed({ deltaY: -0.6 * T, deltaMode: 0, timeStamp: 105 }, anyStep)).toBe("larger");
  });

  it("monkey: random deltas never make more than one step per event", () => {
    const pinch = createPinchZoom(() => cfg);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let t = 0;
    for (let i = 0; i < 2000; i++) {
      t += rnd() * 2 * IDLE;
      const s = pinch.feed({ deltaY: (rnd() - 0.5) * 6 * T, deltaMode: Math.floor(rnd() * 3), timeStamp: t }, () => rnd() > 0.1);
      expect(s === null || s === "larger" || s === "smaller").toBe(true);
    }
  });
});

describe("zoom bubble timing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const seen: boolean[] = [];
    const bubble = createZoomBubble(() => cfg.browserZoomBubbleMs, (v) => seen.push(v));
    return { bubble, seen };
  };

  it("shows on a zoom change and hides after the configured time", () => {
    const { bubble, seen } = setup();
    bubble.show();
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(cfg.browserZoomBubbleMs - 1);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true, false]);
  });

  it("another change while shown restarts the time (no flicker)", () => {
    const { bubble, seen } = setup();
    bubble.show();
    vi.advanceTimersByTime(cfg.browserZoomBubbleMs - 10);
    bubble.show();
    vi.advanceTimersByTime(cfg.browserZoomBubbleMs - 10);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([true, false]);
  });

  it("stays while hovered; leaving starts the time again", () => {
    const { bubble, seen } = setup();
    bubble.show();
    bubble.hover(true);
    vi.advanceTimersByTime(cfg.browserZoomBubbleMs * 10);
    expect(seen).toEqual([true]);
    // a change while hovered does not hide it either
    bubble.show();
    vi.advanceTimersByTime(cfg.browserZoomBubbleMs * 10);
    expect(seen).toEqual([true]);
    bubble.hover(false);
    vi.advanceTimersByTime(cfg.browserZoomBubbleMs);
    expect(seen).toEqual([true, false]);
  });

  it("dispose stops the timer", () => {
    const { bubble, seen } = setup();
    bubble.show();
    bubble.dispose();
    vi.advanceTimersByTime(cfg.browserZoomBubbleMs * 2);
    expect(seen).toEqual([true]);
  });
});
