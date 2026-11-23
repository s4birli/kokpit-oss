// Whether a panel's size report is the user's doing in this window (it may then take the page's viewport over
// from another app) — never for an unattended window, however often its panel is mounted, shown or resized.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetActivity, userDriven, userDrivenNow, watchActivity } from "./browser-activity.ts";
import { defaultUiConfig } from "./config.ts";

const WINDOW_MS = defaultUiConfig.browserInteractionMs;
const NEVER = Number.NEGATIVE_INFINITY;

describe("userDriven", () => {
  it("recent input in the window counts, focused or not; old input does not", () => {
    expect(userDriven({ lastInput: 1000, lastWindowResize: NEVER }, 1000 + WINDOW_MS, false, WINDOW_MS)).toBe(true);
    expect(userDriven({ lastInput: 1000, lastWindowResize: NEVER }, 1001 + WINDOW_MS, true, WINDOW_MS)).toBe(false);
  });

  it("a resize of the window itself counts only while it is the focused window (the user dragged its edge)", () => {
    const a = { lastInput: NEVER, lastWindowResize: 5000 };
    expect(userDriven(a, 5100, true, WINDOW_MS)).toBe(true);
    // macOS resized a window nobody is working in (display changed): not the user.
    expect(userDriven(a, 5100, false, WINDOW_MS)).toBe(false);
    expect(userDriven(a, 5001 + WINDOW_MS, true, WINDOW_MS)).toBe(false);
  });

  it("an untouched window is never the user's, and a window of 0 turns the rule off", () => {
    expect(userDriven({ lastInput: NEVER, lastWindowResize: NEVER }, 10, true, WINDOW_MS)).toBe(false);
    expect(userDriven({ lastInput: 10, lastWindowResize: 10 }, 10, true, 0)).toBe(false);
    expect(userDriven({ lastInput: 10, lastWindowResize: 10 }, Number.NaN, true, WINDOW_MS)).toBe(false);
  });

  it("monkey: true only with input (or a focused resize) within the window", () => {
    for (let i = 0; i < 500; i++) {
      const now = 100_000 + i;
      const a = { lastInput: now - ((i * 7919) % (3 * WINDOW_MS)), lastWindowResize: now - ((i * 104729) % (3 * WINDOW_MS)) };
      const focused = i % 2 === 0;
      const want = now - a.lastInput <= WINDOW_MS || (focused && now - a.lastWindowResize <= WINDOW_MS);
      expect(userDriven(a, now, focused, WINDOW_MS), JSON.stringify([a, now, focused])).toBe(want);
    }
  });
});

describe("watchActivity", () => {
  beforeEach(() => {
    forgetActivity();
    watchActivity();
  });
  afterEach(() => vi.restoreAllMocks());

  it("pointer, key and wheel input in the window make it the user's; nothing else does", () => {
    expect(userDrivenNow(WINDOW_MS)).toBe(false);
    // Focus, visibility, mouse movement: an unattended window gets these too.
    for (const name of ["focus", "mousemove", "pointermove"]) window.dispatchEvent(new Event(name));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(userDrivenNow(WINDOW_MS)).toBe(false);
    for (const name of ["pointerdown", "mousedown", "keydown", "wheel"]) {
      forgetActivity();
      document.body.dispatchEvent(new Event(name, { bubbles: true }));
      expect(userDrivenNow(WINDOW_MS), name).toBe(true);
    }
  });

  it("a window resize counts only for the focused window", () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    window.dispatchEvent(new Event("resize"));
    expect(userDrivenNow(WINDOW_MS)).toBe(false);
    focus.mockReturnValue(true);
    expect(userDrivenNow(WINDOW_MS)).toBe(true);
  });

  it("watching twice does not double anything, and the user's input ages out", () => {
    watchActivity();
    document.body.dispatchEvent(new Event("keydown", { bubbles: true }));
    const at = performance.now();
    const now = vi.spyOn(performance, "now").mockReturnValue(at + WINDOW_MS + 50);
    expect(userDrivenNow(WINDOW_MS)).toBe(false);
    now.mockRestore();
  });
});
