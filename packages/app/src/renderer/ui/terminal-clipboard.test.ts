import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t as msg } from "../../i18n/index.ts";
import { clipboardConfig, type ClipboardConfig } from "../engine/clipboard-ipc.ts";
import { attachTerminalClipboard, resetSelectionHintForTests, type ClipboardTerm } from "./terminal-clipboard.ts";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const cfg: ClipboardConfig = { ...clipboardConfig, selectionHintMs: 1000, selectionHintMinDragPx: 5 };

const attached: { dispose(): void }[] = [];

function setup(over: { config?: Partial<ClipboardConfig>; isMac?: boolean; focused?: boolean; mouse?: ClipboardTerm["modes"]["mouseTrackingMode"] } = {}) {
  let osc: ((data: string) => boolean) | undefined;
  const oscDispose = vi.fn();
  const term: ClipboardTerm = {
    parser: {
      registerOscHandler: (id, cb) => {
        expect(id).toBe(52);
        osc = cb;
        return { dispose: oscDispose };
      },
    },
    modes: { mouseTrackingMode: over.mouse ?? "none" },
  };
  const container = document.createElement("div");
  const screen = document.createElement("div");
  container.append(screen);
  document.body.append(container);
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  const state = { replaying: false, focused: over.focused ?? true };
  const handle = attachTerminalClipboard(term, container, {
    config: { ...cfg, ...over.config },
    isMac: over.isMac ?? true,
    writeText,
    hasFocus: () => state.focused,
    replaying: () => state.replaying,
  });
  attached.push(handle);
  /** mousedown events that reach the terminal (xterm listens below the container). */
  const seen: MouseEvent[] = [];
  screen.addEventListener("mousedown", (e) => seen.push(e));
  return { term, container, screen, writeText, state, handle, oscDispose, seen, osc: (data: string) => osc!(data) };
}

const mouse = (type: string, init: MouseEventInit = {}): MouseEvent => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
const hints = (el: HTMLElement): string[] => Array.from(el.querySelectorAll(".kp-term__hint"), (h) => h.textContent ?? "");

beforeEach(() => {
  vi.useFakeTimers();
  resetSelectionHintForTests();
});
afterEach(() => {
  for (const h of attached.splice(0)) h.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("OSC 52", () => {
  it("writes the decoded text through the bridge and consumes the sequence", () => {
    const s = setup();
    expect(s.osc(`c;${b64("kopya çğ")}`)).toBe(true);
    expect(s.writeText).toHaveBeenCalledExactlyOnceWith("kopya çğ");
  });

  it("consumes but ignores reads, garbage and oversized payloads", () => {
    const s = setup({ config: { osc52MaxBytes: 4 } });
    for (const bad of ["c;?", "c;@@@", "", "c;" + b64("12345")]) expect(s.osc(bad)).toBe(true);
    expect(s.writeText).not.toHaveBeenCalled();
  });

  it("ignores writes replayed from the engine's buffer", () => {
    const s = setup();
    s.state.replaying = true;
    expect(s.osc(`c;${b64("eski")}`)).toBe(true);
    expect(s.writeText).not.toHaveBeenCalled();
    s.state.replaying = false;
    s.osc(`c;${b64("yeni")}`);
    expect(s.writeText).toHaveBeenCalledExactlyOnceWith("yeni");
  });

  it("only the focused terminal may write, unless configured otherwise", () => {
    const s = setup({ focused: false });
    s.osc(`c;${b64("a")}`);
    expect(s.writeText).not.toHaveBeenCalled();
    const open = setup({ focused: false, config: { osc52RequireFocus: false } });
    open.osc(`c;${b64("a")}`);
    expect(open.writeText).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("a failing clipboard write does not throw into the parser", async () => {
    const s = setup();
    s.writeText.mockRejectedValueOnce(new Error("no"));
    expect(s.osc(`c;${b64("a")}`)).toBe(true);
    await Promise.resolve();
  });

  it("dispose unregisters the handler and the listeners", () => {
    const s = setup({ mouse: "drag" });
    s.handle.dispose();
    expect(s.oscDispose).toHaveBeenCalled();
    s.screen.dispatchEvent(mouse("mousedown", { shiftKey: true }));
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.shiftKey).toBe(true);
  });
});

describe("Shift-drag on macOS while the program tracks the mouse", () => {
  it("reaches xterm as an Option press (which forces selection there), same position and click count", () => {
    const s = setup({ mouse: "drag" });
    const original = mouse("mousedown", { shiftKey: true, clientX: 40, clientY: 50, detail: 2, buttons: 1 });
    s.screen.dispatchEvent(original);
    expect(original.defaultPrevented).toBe(true);
    expect(s.seen).toHaveLength(1);
    const e = s.seen[0]!;
    expect(e).not.toBe(original);
    expect([e.altKey, e.shiftKey, e.clientX, e.clientY, e.detail, e.button, e.buttons]).toEqual([true, false, 40, 50, 2, 0, 1]);
  });

  it.each([
    ["mouse tracking off", { mouse: "none" as const }, { shiftKey: true }],
    ["not macOS (xterm handles Shift itself)", { mouse: "drag" as const, isMac: false }, { shiftKey: true }],
    ["switched off in config", { mouse: "drag" as const, config: { macShiftDragForcesSelection: false } }, { shiftKey: true }],
    ["Option-drag: xterm's own", { mouse: "drag" as const }, { altKey: true }],
    ["another button", { mouse: "drag" as const }, { shiftKey: true, button: 2 }],
    ["no modifier: the program's", { mouse: "drag" as const }, {}],
  ])("leaves the event alone: %s", (_name, over, init) => {
    const s = setup(over);
    const original = mouse("mousedown", init);
    s.screen.dispatchEvent(original);
    expect(s.seen).toEqual([original]);
  });
});

describe("selection hint", () => {
  const drag = (s: ReturnType<typeof setup>, dx: number, init: MouseEventInit = {}): void => {
    s.screen.dispatchEvent(mouse("mousedown", { clientX: 10, clientY: 10, ...init }));
    document.dispatchEvent(mouse("mouseup", { clientX: 10 + dx, clientY: 10 }));
  };

  it("shows once after a plain drag went to a mouse-tracking program, then goes away", () => {
    const s = setup({ mouse: "drag" });
    drag(s, 30);
    expect(hints(s.container)).toEqual([msg("terminal.clipboard.selectionHint")]);
    expect(s.container.querySelector(".kp-term__hint")!.getAttribute("role")).toBe("status");
    vi.advanceTimersByTime(cfg.selectionHintMs);
    expect(hints(s.container)).toEqual([]);
    // Once per app run — also in other terminals.
    drag(s, 30);
    const other = setup({ mouse: "any" });
    drag(other, 30);
    expect(hints(s.container)).toEqual([]);
    expect(hints(other.container)).toEqual([]);
  });

  it.each([
    ["a click", { mouse: "drag" as const }, 2, {}],
    ["mouse tracking off", { mouse: "none" as const }, 30, {}],
    ["Option-drag", { mouse: "drag" as const }, 30, { altKey: true }],
    ["Shift-drag", { mouse: "drag" as const }, 30, { shiftKey: true }],
    ["right button", { mouse: "drag" as const }, 30, { button: 2 }],
  ])("not for %s", (_name, over, dx, init) => {
    const s = setup(over);
    drag(s, dx, init);
    expect(hints(s.container)).toEqual([]);
  });

  it("dispose removes a visible hint", () => {
    const s = setup({ mouse: "drag" });
    drag(s, 30);
    s.handle.dispose();
    expect(hints(s.container)).toEqual([]);
  });
});
