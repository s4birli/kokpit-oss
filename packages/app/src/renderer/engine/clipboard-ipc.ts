// Kopyalama — contract between the renderer, the preload and Electron main for writing the system clipboard, plus
// the OSC 52 policy of the terminals.
//
// Programs in a terminal (Claude Code among them) copy their own selection with OSC 52: `ESC ] 52 ; Pc ; Pd BEL`,
// Pd = base64 text. Kokpit honours WRITES to the clipboard only:
//   - `Pd = ?` (read the clipboard) is never answered — any program, local or over ssh, could otherwise read
//     whatever the user copied last (passwords included);
//   - payloads over `osc52MaxBytes`, other selections than the clipboard, and malformed base64 / non-UTF-8 are dropped;
//   - the write itself happens in main (Electron `clipboard`), which checks the sender frame and the size again.
// The renderer is sandboxed, so `navigator.clipboard` (focus- and permission-bound) is not used.
import defaults from "./clipboard.defaults.json" with { type: "json" };

export const CLIPBOARD_IPC = {
  /** renderer → main: text to put on the system clipboard. */
  writeText: "clipboard:writeText",
  /** renderer → main: show the native "Kopyala" menu for one value (a path, a command, an id). */
  copyMenu: "clipboard:copyMenu",
  /** renderer → main: show the native right-click menu of the streamed browser page (PageMenuRequest). */
  pageMenu: "clipboard:pageMenu",
} as const;

/**
 * Kopyalama — Tarayıcı panel: what the right-click menu over the streamed page should offer. The page's own
 * context menu is not streamed, so Kokpit shows a native one. Kopyala / Kes / Yapıştır are ROLE items: they act
 * on the focused canvas exactly like the Edit menu, whose `copy` / `cut` / `paste` events the panel turns into
 * engine requests. The two addresses are written to the clipboard by main itself.
 */
export interface PageMenuRequest {
  /** Something is selected in the remote page. */
  canCopy: boolean;
  /** …and it is editable. */
  canCut: boolean;
  /** The remote page's focus is in an editable field. */
  canPaste: boolean;
  /** http(s) link under the pointer. */
  linkUrl?: string | undefined;
  /** http(s) address of the page. */
  pageUrl?: string | undefined;
}

export interface ClipboardConfig {
  /** Most UTF-8 bytes one clipboard write may carry (OSC 52 and the IPC). */
  osc52MaxBytes: number;
  /** OSC 52 selection letters that mean "the clipboard" here; an empty target always does. */
  osc52Targets: string;
  /** Only the terminal holding the keyboard focus may write the clipboard. */
  osc52RequireFocus: boolean;
  /** macOS: Option-drag selects even while the program tracks the mouse (xterm's option of the same name). */
  macOptionClickForcesSelection: boolean;
  /** macOS: Shift-drag does the same (xterm only knows Shift on other platforms). */
  macShiftDragForcesSelection: boolean;
  /** How long the selection hint (terminal.clipboard.selectionHint) stays after a plain drag to a mouse-tracking program. */
  selectionHintMs: number;
  /** A press-and-release shorter than this is a click, not a drag. */
  selectionHintMinDragPx: number;
  /** Longest value the "Kopyala" context menu takes (paths, commands, ids). */
  copyValueMaxChars: number;
  /** Longest link / page address the streamed page's right-click menu copies. */
  pageUrlMaxChars: number;
  /**
   * Tarayıcı panel: a right click with this modifier held goes to the remote page (for pages that handle
   * `contextmenu` themselves) instead of opening Kokpit's menu.
   */
  pageContextPassModifier: "alt" | "shift";
}
const PASS_MODIFIERS = ["alt", "shift"] as const;
export const clipboardConfig: ClipboardConfig = {
  ...defaults,
  // A typo in the defaults file must not silently send every right click to the page.
  pageContextPassModifier: PASS_MODIFIERS.find((m) => m === defaults.pageContextPassModifier) ?? PASS_MODIFIERS[0],
};

/** Exposed as `window.kokpit.clipboard`. */
export interface ClipboardBridge {
  writeText(text: string): Promise<void>;
  copyMenu(text: string): Promise<void>;
  pageMenu(request: PageMenuRequest): Promise<void>;
}

export type Osc52Refusal = "read" | "target" | "too-large" | "malformed";
export type Osc52Result = { kind: "write"; text: string } | { kind: "refused"; reason: Osc52Refusal };

const refused = (reason: Osc52Refusal): Osc52Result => ({ kind: "refused", reason });
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TARGET = /^[cpqs0-7]*$/;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The payload of an OSC 52 sequence (`Pc;Pd`, without the `52;`) → the text to copy, or why not. Never throws. */
export function parseOsc52(data: string, cfg: ClipboardConfig): Osc52Result {
  const sep = data.indexOf(";");
  if (sep < 0) return refused("malformed");
  const target = data.slice(0, sep);
  const payload = data.slice(sep + 1);
  if (!TARGET.test(target)) return refused("malformed");
  if (payload === "?") return refused("read");
  if (target !== "" && ![...target].some((ch) => cfg.osc52Targets.includes(ch))) return refused("target");
  // 4 base64 characters carry at most 3 bytes: refuse before decoding anything big.
  if (payload.length > Math.ceil(cfg.osc52MaxBytes / 3) * 4) return refused("too-large");
  if (payload === "" || !BASE64.test(payload)) return refused("malformed");
  let text: string;
  try {
    const binary = atob(payload);
    if (binary.length > cfg.osc52MaxBytes) return refused("too-large");
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refused("malformed");
  }
  return text === "" ? refused("malformed") : { kind: "write", text };
}
