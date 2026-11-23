import { describe, expect, it } from "vitest";
import { BROWSER_LIMITS, BrowserInputEventSchema, BrowserUrlSchema } from "@kokpit/shared";
import { keyEventFrom, modifiersOf, panelViewport, resolveAddress, screencastSize, toPagePoint, wheelEventFrom } from "./browser-input.ts";

const meta = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };

describe("toPagePoint", () => {
  it("maps a canvas point to page CSS px through the image size", () => {
    // Canvas shown at 640x400 CSS px, image 1280x800 px, page 1280x800 CSS px.
    expect(toPagePoint({ x: 320, y: 200 }, { width: 640, height: 400 }, { width: 1280, height: 800 }, meta)).toEqual({ x: 640, y: 400 });
  });

  it("handles HiDPI frames (image bigger than the page)", () => {
    expect(toPagePoint({ x: 100, y: 50 }, { width: 640, height: 400 }, { width: 2560, height: 1600 }, meta)).toEqual({ x: 200, y: 100 });
  });

  it("subtracts offsetTop and clamps into the page", () => {
    const m = { ...meta, offsetTop: 20 };
    expect(toPagePoint({ x: 0, y: 5 }, { width: 1280, height: 800 }, { width: 1280, height: 800 }, m)).toEqual({ x: 0, y: 0 });
    expect(toPagePoint({ x: 5000, y: 5000 }, { width: 1280, height: 800 }, { width: 1280, height: 800 }, meta)).toEqual({ x: 1280, y: 800 });
    expect(toPagePoint({ x: -10, y: -10 }, { width: 1280, height: 800 }, { width: 1280, height: 800 }, meta)).toEqual({ x: 0, y: 0 });
  });

  it("returns null when nothing is measurable", () => {
    expect(toPagePoint({ x: 1, y: 1 }, { width: 0, height: 400 }, { width: 1280, height: 800 }, meta)).toBeNull();
    expect(toPagePoint({ x: 1, y: 1 }, { width: 640, height: 400 }, { width: 0, height: 0 }, meta)).toBeNull();
    expect(toPagePoint({ x: Number.NaN, y: 1 }, { width: 640, height: 400 }, { width: 1280, height: 800 }, meta)).toBeNull();
  });

  it("monkey: always a protocol-valid coordinate or null", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 20000 - 5000;
    for (let i = 0; i < 500; i++) {
      const p = toPagePoint({ x: rnd(), y: rnd() }, { width: rnd(), height: rnd() }, { width: rnd(), height: rnd() }, {
        ...meta,
        deviceWidth: rnd(),
        deviceHeight: rnd(),
        offsetTop: rnd(),
      });
      if (p) expect(BrowserInputEventSchema.safeParse({ type: "mouse", action: "move", ...p }).success).toBe(true);
    }
  });
});

describe("keyEventFrom", () => {
  const base = { key: "a", code: "KeyA", keyCode: 65, location: 0, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  it("builds a protocol key event with modifiers", () => {
    const ev = keyEventFrom({ ...base, shiftKey: true }, "down");
    expect(ev).toEqual({
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      location: 0,
      modifiers: { alt: false, ctrl: false, meta: false, shift: true },
    });
    expect(BrowserInputEventSchema.safeParse(ev).success).toBe(true);
  });
  it("marks repeats and drops what the protocol would refuse", () => {
    expect(keyEventFrom({ ...base, repeat: true }, "down")).toMatchObject({ repeat: true });
    expect(keyEventFrom({ ...base, key: "" }, "down")).toBeNull();
    expect(keyEventFrom({ ...base, key: "x".repeat(BROWSER_LIMITS.maxKeyLength + 1) }, "down")).toBeNull();
    expect(keyEventFrom({ ...base, keyCode: 5000 }, "up")).not.toHaveProperty("keyCode");
  });
  it("modifiersOf", () => {
    expect(modifiersOf({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: false })).toEqual({ alt: true, ctrl: false, meta: true, shift: false });
  });
});

describe("wheelEventFrom", () => {
  it("clamps deltas into the protocol range and converts line/page modes to pixels", () => {
    const m = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(wheelEventFrom({ x: 1, y: 2 }, { deltaX: 0, deltaY: 3, deltaMode: 1, ...m }, { lineHeight: 16, pageHeight: 800 })).toMatchObject({
      deltaY: 48,
    });
    expect(wheelEventFrom({ x: 1, y: 2 }, { deltaX: 0, deltaY: 1, deltaMode: 2, ...m }, { lineHeight: 16, pageHeight: 800 })).toMatchObject({
      deltaY: 800,
    });
    const big = wheelEventFrom({ x: 1, y: 2 }, { deltaX: -1e9, deltaY: 1e9, deltaMode: 0, ...m }, { lineHeight: 16, pageHeight: 800 });
    expect(BrowserInputEventSchema.safeParse(big).success).toBe(true);
  });
});

const SEARCH = "https://www.google.com/search?q=%s";
const search = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

describe("resolveAddress", () => {
  it.each([
    // has a scheme → as is
    ["https://example.com/a", "https://example.com/a"],
    ["http://a.b", "http://a.b"],
    ["HTTPS://Example.com", "HTTPS://Example.com"],
    // looks like a host → https://
    ["  example.com  ", "https://example.com"],
    ["youtube.com", "https://youtube.com"],
    ["example.com/yol?q=1", "https://example.com/yol?q=1"],
    ["sub.example.co.uk:8443/x", "https://sub.example.co.uk:8443/x"],
    ["192.168.1.5:8080", "https://192.168.1.5:8080"],
    ["8.8.8.8", "https://8.8.8.8"],
    // localhost / loopback → http://
    ["localhost", "http://localhost"],
    ["localhost:3000", "http://localhost:3000"],
    ["LOCALHOST:3000/x?y=1", "http://LOCALHOST:3000/x?y=1"],
    ["127.0.0.1", "http://127.0.0.1"],
    ["127.0.0.1:3000/x", "http://127.0.0.1:3000/x"],
    ["[::1]:5173", "http://[::1]:5173"],
    // otherwise → search
    ["youtube", search("youtube")],
    ["türkçe arama", search("türkçe arama")],
    ["iki kelime", search("iki kelime")],
    ["a & b = c?", search("a & b = c?")],
    ["example.com nasıl", search("example.com nasıl")],
    ["note: buy milk", search("note: buy milk")],
    ["100%", search("100%")],
    ["#etiket", search("#etiket")],
    ["..", search("..")],
    ["youtube.", search("youtube.")],
    [".com", search(".com")],
    ["c++", search("c++")],
  ])("%j → %j", (input, out) => {
    expect(resolveAddress(input, SEARCH)).toEqual({ ok: true, url: out });
  });

  it("encodes the query properly (UTF-8, spaces, reserved characters)", () => {
    const r = resolveAddress("türkçe arama", SEARCH);
    expect(r).toEqual({ ok: true, url: "https://www.google.com/search?q=t%C3%BCrk%C3%A7e%20arama" });
  });

  it("uses the configured search engine (every %s is replaced)", () => {
    expect(resolveAddress("kedi", "http://127.0.0.1:9/ara?q=%s&tekrar=%s")).toEqual({ ok: true, url: "http://127.0.0.1:9/ara?q=kedi&tekrar=kedi" });
  });

  it.each(["", "   ", "\t\n"])("refuses empty input %j", (input) => {
    const r = resolveAddress(input, SEARCH);
    expect(r.ok).toBe(false);
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "about:blank", "chrome://extensions", "ftp://x.com", "mailto:a@b.c", "vbscript:x"])(
    "refuses non-http(s) scheme %j with a Turkish message",
    (input) => {
      const r = resolveAddress(input, SEARCH);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/http/);
    },
  );

  it("refuses a search engine template that is not http(s) or has no %s", () => {
    for (const bad of ["", "javascript:%s", "https://e.com/search", "file:///%s"]) {
      expect(resolveAddress("kedi", bad).ok).toBe(false);
    }
  });

  it("refuses results longer than the protocol allows", () => {
    expect(resolveAddress("x".repeat(BROWSER_LIMITS.maxUrlLength + 10), SEARCH).ok).toBe(false);
    expect(resolveAddress("https://e.com/" + "x".repeat(BROWSER_LIMITS.maxUrlLength), SEARCH).ok).toBe(false);
  });

  it("monkey: random input never throws and every ok result is accepted by the engine's URL schema", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alphabet = ["a", "z", "0", "9", ".", ":", "/", " ", "?", "#", "%", "&", "=", "+", "ç", "ş", "ğ", "İ", "😀", "\u0000", "\t", "[", "]", "@", "\\", "-", "_", "~", "localhost", "127.0.0.1", "http://", "https://", "javascript:", ".com"];
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rnd() * 12);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = resolveAddress(s, SEARCH);
      if (r.ok) {
        expect(BrowserUrlSchema.safeParse(r.url).success, JSON.stringify([s, r.url])).toBe(true);
        expect(r.url, s).toMatch(/^https?:\/\//i);
      } else {
        expect(r.error.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("screencastSize", () => {
  it("multiplies by devicePixelRatio, rounds and clamps", () => {
    expect(screencastSize({ width: 640, height: 400 }, 2, 4096)).toEqual({ maxWidth: 1280, maxHeight: 800 });
    expect(screencastSize({ width: 5000, height: 3000 }, 2, 4096)).toEqual({ maxWidth: 4096, maxHeight: 4096 });
    expect(screencastSize({ width: 0, height: 0 }, 1, 4096)).toEqual({ maxWidth: 1, maxHeight: 1 });
    expect(screencastSize({ width: 100.4, height: Number.NaN }, Number.NaN, 4096)).toEqual({ maxWidth: 100, maxHeight: 1 });
  });
});

describe("panelViewport", () => {
  it("whole CSS px of a measurable panel", () => {
    expect(panelViewport({ width: 667, height: 380 }, 64)).toEqual({ width: 667, height: 380 });
    expect(panelViewport({ width: 667.9, height: 380.2 }, 64)).toEqual({ width: 667, height: 380 });
    expect(panelViewport({ width: 99999, height: 380 }, 64)).toEqual({ width: BROWSER_LIMITS.maxViewportDim, height: 380 });
  });

  it("hidden, unmeasurable or too small → null (never a bogus size)", () => {
    for (const box of [
      { width: 0, height: 0 },
      { width: 667, height: 0 },
      { width: 0, height: 380 },
      { width: 63, height: 380 },
      { width: 667, height: 63 },
      { width: Number.NaN, height: 380 },
      { width: 667, height: Number.POSITIVE_INFINITY },
      { width: -5, height: 380 },
    ]) {
      expect(panelViewport(box, 64), JSON.stringify(box)).toBeNull();
    }
    // A minimum below the protocol's is raised to it.
    expect(panelViewport({ width: BROWSER_LIMITS.minViewportDim - 1, height: 380 }, 0)).toBeNull();
    expect(panelViewport({ width: BROWSER_LIMITS.minViewportDim, height: BROWSER_LIMITS.minViewportDim }, Number.NaN)).toEqual({
      width: BROWSER_LIMITS.minViewportDim,
      height: BROWSER_LIMITS.minViewportDim,
    });
  });
});
