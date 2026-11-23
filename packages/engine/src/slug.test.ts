import { describe, expect, it } from "vitest";
import { slugify } from "./slug.ts";

const MAX = 40;
const FALLBACK = "kart";
const s = (name: string, max = MAX) => slugify(name, max, FALLBACK);

function assertSafe(slug: string, max = MAX) {
  expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  expect(slug.length).toBeLessThanOrEqual(max);
  expect(slug).not.toBe(".");
  expect(slug).not.toBe("..");
}

describe("slugify", () => {
  it("transliterates Turkish characters", () => {
    expect(s("Şeker Ğı İöüç")).toBe("seker-gi-iouc");
    expect(s("ŞĞIİÖÜÇ şğıiöüç")).toBe("sgiiouc-sgiiouc");
  });

  it("strips diacritics from other scripts", () => {
    expect(s("Crème brûlée à la façon")).toBe("creme-brulee-a-la-facon");
  });

  it("lowercases and collapses separators", () => {
    expect(s("  Hello   World__Foo!!Bar  ")).toBe("hello-world-foo-bar");
  });

  it("removes path traversal and slashes", () => {
    const out = s("../../etc/passwd");
    expect(out).toBe("etc-passwd");
    assertSafe(out);
  });

  it("never starts with a dash", () => {
    expect(s("-rf")).toBe("rf");
    expect(s("--- -x")).toBe("x");
  });

  it("falls back for empty or symbol-only input", () => {
    expect(s("")).toBe(FALLBACK);
    expect(s("   \t\n ")).toBe(FALLBACK);
    expect(s("🚀🔥")).toBe(FALLBACK);
    expect(s("..")).toBe(FALLBACK);
    expect(s(".")).toBe(FALLBACK);
    expect(s("///")).toBe(FALLBACK);
  });

  it("keeps ascii parts around emoji", () => {
    expect(s("fix 🚀 bug")).toBe("fix-bug");
  });

  it("cuts to maxLen and re-trims a trailing dash", () => {
    expect(s("a".repeat(5000)).length).toBe(MAX);
    expect(s("abcd efgh", 5)).toBe("abcd");
  });

  it("produces safe output for random input", () => {
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(Math.random() * 60);
      let str = "";
      for (let j = 0; j < len; j++) str += String.fromCodePoint(Math.floor(Math.random() * 0x2ffff));
      const out = s(str);
      if (out !== FALLBACK) assertSafe(out);
    }
  });
});
