// Kopyalama — what a terminal needs so text can be copied out of full-screen programs such as Claude Code:
//   1. OSC 52: the program's own "copy" reaches the system clipboard (write-only; policy in clipboard-ipc.ts).
//   2. While the program tracks the mouse, xterm sends drags to it instead of selecting. Option-drag selects locally
//      (xterm's macOptionClickForcesSelection, set in xterm-view.ts); Shift-drag is made to do the same on macOS,
//      where xterm ignores Shift.
//   3. A one-time hint naming the modifier, shown when a plain drag went to the program.
// Kept apart from xterm-view.ts so it runs against a minimal terminal in unit tests.
import { t } from "../../i18n/index.ts";
import { parseOsc52, type ClipboardConfig } from "../engine/clipboard-ipc.ts";

const OSC_CLIPBOARD = 52;
const PRIMARY_BUTTON = 0;
const HINT_CLASS = "kp-term__hint";

/** The part of xterm's `Terminal` used here. */
export interface ClipboardTerm {
  parser: { registerOscHandler(ident: number, callback: (data: string) => boolean): { dispose(): void } };
  modes: { readonly mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any" };
}

export interface TerminalClipboardDeps {
  config: ClipboardConfig;
  isMac: boolean;
  /** The write-only clipboard bridge (main process). */
  writeText(text: string): Promise<void>;
  /** The keyboard focus is in this terminal. */
  hasFocus(): boolean;
  /** Buffered history is being written (after attach): its OSC 52 sequences are old news. */
  replaying(): boolean;
}

/** The hint is shown once per app run, whichever terminal triggers it. */
let hintShown = false;
export function resetSelectionHintForTests(): void {
  hintShown = false;
}

export function attachTerminalClipboard(term: ClipboardTerm, container: HTMLElement, deps: TerminalClipboardDeps): { dispose(): void } {
  const { config } = deps;
  const tracking = (): boolean => term.modes.mouseTrackingMode !== "none";

  const osc = term.parser.registerOscHandler(OSC_CLIPBOARD, (data) => {
    // Always consumed: nothing else may answer it (a read request in particular).
    if (deps.replaying()) return true;
    const result = parseOsc52(data, config);
    if (result.kind !== "write") return true;
    if (config.osc52RequireFocus && !deps.hasFocus()) return true;
    deps.writeText(result.text).catch(() => {});
    return true;
  });

  let hint: HTMLElement | undefined;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  const removeHint = (): void => {
    if (hintTimer !== undefined) clearTimeout(hintTimer);
    hintTimer = undefined;
    hint?.remove();
    hint = undefined;
  };
  const showHint = (): void => {
    if (hintShown) return;
    hintShown = true;
    hint = container.ownerDocument.createElement("p");
    hint.className = HINT_CLASS;
    hint.setAttribute("role", "status");
    hint.textContent = t("terminal.clipboard.selectionHint");
    container.append(hint);
    hintTimer = setTimeout(removeHint, config.selectionHintMs);
  };

  let offMouseUp: (() => void) | undefined;
  /** A plain drag that the program gets: when it ends, tell the user how to select instead. */
  const watchPlainDrag = (down: MouseEvent): void => {
    if (hintShown) return;
    offMouseUp?.();
    const doc = container.ownerDocument;
    const onUp = (up: MouseEvent): void => {
      offMouseUp?.();
      if (Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) >= config.selectionHintMinDragPx) showHint();
    };
    doc.addEventListener("mouseup", onUp, true);
    offMouseUp = () => {
      doc.removeEventListener("mouseup", onUp, true);
      offMouseUp = undefined;
    };
  };

  // Capture phase: before xterm's own mousedown listeners (they sit on elements inside the container).
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== PRIMARY_BUTTON || !tracking()) return;
    if (e.altKey) return; // xterm forces selection itself (macOS) or column-selects (elsewhere)
    if (!e.shiftKey) {
      watchPlainDrag(e);
      return;
    }
    if (!deps.isMac || !config.macShiftDragForcesSelection || !config.macOptionClickForcesSelection) return;
    // xterm only knows Option as the forcing modifier on macOS: hand it the same press as an Option press.
    e.stopImmediatePropagation();
    e.preventDefault();
    e.target?.dispatchEvent(
      new MouseEvent(e.type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: e.view,
        detail: e.detail,
        screenX: e.screenX,
        screenY: e.screenY,
        clientX: e.clientX,
        clientY: e.clientY,
        button: e.button,
        buttons: e.buttons,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: true,
        shiftKey: false,
      }),
    );
  };
  container.addEventListener("mousedown", onMouseDown, true);

  return {
    dispose(): void {
      container.removeEventListener("mousedown", onMouseDown, true);
      offMouseUp?.();
      removeHint();
      osc.dispose();
    },
  };
}
