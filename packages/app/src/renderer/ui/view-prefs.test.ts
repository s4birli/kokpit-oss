import { describe, expect, it, vi } from "vitest";
import { defaultUiConfig } from "./config.ts";
import type { PanelStateStore } from "./layout/contract.ts";
import {
  BROWSER_ZOOM_KEY,
  FONT_SIZE_KEY,
  SEARCH_URL_KEY,
  VIEW_COMMANDS,
  clampFontSize,
  createFontSizeStore,
  dispatchViewCommand,
  isViewCommand,
  onViewCommand,
  legacyZoom,
  readZoom,
  searchUrlOf,
  shortcutStep,
  stepFontSize,
  stepZoom,
} from "./view-prefs.ts";

function memoryState(init: Record<string, unknown> = {}): PanelStateStore & { values: Record<string, unknown> } {
  const values = { ...init };
  return {
    values,
    get: <T,>(k: string) => values[k] as T | undefined,
    set: (k, v) => {
      if (v === undefined) delete values[k];
      else values[k] = v;
    },
  };
}

const cfg = defaultUiConfig;

describe("terminal font size math", () => {
  it("default is one px under the old 13px theme value", () => {
    expect(cfg.terminalFontSize).toBe(12);
  });
  it.each([
    [12, 12],
    [7, cfg.terminalFontSizeMin],
    [100, cfg.terminalFontSizeMax],
    [12.4, 12],
    [Number.NaN, cfg.terminalFontSize],
    [Number.POSITIVE_INFINITY, cfg.terminalFontSize],
    ["14", cfg.terminalFontSize],
    [null, cfg.terminalFontSize],
  ])("clampFontSize(%j) = %j", (input, out) => {
    expect(clampFontSize(input, cfg)).toBe(out);
  });
  it("steps by the configured step and stops at the bounds", () => {
    expect(stepFontSize(12, 1, cfg)).toBe(13);
    expect(stepFontSize(12, -1, cfg)).toBe(11);
    expect(stepFontSize(cfg.terminalFontSizeMax, 1, cfg)).toBe(cfg.terminalFontSizeMax);
    expect(stepFontSize(cfg.terminalFontSizeMin, -1, cfg)).toBe(cfg.terminalFontSizeMin);
    expect(stepFontSize(12, 1, { ...cfg, terminalFontSizeStep: 2 })).toBe(14);
  });
});

describe("createFontSizeStore", () => {
  it("starts at the stored value (clamped) or the default", () => {
    expect(createFontSizeStore(memoryState(), cfg).get()).toBe(12);
    expect(createFontSizeStore(memoryState({ [FONT_SIZE_KEY]: 15 }), cfg).get()).toBe(15);
    expect(createFontSizeStore(memoryState({ [FONT_SIZE_KEY]: 999 }), cfg).get()).toBe(cfg.terminalFontSizeMax);
    expect(createFontSizeStore(memoryState({ [FONT_SIZE_KEY]: "kötü" }), cfg).get()).toBe(12);
  });

  it("larger/smaller/reset change, persist and notify subscribers; no-op changes are silent", () => {
    const state = memoryState();
    const font = createFontSizeStore(state, cfg);
    const seen: number[] = [];
    const off = font.subscribe((px) => seen.push(px));
    font.apply("larger");
    font.apply("larger");
    font.apply("smaller");
    expect(font.get()).toBe(13);
    expect(state.values[FONT_SIZE_KEY]).toBe(13);
    font.apply("reset");
    expect(font.get()).toBe(12);
    // Default is not stored: a later change of the configured default reaches users who never chose.
    expect(state.values[FONT_SIZE_KEY]).toBeUndefined();
    font.apply("reset");
    expect(seen).toEqual([13, 14, 13, 12]);
    off();
    font.apply("larger");
    expect(seen).toHaveLength(4);
  });

  it("monkey: random command sequences keep the size within bounds and integral", () => {
    const font = createFontSizeStore(memoryState(), cfg);
    const cmds = ["larger", "smaller", "reset"] as const;
    for (let i = 0; i < 500; i++) {
      font.apply(cmds[(i * 7919) % 3]!);
      const px = font.get();
      expect(px).toBeGreaterThanOrEqual(cfg.terminalFontSizeMin);
      expect(px).toBeLessThanOrEqual(cfg.terminalFontSizeMax);
    }
  });
});

describe("browser zoom math", () => {
  const levels = cfg.browserZoomLevels;
  it("default is zoomed out (config)", () => {
    expect(cfg.browserZoom).toBeLessThan(1);
    expect(levels).toContain(cfg.browserZoom);
  });
  it("one step from the default is its neighbour in the configured levels", () => {
    const at = levels.indexOf(cfg.browserZoom);
    expect(stepZoom(cfg.browserZoom, 1, levels)).toBe(levels[at + 1]);
    expect(stepZoom(cfg.browserZoom, -1, levels)).toBe(levels[at - 1]);
  });
  // The levels themselves (not the default): fixed inputs.
  it.each([
    [0.8, 1, 0.9],
    [0.8, -1, 0.75],
    [1, 1, 1.1],
    [1, -1, 0.9],
    [2, 1, 2],
    [0.5, -1, 0.5],
    // Between levels: the next level in that direction.
    [0.85, 1, 0.9],
    [0.85, -1, 0.8],
    [0.1, 1, 0.5],
    [9, -1, 2],
  ])("stepZoom(%j, %j) = %j", (cur, dir, out) => {
    expect(stepZoom(cur, dir as 1 | -1, levels)).toBe(out);
  });
  it("readZoom: stored value when valid (snapped into range), else the default", () => {
    expect(readZoom(1.25, cfg)).toBe(1.25);
    expect(readZoom(undefined, cfg)).toBe(cfg.browserZoom);
    expect(readZoom("1", cfg)).toBe(cfg.browserZoom);
    expect(readZoom(Number.NaN, cfg)).toBe(cfg.browserZoom);
    expect(readZoom(-1, cfg)).toBe(cfg.browserZoom);
    expect(readZoom(50, cfg)).toBe(2);
    expect(readZoom(0.01, cfg)).toBe(0.5);
  });

  it("legacyZoom: a zoom this app stored before the engine owned it — usable (snapped into range) or nothing", () => {
    expect(legacyZoom(1.25, cfg)).toBe(1.25);
    expect(legacyZoom(cfg.browserZoom, cfg)).toBe(cfg.browserZoom);
    expect(legacyZoom(50, cfg)).toBe(2);
    for (const junk of [undefined, null, "1", Number.NaN, -1, 0, {}, Number.POSITIVE_INFINITY]) expect(legacyZoom(junk, cfg), String(junk)).toBeNull();
  });
});

describe("shortcutStep: Cmd/Ctrl + − / = / 0", () => {
  const k = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = { metaKey: true }) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  it.each([
    [k("-"), "smaller"],
    [k("="), "larger"],
    [k("+", { metaKey: true, shiftKey: true }), "larger"],
    [k("0"), "reset"],
    [k("-", { ctrlKey: true }), "smaller"],
    [k("-", {}), null],
    [k("a"), null],
    [k("-", { metaKey: true, altKey: true }), null],
  ])("%j → %j", (ev, out) => {
    expect(shortcutStep(ev)).toBe(out);
  });

  // Chrome on macOS: the key that PRODUCES "=" / "+" / "-" / "0" counts (the layout decides where it is), plus the
  // numeric keypad. `code` only names the physical key, so it is used for the keypad alone.
  const kc = (key: string, code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
    ...k(key, { metaKey: true, ...mods }),
    code,
  });
  it.each([
    // US layout
    [kc("=", "Equal"), "larger"],
    [kc("+", "Equal", { shiftKey: true }), "larger"],
    [kc("-", "Minus"), "smaller"],
    [kc("_", "Minus", { shiftKey: true }), "smaller"],
    [kc("0", "Digit0"), "reset"],
    // US: Cmd+Shift+0 is ")" — not a zoom key in Chrome either
    [kc(")", "Digit0", { shiftKey: true }), null],
    // Turkish Q (macOS): "-" is on the Equal key, "*" on the Minus key, "=" is Shift+0, "+" is Shift+4
    [kc("-", "Equal"), "smaller"],
    [kc("*", "Minus"), null],
    [kc("=", "Digit0", { shiftKey: true }), "larger"],
    [kc("+", "Digit4", { shiftKey: true }), "larger"],
    // a layout that reports the unshifted digit with Shift held: ambiguous, so not a reset
    [kc("0", "Digit0", { shiftKey: true }), null],
    // German: "+" has its own key (BracketRight), "-" is on Slash, "0" on Digit0
    [kc("+", "BracketRight"), "larger"],
    [kc("-", "Slash"), "smaller"],
    // numeric keypad, whatever the key reports (NumLock, layouts)
    [kc("+", "NumpadAdd"), "larger"],
    [kc("-", "NumpadSubtract"), "smaller"],
    [kc("0", "Numpad0"), "reset"],
    [kc("Insert", "Numpad0"), "reset"],
    // a physical Equal / Minus key whose layout produces a letter does not zoom
    [kc("ş", "Equal"), null],
    // no modifier, or Option held: never
    [{ ...kc("=", "Equal"), metaKey: false }, null],
    [kc("=", "Equal", { altKey: true }), null],
    [kc("+", "NumpadAdd", { altKey: true }), null],
  ])("layouts: %j → %j", (ev, out) => {
    expect(shortcutStep(ev)).toBe(out);
  });
});

describe("view command bus (menu commands)", () => {
  it("knows exactly the menu's commands", () => {
    expect([...VIEW_COMMANDS].sort()).toEqual(
      ["browser.zoom.in", "browser.zoom.out", "browser.zoom.reset", "terminal.font.larger", "terminal.font.reset", "terminal.font.smaller"].sort(),
    );
    expect(isViewCommand("terminal.font.larger")).toBe(true);
    expect(isViewCommand("terminal.font.huge")).toBe(false);
    expect(isViewCommand(42)).toBe(false);
  });
  it("delivers to every subscriber until it unsubscribes; unknown commands are ignored", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onViewCommand(a);
    const offB = onViewCommand(b);
    dispatchViewCommand("browser.zoom.in");
    offA();
    dispatchViewCommand("terminal.font.reset");
    dispatchViewCommand("rm -rf" as never);
    offB();
    expect(a.mock.calls).toEqual([["browser.zoom.in"]]);
    expect(b.mock.calls).toEqual([["browser.zoom.in"], ["terminal.font.reset"]]);
  });
  it("a throwing subscriber does not stop the others", () => {
    const bad = onViewCommand(() => {
      throw new Error("x");
    });
    const good = vi.fn();
    const off = onViewCommand(good);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatchViewCommand("terminal.font.larger");
    expect(good).toHaveBeenCalled();
    bad();
    off();
    warn.mockRestore();
  });
});

describe("searchUrlOf", () => {
  it("a valid stored override wins; otherwise the configured default", () => {
    expect(searchUrlOf(memoryState({ [SEARCH_URL_KEY]: "https://duckduckgo.com/?q=%s" }), cfg)).toBe("https://duckduckgo.com/?q=%s");
    expect(searchUrlOf(memoryState(), cfg)).toBe(cfg.browserSearchUrl);
    for (const bad of ["javascript:%s", "https://x.com/", 5, ""]) {
      expect(searchUrlOf(memoryState({ [SEARCH_URL_KEY]: bad }), cfg)).toBe(cfg.browserSearchUrl);
    }
  });
  it("zoom key is exported for the per-project state", () => {
    expect(typeof BROWSER_ZOOM_KEY).toBe("string");
  });
});
