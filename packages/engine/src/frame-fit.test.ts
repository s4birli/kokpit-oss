import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES } from "@kokpit/shared";
import { fitResultList } from "./frame-fit.ts";

/** The frame the server would write for this result, at the widest request id. */
const frameChars = (result: unknown): number => JSON.stringify({ type: "res", id: Number.MAX_SAFE_INTEGER, ok: true, result }).length;

describe("fitResultList", () => {
  it("a result that fits is returned as it is", () => {
    const result = { items: [{ name: "a" }, { name: "b" }], truncated: false, note: "n" };
    expect(fitResultList(result, "items")).toEqual({ result, cut: false });
    expect(fitResultList(result, "items").result).toBe(result);
  });

  it("keeps the longest prefix of the list that fits the frame limit", () => {
    const item = (n: number) => ({ name: `oge-${n}`, description: "d".repeat(1000) });
    const result = { items: Array.from({ length: 2000 }, (_v, n) => item(n)), truncated: false, claudeMd: { user: true } };
    expect(frameChars(result)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    const fit = fitResultList(result, "items");
    expect(fit.cut).toBe(true);
    expect(frameChars(fit.result)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const kept = fit.result.items.length;
    expect(fit.result.items).toEqual(result.items.slice(0, kept));
    // One more would not have fitted.
    expect(frameChars({ ...result, items: result.items.slice(0, kept + 1) })).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(fit.result.claudeMd).toEqual({ user: true });
    expect(result.items).toHaveLength(2000); // the input is not changed
  });

  it("exact boundaries: limit−1, limit, limit+1", () => {
    const result = { items: ["aaaa", "bbbb", "cccc"], truncated: false };
    const full = frameChars(result);
    expect(fitResultList(result, "items", full + 1).cut).toBe(false);
    expect(fitResultList(result, "items", full).cut).toBe(false);
    const less = fitResultList(result, "items", full - 1);
    expect(less).toEqual({ result: { items: ["aaaa", "bbbb"], truncated: false }, cut: true });
  });

  it("counts JSON escapes: control characters are six characters each", () => {
    const result = { items: ["\x1b".repeat(100), "\x1b".repeat(100)], truncated: false };
    const one = frameChars({ ...result, items: result.items.slice(0, 1) });
    expect(fitResultList(result, "items", one).result.items).toHaveLength(1);
    expect(fitResultList(result, "items", one - 1).result.items).toHaveLength(0);
  });

  it("monkey: random lists and limits — the result always fits, and is a maximal prefix", () => {
    let seed = 2026;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pieces = ["a", "ç", "😀", "\x1b", "\n", '"', "\\", "\ud83d"];
    for (let i = 0; i < 300; i++) {
      const items = Array.from({ length: Math.floor(next() * 30) }, () =>
        Array.from({ length: Math.floor(next() * 20) }, () => pieces[Math.floor(next() * pieces.length)]).join(""),
      );
      const result = { items, truncated: false };
      const limit = frameChars({ ...result, items: [] }) + Math.floor(next() * 400);
      const fit = fitResultList(result, "items", limit);
      const kept = fit.result.items.length;
      expect(frameChars(fit.result)).toBeLessThanOrEqual(limit);
      expect(fit.result.items).toEqual(items.slice(0, kept));
      expect(fit.cut).toBe(kept < items.length);
      if (fit.cut) expect(frameChars({ ...result, items: items.slice(0, kept + 1) })).toBeGreaterThan(limit);
    }
  });
});
