// Tuşlar — the keys a terminal sends that Kokpit decides instead of xterm. Only Shift+Enter: xterm sends a bare CR
// for it, the same byte as Enter, so a program cannot tell them apart and Claude Code sent the prompt instead of
// starting a new line. Kokpit sends the setting's sequence instead (terminal-keys.defaults.json; default ESC CR,
// what Claude Code reads as a new line — the bytes of Option+Enter, and what its /terminal-setup makes other
// terminals send). Every other key, arrows included, stays exactly xterm's.
// Kept apart from xterm-view.ts so it runs against a minimal terminal in unit tests.
import defaults from "../engine/terminal-keys.defaults.json" with { type: "json" };

export interface TerminalKeysConfig {
  /** What Shift+Enter sends; "" leaves it to xterm (a bare CR). */
  shiftEnter: string;
}

/** Longer than any key sequence; a longer setting is a mistake. */
const MAX_SEQUENCE = 64;
/** A key sequence starts with a control character; printable text would be typed into the program. */
const FIRST_PRINTABLE = 0x20;
/** keyCode of a key an input method is handling. */
const IME_KEY_CODE = 229;

/** A broken setting: Shift+Enter left to xterm, as if Kokpit did nothing. */
const XTERM_OWN = "";

function validSequence(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_SEQUENCE && (v === "" || v.charCodeAt(0) < FIRST_PRINTABLE);
}

/** The settings from an untrusted object: an unusable value leaves the key to xterm. */
export function readTerminalKeysConfig(raw: unknown): TerminalKeysConfig {
  const shiftEnter = raw !== null && typeof raw === "object" ? (raw as { shiftEnter?: unknown }).shiftEnter : undefined;
  return { shiftEnter: validSequence(shiftEnter) ? shiftEnter : XTERM_OWN };
}

export const terminalKeysConfig: TerminalKeysConfig = readTerminalKeysConfig(defaults);

/** The part of xterm's `Terminal` used here. */
export interface KeyTerm {
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  input(data: string, wasUserInput?: boolean): void;
}

function isShiftEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing && e.keyCode !== IME_KEY_CODE;
}

/** xterm calls the handler for keydown, keypress and keyup; `false` means xterm does nothing with that event. */
export function attachTerminalKeys(term: KeyTerm, config: TerminalKeysConfig): void {
  term.attachCustomKeyEventHandler((e) => {
    if (config.shiftEnter === "" || !isShiftEnter(e)) return true;
    if (e.type === "keydown") {
      e.preventDefault();
      // As if typed: through xterm's onData, to the program, exactly once per press.
      term.input(config.shiftEnter, true);
    }
    return false;
  });
}
