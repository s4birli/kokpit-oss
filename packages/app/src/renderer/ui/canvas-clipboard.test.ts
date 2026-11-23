// Kopyalama — the streamed panels' canvas: where the browser's copy / cut / paste events really arrive.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachCanvasClipboard } from "./canvas-clipboard.ts";

let canvas: HTMLCanvasElement;
let other: HTMLInputElement;
let text: HTMLParagraphElement;
let calls: string[];
let detach: () => void;

function fire(type: "copy" | "cut" | "paste" | "beforecopy" | "beforecut" | "beforepaste", target: EventTarget, data?: string): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  if (data !== undefined) Object.defineProperty(ev, "clipboardData", { value: { getData: (t: string) => (t === "text/plain" ? data : "") } });
  target.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  document.body.innerHTML = '<canvas tabindex="0"></canvas><input><p>seçilebilir metin</p>';
  canvas = document.querySelector("canvas")!;
  other = document.querySelector("input")!;
  text = document.querySelector("p")!;
  calls = [];
  detach = attachCanvasClipboard(canvas, {
    copy: () => calls.push("copy"),
    cut: () => calls.push("cut"),
    paste: (t) => calls.push(`paste:${t}`),
  });
});
afterEach(() => detach());

describe("attachCanvasClipboard", () => {
  it("handles the events while the canvas has the keyboard focus, wherever the browser aims them", () => {
    canvas.focus();
    // Chromium sends a menu's copy / paste to the selection's element — or to <body> when nothing is selected —
    // not to the focused element.
    for (const target of [canvas, document.body, text]) {
      calls = [];
      const copy = fire("copy", target);
      const cut = fire("cut", target);
      const paste = fire("paste", target, "yapıştırılan çğ");
      expect(calls, target.nodeName).toEqual(["copy", "cut", "paste:yapıştırılan çğ"]);
      expect([copy.defaultPrevented, cut.defaultPrevented, paste.defaultPrevented]).toEqual([true, true, true]);
    }
  });

  it("a stale text selection elsewhere in the app is not what gets copied: the default copy is cancelled", () => {
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    canvas.focus();
    expect(fire("copy", text).defaultPrevented).toBe(true);
    expect(calls).toEqual(["copy"]);
  });

  it("leaves everything alone while something else has the focus (an input, nothing at all)", () => {
    other.focus();
    for (const type of ["copy", "cut", "paste", "beforecopy", "beforepaste"] as const) expect(fire(type, other, "x").defaultPrevented, type).toBe(false);
    other.blur();
    expect(fire("copy", document.body).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it("cancels the before… events for the focused canvas (that is what makes Chromium offer the commands there)", () => {
    canvas.focus();
    for (const type of ["beforecopy", "beforecut", "beforepaste"] as const) expect(fire(type, document.body).defaultPrevented, type).toBe(true);
    expect(calls).toEqual([]);
  });

  it("a paste without clipboard data pastes the empty string; after detach nothing is handled", () => {
    canvas.focus();
    fire("paste", canvas);
    expect(calls).toEqual(["paste:"]);
    detach();
    expect(fire("copy", canvas).defaultPrevented).toBe(false);
    expect(calls).toEqual(["paste:"]);
  });

  it("the handled event does not travel on to other listeners (no second copy by a parent)", () => {
    canvas.focus();
    let seen = 0;
    document.body.addEventListener("copy", () => seen++);
    fire("copy", canvas);
    expect(seen).toBe(0);
  });
});
