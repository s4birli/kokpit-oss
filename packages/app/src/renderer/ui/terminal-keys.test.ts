// Tuşlar: the keys Kokpit sends itself instead of xterm — Shift+Enter (xterm sends a bare CR, the same as Enter,
// so Claude Code could not tell them apart and sent the prompt). Every other key stays xterm's.
import { describe, expect, it, vi } from "vitest";
import defaults from "../engine/terminal-keys.defaults.json" with { type: "json" };
import { attachTerminalKeys, readTerminalKeysConfig, terminalKeysConfig, type KeyTerm, type TerminalKeysConfig } from "./terminal-keys.ts";

const cfg: TerminalKeysConfig = { shiftEnter: "\x1b\r" };

type Init = Partial<Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">>;
function ev(type: string, init: Init): KeyboardEvent & { prevented: boolean } {
  const e = {
    type,
    key: "",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    prevented: false,
    preventDefault() {
      e.prevented = true;
    },
    ...init,
  };
  return e as unknown as KeyboardEvent & { prevented: boolean };
}

function fakeTerm(): KeyTerm & { handler: ((e: KeyboardEvent) => boolean) | undefined; sent: string[] } {
  const t = {
    handler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
    sent: [] as string[],
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
      t.handler = h;
    },
    input(data: string, wasUserInput?: boolean) {
      expect(wasUserInput).toBe(true);
      t.sent.push(data);
    },
  };
  return t;
}

/** A key as the browser delivers it to xterm: keydown, keypress (printable and Enter), keyup. Returns xterm's verdicts. */
function press(term: ReturnType<typeof fakeTerm>, init: Init): { verdicts: boolean[]; prevented: boolean } {
  const down = ev("keydown", init);
  const verdicts = [term.handler!(down), term.handler!(ev("keypress", init)), term.handler!(ev("keyup", init))];
  return { verdicts, prevented: down.prevented };
}

describe("attachTerminalKeys", () => {
  it("Shift+Enter sends the configured sequence once, and xterm sends nothing for it (keydown, keypress, keyup)", () => {
    const term = fakeTerm();
    attachTerminalKeys(term, cfg);
    const r = press(term, { key: "Enter", shiftKey: true });
    expect(term.sent).toEqual(["\x1b\r"]);
    expect(r.verdicts).toEqual([false, false, false]);
    expect(r.prevented).toBe(true);
  });

  it("the sequence is the setting's (e.g. the kitty encoding), sent verbatim", () => {
    const term = fakeTerm();
    attachTerminalKeys(term, { shiftEnter: "\x1b[13;2u" });
    press(term, { key: "Enter", shiftKey: true });
    expect(term.sent).toEqual(["\x1b[13;2u"]);
  });

  it.each<[string, Init]>([
    ["Enter", { key: "Enter" }],
    ["Option+Enter", { key: "Enter", altKey: true }],
    ["Shift+Option+Enter", { key: "Enter", shiftKey: true, altKey: true }],
    ["Ctrl+Shift+Enter", { key: "Enter", shiftKey: true, ctrlKey: true }],
    ["Cmd+Shift+Enter", { key: "Enter", shiftKey: true, metaKey: true }],
    ["ArrowUp", { key: "ArrowUp" }],
    ["ArrowDown", { key: "ArrowDown" }],
    ["Shift+ArrowUp", { key: "ArrowUp", shiftKey: true }],
    ["Home", { key: "Home" }],
    ["PageDown", { key: "PageDown" }],
    ["Tab", { key: "Tab" }],
    ["Shift+Tab", { key: "Tab", shiftKey: true }],
    ["Escape", { key: "Escape" }],
    ["Ctrl+C", { key: "c", ctrlKey: true }],
    ["Ctrl+J", { key: "j", ctrlKey: true }],
    ["Cmd+V", { key: "v", metaKey: true }],
    ["Shift+a", { key: "A", shiftKey: true }],
  ])("%s stays xterm's: nothing sent here, nothing prevented", (_name, init) => {
    const term = fakeTerm();
    attachTerminalKeys(term, cfg);
    const r = press(term, init);
    expect(term.sent).toEqual([]);
    expect(r.verdicts).toEqual([true, true, true]);
    expect(r.prevented).toBe(false);
  });

  it("Shift+Enter that confirms an input method's composition is the input method's", () => {
    const term = fakeTerm();
    attachTerminalKeys(term, cfg);
    expect(press(term, { key: "Enter", shiftKey: true, isComposing: true }).verdicts).toEqual([true, true, true]);
    expect(press(term, { key: "Enter", shiftKey: true, keyCode: 229 }).verdicts).toEqual([true, true, true]);
    expect(term.sent).toEqual([]);
  });

  it("an empty setting leaves Shift+Enter to xterm (a bare CR)", () => {
    const term = fakeTerm();
    attachTerminalKeys(term, { shiftEnter: "" });
    expect(press(term, { key: "Enter", shiftKey: true }).verdicts).toEqual([true, true, true]);
    expect(term.sent).toEqual([]);
  });

  it("held Shift+Enter (key repeat) sends once per keydown", () => {
    const term = fakeTerm();
    attachTerminalKeys(term, cfg);
    for (let i = 0; i < 3; i++) term.handler!(ev("keydown", { key: "Enter", shiftKey: true }));
    expect(term.sent).toEqual(["\x1b\r", "\x1b\r", "\x1b\r"]);
  });

  it("monkey: random key events never throw, and only Shift+Enter keydowns send", () => {
    const term = fakeTerm();
    attachTerminalKeys(term, cfg);
    const keys = ["Enter", "ArrowUp", "a", "", "Escape", "Tab", "Dead", "Unidentified", "\u0000", "Process"];
    const types = ["keydown", "keypress", "keyup", "input", ""];
    const rnd = vi.fn(Math.random);
    let expectedSends = 0;
    for (let i = 0; i < 2000; i++) {
      const init: Init = {
        key: keys[Math.floor(rnd() * keys.length)]!,
        shiftKey: rnd() < 0.5,
        altKey: rnd() < 0.2,
        ctrlKey: rnd() < 0.2,
        metaKey: rnd() < 0.2,
        isComposing: rnd() < 0.1,
      };
      const type = types[Math.floor(rnd() * types.length)]!;
      if (type === "keydown" && init.key === "Enter" && init.shiftKey && !init.altKey && !init.ctrlKey && !init.metaKey && !init.isComposing) expectedSends++;
      expect(() => term.handler!(ev(type, init))).not.toThrow();
    }
    expect(term.sent.length).toBe(expectedSends);
  });
});

describe("terminal key settings", () => {
  it("the shipped default makes Shift+Enter ESC CR — what Claude Code reads as a new line (Option+Enter's bytes)", () => {
    expect(defaults.shiftEnter).toBe("\x1b\r");
    expect(terminalKeysConfig.shiftEnter).toBe("\x1b\r");
  });

  it.each<[string, unknown]>([
    ["not an object", 42],
    ["null", null],
    ["a number", { shiftEnter: 13 }],
    ["too long", { shiftEnter: "\x1b".repeat(65) }],
    ["printable text (would type into the shell)", { shiftEnter: "hello" }],
  ])("a broken setting (%s) leaves Shift+Enter to xterm", (_name, raw) => {
    expect(readTerminalKeysConfig(raw)).toEqual({ shiftEnter: "" });
  });

  it("an empty setting is kept (Shift+Enter left to xterm); a control sequence is kept as is", () => {
    expect(readTerminalKeysConfig({ shiftEnter: "" })).toEqual({ shiftEnter: "" });
    expect(readTerminalKeysConfig({ shiftEnter: "\x1b[13;2u" })).toEqual({ shiftEnter: "\x1b[13;2u" });
    expect(readTerminalKeysConfig({ shiftEnter: "\n" })).toEqual({ shiftEnter: "\n" });
  });
});
