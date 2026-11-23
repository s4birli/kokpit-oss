// Who gets a key pressed on a streamed page (Tarayıcı, Masaüstü windows) — one rule, read from page-keys.defaults.json:
// the browser's own shortcuts (address bar, tabs, reload, back / forward, find) are the surface's, Kokpit's menu
// keys are the menu bar's, and every other key is the page's — Cmd+A / Z and Option / Cmd text navigation included
// (the engine adds the system's editing commands for a Chrome on macOS). Zoom and the clipboard keep their own rules.
import defaults from "./page-keys.defaults.json" with { type: "json" };

export const SURFACE_ACTIONS = [
  "focusAddress",
  "newTab",
  "closeTab",
  "reopenTab",
  "reload",
  "reloadHard",
  "back",
  "forward",
  "nextTab",
  "prevTab",
  "tab1",
  "tab2",
  "tab3",
  "tab4",
  "tab5",
  "tab6",
  "tab7",
  "tab8",
  "lastTab",
  "find",
  "findNext",
  "findPrevious",
] as const;
export type SurfaceAction = (typeof SURFACE_ACTIONS)[number];

export interface PageKeysConfig {
  surface: Readonly<Partial<Record<SurfaceAction, readonly string[]>>>;
  app: readonly string[];
}
export const pageKeysConfig: PageKeysConfig = { surface: defaults.surface, app: defaults.app };

export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type KeyRoute = { to: "surface"; action: SurfaceAction } | { to: "app" } | { to: "page" };

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Mod", "Meta"]);

/** Whether `e` is exactly `combo` ("Shift+Mod+t": these modifiers and no others; Mod = Cmd on macOS, else Ctrl). */
export function matchesCombo(e: KeyPress, combo: string, isMac: boolean): boolean {
  const parts = combo.split("+");
  const name = parts.pop();
  if (!name) return false;
  const mods = new Set<string>();
  for (const p of parts) {
    if (!MODIFIERS.has(p)) return false;
    mods.add(p === "Mod" ? (isMac ? "Meta" : "Control") : p);
  }
  if (e.metaKey !== mods.has("Meta") || e.ctrlKey !== mods.has("Control") || e.altKey !== mods.has("Alt") || e.shiftKey !== mods.has("Shift")) {
    return false;
  }
  // A character is compared case-blind (Shift+Cmd+T reports "T"); a longer name is a DOM key name or a key code.
  return [...name].length === 1 ? e.key.toLowerCase() === name.toLowerCase() : e.key === name || e.code === name;
}

export function routeKey(e: KeyPress, isMac: boolean, cfg: PageKeysConfig = pageKeysConfig): KeyRoute {
  for (const action of SURFACE_ACTIONS) {
    if (cfg.surface[action]?.some((c) => matchesCombo(e, c, isMac))) return { to: "surface", action };
  }
  if (cfg.app.some((c) => matchesCombo(e, c, isMac))) return { to: "app" };
  return { to: "page" };
}
