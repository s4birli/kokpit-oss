// The key-routing rule of a streamed page: the browser's own shortcuts, Kokpit's menu keys, everything else the page's.
import { describe, expect, it } from "vitest";
import { matchesCombo, pageKeysConfig, routeKey, SURFACE_ACTIONS, type KeyPress } from "./page-keys.ts";

const key = (k: string, mods: string[] = [], code = ""): KeyPress => ({
  key: k,
  code,
  metaKey: mods.includes("Meta"),
  ctrlKey: mods.includes("Control"),
  altKey: mods.includes("Alt"),
  shiftKey: mods.includes("Shift"),
});
const mac = (k: KeyPress) => routeKey(k, true);

describe("routeKey (macOS)", () => {
  it("Chrome's window shortcuts are the surface's", () => {
    expect(mac(key("l", ["Meta"], "KeyL"))).toEqual({ to: "surface", action: "focusAddress" });
    expect(mac(key("t", ["Meta"], "KeyT"))).toEqual({ to: "surface", action: "newTab" });
    expect(mac(key("T", ["Meta", "Shift"], "KeyT"))).toEqual({ to: "surface", action: "reopenTab" });
    expect(mac(key("w", ["Meta"], "KeyW"))).toEqual({ to: "surface", action: "closeTab" });
    expect(mac(key("r", ["Meta"], "KeyR"))).toEqual({ to: "surface", action: "reload" });
    expect(mac(key("R", ["Meta", "Shift"], "KeyR"))).toEqual({ to: "surface", action: "reloadHard" });
    expect(mac(key("[", ["Meta"], "BracketLeft"))).toEqual({ to: "surface", action: "back" });
    expect(mac(key("]", ["Meta"], "BracketRight"))).toEqual({ to: "surface", action: "forward" });
    expect(mac(key("1", ["Meta"], "Digit1"))).toEqual({ to: "surface", action: "tab1" });
    expect(mac(key("9", ["Meta"], "Digit9"))).toEqual({ to: "surface", action: "lastTab" });
    expect(mac(key("Tab", ["Control"], "Tab"))).toEqual({ to: "surface", action: "nextTab" });
    expect(mac(key("Tab", ["Control", "Shift"], "Tab"))).toEqual({ to: "surface", action: "prevTab" });
    expect(mac(key("ArrowRight", ["Meta", "Alt"], "ArrowRight"))).toEqual({ to: "surface", action: "nextTab" });
    expect(mac(key("}", ["Meta", "Shift"], "BracketRight"))).toEqual({ to: "surface", action: "nextTab" });
    expect(mac(key("f", ["Meta"], "KeyF"))).toEqual({ to: "surface", action: "find" });
    expect(mac(key("G", ["Meta", "Shift"], "KeyG"))).toEqual({ to: "surface", action: "findPrevious" });
  });

  it("Turkish Q: the character decides; '[' is Option+8 there, so Cmd + the key at '[' (ğ) still goes back", () => {
    expect(mac(key("ğ", ["Meta"], "BracketLeft"))).toEqual({ to: "surface", action: "back" });
    expect(mac(key("l", ["Meta"], "KeyL"))).toEqual({ to: "surface", action: "focusAddress" });
  });

  it("Kokpit's menu keys go to the menu, not the page", () => {
    for (const k of [key("q", ["Meta"]), key("h", ["Meta"]), key("m", ["Meta"]), key(",", ["Meta"], "Comma"), key("?", ["Meta", "Shift"], "Slash")]) {
      expect(mac(k)).toEqual({ to: "app" });
    }
  });

  it("everything else is the page's: editing, text navigation, typing, Cmd combos pages use, Turkish characters", () => {
    for (const k of [
      key("a", ["Meta"], "KeyA"),
      key("z", ["Meta"], "KeyZ"),
      key("Z", ["Meta", "Shift"], "KeyZ"),
      key("ArrowLeft", ["Meta"], "ArrowLeft"),
      key("ArrowLeft", ["Alt"], "ArrowLeft"),
      key("Backspace", ["Alt"], "Backspace"),
      key("Backspace", ["Meta"], "Backspace"),
      key("ArrowLeft", ["Shift"], "ArrowLeft"),
      key("Enter", [], "Enter"),
      key("Tab", [], "Tab"),
      key("Escape", [], "Escape"),
      key("b", ["Meta"], "KeyB"),
      key("Enter", ["Meta"], "Enter"),
      key("ş", [], "Semicolon"),
      key("@", ["Alt"], "KeyQ"),
      key("I", ["Shift"], "Quote"),
      key("l", [], "KeyL"),
      key("t", ["Control"], "KeyT"),
      key("1", ["Meta", "Alt"], "Digit1"),
    ]) {
      expect(mac(k), JSON.stringify(k)).toEqual({ to: "page" });
    }
  });
});

describe("routeKey (Windows / Linux: Ctrl is Mod)", () => {
  it("Ctrl+L / Ctrl+T are the surface's; Cmd (the Windows key) is not Mod there", () => {
    expect(routeKey(key("l", ["Control"], "KeyL"), false)).toEqual({ to: "surface", action: "focusAddress" });
    expect(routeKey(key("t", ["Meta"], "KeyT"), false)).toEqual({ to: "page" });
  });
});

describe("matchesCombo", () => {
  it("exact modifiers only", () => {
    expect(matchesCombo(key("l", ["Meta"]), "Mod+l", true)).toBe(true);
    expect(matchesCombo(key("l", ["Meta", "Shift"]), "Mod+l", true)).toBe(false);
    expect(matchesCombo(key("l", ["Meta", "Control"]), "Mod+l", true)).toBe(false);
  });
  it("monkey: random and malformed input never throws and never routes to a surface action off the table", () => {
    const keys = ["", "a", "Tab", "ArrowLeft", "ğ", "\u0000", "x".repeat(500), "+", "Meta"];
    for (let i = 0; i < 2000; i++) {
      const k = key(keys[i % keys.length]!, ["Meta", "Control", "Alt", "Shift"].filter(() => Math.random() < 0.5), ["", "KeyA", "Tab", "BracketLeft"][i % 4]);
      const r = routeKey(k, i % 2 === 0);
      if (r.to === "surface") expect(SURFACE_ACTIONS).toContain(r.action);
    }
    expect(matchesCombo(key("a"), "", true)).toBe(false);
    expect(matchesCombo(key("a"), "Bogus+a", true)).toBe(false);
  });
  it("every combo in the shipped table is well-formed and no combo means two things", () => {
    const seen = new Map<string, string>();
    const all: [string, string][] = [
      ...Object.entries(pageKeysConfig.surface).flatMap(([a, cs]) => cs.map((c) => [c, a] as [string, string])),
      ...pageKeysConfig.app.map((c) => [c, "app"] as [string, string]),
    ];
    for (const [combo, owner] of all) {
      expect(combo).toMatch(/^((Shift|Control|Alt|Mod)\+)*[^+]+$/);
      expect(seen.get(combo), combo).toBeUndefined();
      seen.set(combo, owner);
    }
    for (const a of Object.keys(pageKeysConfig.surface)) expect(SURFACE_ACTIONS).toContain(a);
  });
});
