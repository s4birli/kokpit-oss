// Seam between TerminalPanel and the terminal renderer (xterm in the app, a fake in tests).
import type { TerminalLinkHost } from "./link-opener.ts";

export interface TerminalDims {
  cols: number;
  rows: number;
}

export interface TerminalView {
  /** Mounts the renderer into the given element. Called once, before anything else. */
  open(container: HTMLElement): void;
  /** Fits the renderer to its container. Returns null when the container has no measurable size. */
  fit(): TerminalDims | null;
  /** İş Z: font size in px; the caller refits afterwards. Optional for renderers without a font. */
  setFontSize?(px: number): void;
  /** `replay`: buffered history sent after attach — shown, but its side effects (clipboard writes) are not repeated. */
  write(data: string, replay?: boolean): void;
  /** Clears screen and scrollback (used before writing a replay). */
  reset(): void;
  /** Keystrokes typed by the user. Returns an unsubscribe function. */
  onData(cb: (data: string) => void): () => void;
  focus(): void;
  dispose(): void;
}

export interface TerminalViewOptions {
  /** Bağlantılar: opens the links of this terminal (in its project's browser); absent = links are inert. */
  links?: TerminalLinkHost | undefined;
}

export type TerminalViewFactory = (options?: TerminalViewOptions) => TerminalView;
