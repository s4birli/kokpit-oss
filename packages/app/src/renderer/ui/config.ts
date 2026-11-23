// Tunables of the workbench UI. Overridable through Workbench's `config` prop.
import type { TerminalDims } from "./terminal-view.ts";

export interface UiConfig {
  /** Size sent to the engine when a terminal's container can't be measured yet (e.g. hidden). */
  fallbackDims: TerminalDims;
  /** Upper bound for cols/rows accepted by the protocol (`Dim` in @kokpit/shared). */
  maxDim: number;
  /** Delay before a resize is reported to the engine. */
  resizeDebounceMs: number;
  /** Name of the engine's machine, used in location labels ("<name>: /path", "<name> klasörü"). */
  machineName: string;
  /** İş A: how often relative times ("42 sn önce") of the Ajanlar panel and rail refresh. */
  agentsClockMs: number;
  /** İş B: JPEG quality (1–100) of the browser screencast. */
  browserQuality: number;
  /**
   * The Tarayıcı panel's picture area counts as hidden while it is narrower or shorter than this (CSS px): its
   * size is then not sent to the engine (the page keeps the last real size).
   */
  browserMinViewport: number;
  /**
   * Several apps may show one project's browser; the page's size follows the panel its user last used. A size the
   * panel reports by itself (it was mounted, shown or resized) counts as the user's doing only within this long
   * after their last input in this window (or a resize of the focused window).
   */
  browserInteractionMs: number;
  /** İş B: pixels per line / page when a wheel event reports lines or pages. */
  browserWheelLineHeight: number;
  browserWheelPageHeight: number;
  // ---- İş T: terminal sekmeleri ----
  /** Width share of the active terminal when split ("böl"), before the user drags the divider. */
  terminalSplitRatio: number;
  /** Narrowest share either side of the split may get. */
  terminalSplitMinRatio: number;
  /** Share moved by one arrow key press on the divider. */
  terminalSplitKeyStep: number;
  // ---- İş Z: yazı boyutu, yakınlaştırma, adres çubuğu ----
  /** Default terminal font size (px); the user's choice is kept globally in the UI state. */
  terminalFontSize: number;
  terminalFontSizeMin: number;
  terminalFontSizeMax: number;
  /** px per "Yazıyı büyüt/küçült". */
  terminalFontSizeStep: number;
  /**
   * Page zoom shown until the engine reports the project's (1 = 100 %). The zoom itself is the engine's — one value
   * per project for every app, default `browser.defaultZoom` in the engine config; this mirrors that default.
   */
  browserZoom: number;
  /** Zoom steps −/+ walk through (ascending); a pinch and Ctrl + wheel step through them too. Min/max = the ends. */
  browserZoomLevels: readonly number[];
  /**
   * Trackpad pinch / Ctrl + wheel: wheel deltaY (px; Chromium sends a pinch as ctrlKey wheel events, about
   * −100·ln(scale) per frame) that makes one zoom step. One event never makes more than one step (a mouse notch is
   * one step, as in Chrome).
   */
  browserPinchStepDelta: number;
  /** A pinch pausing this long is over: what it left below a step is dropped. */
  browserPinchIdleMs: number;
  /** The "%80 − + Sıfırla" bubble after a zoom change hides after this long (stays while the pointer is on it). */
  browserZoomBubbleMs: number;
  /** Search engine for address-bar input that is not an address; `%s` = the URL-encoded text. */
  browserSearchUrl: string;
  /**
   * Performans: a streamed panel (e.g. Tarayıcı) out of sight this long — hidden dock tab, another view,
   * minimized / hidden / covered window — stops its stream; back in sight it starts again at once.
   */
  streamHideGraceMs: number;
  // ---- Dosyalar ----
  /**
   * Narrowest Dosyalar panel (CSS px) that shows the tree and the preview side by side. Below it they are stacked
   * and a clicked file opens in the large preview, since a column that narrow cannot show a file readably.
   */
  filesSideBySideMinWidth: number;
  /** The tree's share of the panel per layout, before the user drags the divider. */
  filesSplitRatio: { side: number; stacked: number };
  /** Smallest share either side of the divider may get. */
  filesSplitMinRatio: number;
  /** Share moved by one arrow key press on the divider. */
  filesSplitKeyStep: number;
  /** Times a failed media element asks the engine for a fresh URL before it reports the failure. */
  filesMediaRetries: number;
}

export const defaultUiConfig: UiConfig = {
  fallbackDims: { cols: 80, rows: 24 },
  maxDim: 1000,
  resizeDebounceMs: 120,
  machineName: "Mac mini",
  agentsClockMs: 15_000,
  browserQuality: 70,
  browserMinViewport: 64,
  browserInteractionMs: 3000,
  browserWheelLineHeight: 16,
  browserWheelPageHeight: 800,
  terminalSplitRatio: 0.5,
  terminalSplitMinRatio: 0.2,
  terminalSplitKeyStep: 0.05,
  terminalFontSize: 12,
  terminalFontSizeMin: 8,
  terminalFontSizeMax: 32,
  terminalFontSizeStep: 1,
  // The page is laid out at the panel's picture area ÷ zoom. At %67 a ~700–1100 px wide panel still gets a
  // desktop-width page (≈1050–1650 px) instead of a tablet layout, close to the look the old fixed 1600 px page had.
  browserZoom: 0.67,
  browserZoomLevels: [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2],
  // ≈ ln(1.13)·100: about as far as the fingers move between two neighbouring levels (they are 7–20 % apart).
  browserPinchStepDelta: 12,
  browserPinchIdleMs: 250,
  // Chrome's zoom bubble closes after 1.5 s.
  browserZoomBubbleMs: 1500,
  browserSearchUrl: "https://www.google.com/search?q=%s",
  streamHideGraceMs: 2000,
  filesSideBySideMinWidth: 560,
  filesSplitRatio: { side: 0.3, stacked: 0.45 },
  filesSplitMinRatio: 0.15,
  filesSplitKeyStep: 0.05,
  filesMediaRetries: 1,
};

const clamp = (n: number, max: number): number => Math.min(max, Math.max(1, Math.floor(n)));

/** Valid protocol dims from a (possibly unmeasurable) fit result. */
export function toProtocolDims(dims: TerminalDims | null, config: UiConfig): TerminalDims {
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 1 || dims.rows < 1) {
    return { ...config.fallbackDims };
  }
  return { cols: clamp(dims.cols, config.maxDim), rows: clamp(dims.rows, config.maxDim) };
}

/** Dims usable for a resize, or null when the view has no real size. */
export function measurableDims(dims: TerminalDims | null, config: UiConfig): TerminalDims | null {
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 1 || dims.rows < 1) return null;
  return toProtocolDims(dims, config);
}
