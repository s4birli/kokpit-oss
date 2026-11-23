// Performans: the main process tells the page whether its window can be seen (shown and not minimized). The page's
// own `document.visibilityState` covers occlusion too, but stays "visible" while a debugger emulates focus; this
// signal comes from the window itself. Streamed panels stop asking for frames while it is false.
export const WINDOW_IPC = {
  /** main → renderer event: boolean, the window is shown and not minimized. */
  shown: "window:shown",
} as const;

export interface WindowBridge {
  /** `listener(shown)` on every change; returns unsubscribe. */
  onShownChanged(listener: (shown: boolean) => void): () => void;
}
