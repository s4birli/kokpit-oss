// @vitest-environment node
// Tam ekran ve yanıp sönme: the app window's own background is what macOS shows wherever the page has not painted
// yet — the strip uncovered when the window grows into full screen (measured: 16–20 ms between the window's resize
// and the page's first frame at the new size), and every native view (Web, Uzak masaüstü) before its page paints.
// Electron's default is white (#FFFFFF): a white flash at every full-screen entry and exit on a dark UI. It must be the
// theme's background, and that colour is the theme's token, not a second copy that could drift.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import windowDefaults from "./window.defaults.json" with { type: "json" };

/** A custom property of theme.css's :root, as written there. */
function themeToken(name: string): string {
  const css = readFileSync(new URL("../renderer/ui/theme.css", import.meta.url), "utf8");
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`${name} missing in theme.css`);
  return m[1]!.trim();
}

describe("the app window's background", () => {
  it("is the theme's page background (--bg), not Electron's white", () => {
    expect(windowDefaults.backgroundColor.toLowerCase()).toBe(themeToken("--bg").toLowerCase());
    expect(windowDefaults.backgroundColor.toLowerCase()).not.toBe("#ffffff");
  });

  it("is an opaque #rrggbb colour (Electron also takes #aarrggbb: a transparent one would show the desktop)", () => {
    expect(windowDefaults.backgroundColor).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
