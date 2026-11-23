// Kopyalama — Tarayıcı: the page scripts' answers are untrusted (the page can redefine anything they call).
import { describe, expect, it } from "vitest";
import { BROWSER_LIMITS } from "@kokpit/shared";
import { contextScript, parseContext, parseSelection, selectionScript } from "./browser-clipboard.ts";
import { EngineError } from "./contracts.ts";

const MAX = 20;

describe("parseSelection", () => {
  it("returns the selected text; nothing selected is the empty string", () => {
    expect(parseSelection({ text: "merhaba çğıöşü İ" }, MAX)).toBe("merhaba çğıöşü İ");
    expect(parseSelection({ text: "" }, MAX)).toBe("");
    expect(parseSelection({ text: "x".repeat(MAX) }, MAX)).toBe("x".repeat(MAX));
  });

  it("refuses a selection over the cap — whether the page said so or sent it anyway — without quoting it", () => {
    for (const value of [{ tooLarge: true }, { text: "gizli-parola-".repeat(5) }]) {
      let err: unknown;
      try {
        parseSelection(value, MAX);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe("INVALID");
      expect((err as EngineError).message).toContain(String(MAX));
      expect((err as EngineError).message).not.toContain("gizli");
    }
  });

  it("monkey: anything else a page could return is 'nothing selected', never a throw or a non-string", () => {
    const odd: unknown[] = [undefined, null, 5, "text", [], {}, { text: 5 }, { text: null }, { text: ["a"] }, { text: { toString: () => "x" } }, { tooLarge: "yes" }, { text: "a", extra: 1 }];
    for (const v of odd) expect(parseSelection(v, MAX), JSON.stringify(v)).toBe(v !== null && typeof v === "object" && (v as { text?: unknown }).text === "a" ? "a" : "");
    for (let i = 0; i < 300; i++) {
      let s = "";
      for (let j = 0; j < (i % MAX) + 1; j++) s += String.fromCharCode(Math.floor(Math.random() * 0x10000));
      expect(parseSelection({ text: s }, MAX)).toBe(s);
    }
  });
});

describe("parseContext", () => {
  it("keeps the flags and an http(s) link", () => {
    expect(parseContext({ hasSelection: true, editable: false, linkUrl: "https://example.com/a?b=ç" })).toEqual({ hasSelection: true, editable: false, linkUrl: "https://example.com/a?b=ç" });
    expect(parseContext({ hasSelection: false, editable: true, linkUrl: "" })).toEqual({ hasSelection: false, editable: true });
  });

  it("drops links that are not http(s), not URLs or too long; unknown shapes mean 'nothing'", () => {
    const none = { hasSelection: false, editable: false };
    for (const linkUrl of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "not a url", `https://e.com/${"a".repeat(BROWSER_LIMITS.maxUrlLength)}`, 5, null]) {
      expect(parseContext({ hasSelection: false, editable: false, linkUrl }), String(linkUrl).slice(0, 30)).toEqual(none);
    }
    for (const v of [undefined, null, "x", 1, [], { hasSelection: "yes", editable: 1 }]) expect(parseContext(v)).toEqual(none);
  });
});

describe("the page scripts", () => {
  it("carry only numbers and booleans from the request — never text", () => {
    const s = selectionScript({ maxChars: 1234, cut: true });
    expect(s).toContain("1234");
    expect(s).toContain("password");
    expect(() => new Function(`return ${s}`)).not.toThrow();
    const c = contextScript({ x: 10.5, y: 20, maxUrlLength: 99 });
    expect(c).toContain("10.5");
    expect(() => new Function(`return ${c}`)).not.toThrow();
  });

  it("refuse non-finite numbers instead of writing them into code", () => {
    expect(() => contextScript({ x: Number.NaN, y: 1, maxUrlLength: 10 })).toThrow();
    expect(() => contextScript({ x: 1, y: Number.POSITIVE_INFINITY, maxUrlLength: 10 })).toThrow();
    expect(() => selectionScript({ maxChars: Number.NaN, cut: false })).toThrow();
  });
});
