// İş Z: view preferences — terminal font size (global), browser zoom (per project), search engine — and the
// view command bus the native menu (Görünüm) and keyboard shortcuts drive. Pure; React glue is view-prefs-context.
import type { UiConfig } from "./config.ts";
import type { PanelStateStore } from "./layout/contract.ts";

// ---------- commands ----------

/** Menu commands (Electron main → renderer `onMenuCommand`) this module understands. */
export const VIEW_COMMANDS = [
  "terminal.font.smaller",
  "terminal.font.larger",
  "terminal.font.reset",
  "browser.zoom.out",
  "browser.zoom.in",
  "browser.zoom.reset",
] as const;
export type ViewCommand = (typeof VIEW_COMMANDS)[number];

const COMMAND_SET: ReadonlySet<string> = new Set(VIEW_COMMANDS);
export const isViewCommand = (v: unknown): v is ViewCommand => typeof v === "string" && COMMAND_SET.has(v);

const listeners = new Set<(cmd: ViewCommand) => void>();

/** Runs a view command (from the menu, a shortcut or a button). Unknown commands are ignored. */
export function dispatchViewCommand(cmd: ViewCommand): void {
  if (!isViewCommand(cmd)) return;
  for (const cb of [...listeners]) {
    try {
      cb(cmd);
    } catch (err) {
      console.warn("[kokpit] görünüm komutu başarısız", cmd, err);
    }
  }
}

/** Subscribes to view commands; returns unsubscribe. */
export function onViewCommand(cb: (cmd: ViewCommand) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export type Step = "smaller" | "larger" | "reset";

interface ShortcutKey {
  key: string;
  /** The physical key; used for the numeric keypad only (the layout decides what the other keys produce). */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}

/** Characters that zoom, as Chrome on macOS reads them: the key that PRODUCES the character, wherever the layout puts it. */
const LARGER_KEYS: ReadonlySet<string> = new Set(["=", "+"]);
const SMALLER_KEYS: ReadonlySet<string> = new Set(["-", "_"]);
const RESET_KEY = "0";
/** The numeric keypad's keys zoom whatever character they report (NumLock, layout). */
const KEYPAD: Readonly<Record<string, Step>> = { NumpadAdd: "larger", NumpadSubtract: "smaller", Numpad0: "reset" };

/**
 * Cmd (or Ctrl) + − / = (+) / 0 → the step it means; null for any other key. Layout-aware like Chrome: Turkish Q
 * has "-" on the Equal key and "=" on Shift+0, German has "+" on its own key — the character decides, not the
 * position. Shift + a key reporting "0" is ambiguous (the US ")" key, or a layout reporting the unshifted digit
 * for its "="), so it does nothing rather than reset.
 */
export function shortcutStep(e: ShortcutKey): Step | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const pad = e.code !== undefined && Object.hasOwn(KEYPAD, e.code) ? KEYPAD[e.code] : undefined;
  if (pad) return pad;
  if (SMALLER_KEYS.has(e.key)) return "smaller";
  if (LARGER_KEYS.has(e.key)) return "larger";
  if (e.key === RESET_KEY && e.shiftKey !== true) return "reset";
  return null;
}

// ---------- terminal font size ----------

/** UI state key (terminals panel, global scope) of the chosen font size. */
export const FONT_SIZE_KEY = "fontSize";
/** UI state scope shared by every project/card. */
export const GLOBAL_SCOPE = "global";

type FontConfig = Pick<UiConfig, "terminalFontSize" | "terminalFontSizeMin" | "terminalFontSizeMax" | "terminalFontSizeStep">;

/** A whole px size within the configured range; anything unusable gives the default. */
export function clampFontSize(v: unknown, cfg: FontConfig): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return cfg.terminalFontSize;
  return Math.min(cfg.terminalFontSizeMax, Math.max(cfg.terminalFontSizeMin, Math.round(v)));
}

export function stepFontSize(current: number, dir: 1 | -1, cfg: FontConfig): number {
  return clampFontSize(current + dir * cfg.terminalFontSizeStep, cfg);
}

export interface FontSizeStore {
  get(): number;
  /** Called with the new size after every change. Returns unsubscribe. */
  subscribe(cb: (px: number) => void): () => void;
  apply(step: Step): void;
}

/** The global terminal font size, persisted in `state` (the default itself is not stored). */
export function createFontSizeStore(state: PanelStateStore, cfg: FontConfig): FontSizeStore {
  let px = clampFontSize(state.get(FONT_SIZE_KEY) ?? cfg.terminalFontSize, cfg);
  const subs = new Set<(px: number) => void>();
  return {
    get: () => px,
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    apply(step) {
      const next = step === "reset" ? cfg.terminalFontSize : stepFontSize(px, step === "larger" ? 1 : -1, cfg);
      if (step === "reset") state.set(FONT_SIZE_KEY, undefined);
      if (next === px) return;
      px = next;
      if (step !== "reset") state.set(FONT_SIZE_KEY, px);
      for (const cb of [...subs]) cb(px);
    },
  };
}

// ---------- browser zoom ----------

/**
 * UI state key (browser panel, project scope) under which apps used to keep the project's zoom themselves. The
 * zoom is the engine's now; a value still stored here is handed over once (`legacyZoom`) and then removed.
 */
export const BROWSER_ZOOM_KEY = "zoom";

/** The next configured level above (dir 1) or below (−1) `current`; stays at the ends. */
export function stepZoom(current: number, dir: 1 | -1, levels: readonly number[]): number {
  const sorted = [...levels].sort((a, b) => a - b);
  const eps = 1e-9;
  if (dir > 0) return sorted.find((l) => l > current + eps) ?? sorted[sorted.length - 1]!;
  return [...sorted].reverse().find((l) => l < current - eps) ?? sorted[0]!;
}

/** A stored zoom (clamped to the configured levels' range), or the default when unusable. */
export function readZoom(v: unknown, cfg: Pick<UiConfig, "browserZoom" | "browserZoomLevels">): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return cfg.browserZoom;
  const min = Math.min(...cfg.browserZoomLevels);
  const max = Math.max(...cfg.browserZoomLevels);
  return Math.min(max, Math.max(min, v));
}

/** A zoom this app stored before the engine owned it (clamped to the configured levels' range); null = none usable. */
export function legacyZoom(v: unknown, cfg: Pick<UiConfig, "browserZoom" | "browserZoomLevels">): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? readZoom(v, cfg) : null;
}

/** Zoom after a step from `current`. */
export function zoomAfter(step: Step, current: number, cfg: Pick<UiConfig, "browserZoom" | "browserZoomLevels">): number {
  if (step === "reset") return cfg.browserZoom;
  return stepZoom(current, step === "larger" ? 1 : -1, cfg.browserZoomLevels);
}

/** "%80" style label. */
export const zoomLabel = (zoom: number): string => `%${Math.round(zoom * 100)}`;

// ---------- search engine ----------

/** UI state key (browser panel, global scope) of a search engine chosen instead of the configured one. */
export const SEARCH_URL_KEY = "searchUrl";

const validSearchUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/[^\s]+$/i.test(v) && v.includes("%s");

export function searchUrlOf(globalBrowserState: PanelStateStore, cfg: Pick<UiConfig, "browserSearchUrl">): string {
  const v = globalBrowserState.get(SEARCH_URL_KEY);
  return validSearchUrl(v) ? v : cfg.browserSearchUrl;
}
