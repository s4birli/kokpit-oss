// i18n: an error response may carry a catalog key and params next to its message. The message stays (an older app
// shows it); a newer app translates the key into its own language. Both directions of a version skew must parse.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseServerMessage } from "./protocol.ts";

const res = (error: unknown): string => JSON.stringify({ type: "res", id: 1, ok: false, error });

describe("error key + params", () => {
  it("parses an error with key and params", () => {
    const r = parseServerMessage(res({ code: "INVALID", message: "http(s) adresi olmalı", key: "engine.browser.urlScheme", params: { n: 3, name: "x" } }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === "res" && !r.value.ok) {
      expect(r.value.error.key).toBe("engine.browser.urlScheme");
      expect(r.value.error.params).toEqual({ n: 3, name: "x" });
    }
  });

  it("still parses an old engine's error (message only)", () => {
    const r = parseServerMessage(res({ code: "INVALID", message: "eski" }));
    expect(r.ok).toBe(true);
  });

  it("an old app's schema (code + message, non-strict) accepts a new engine's error", () => {
    const OldError = z.object({ code: z.string(), message: z.string() });
    const parsed = OldError.parse({ code: "INVALID", message: "m", key: "engine.x", params: { a: 1 } });
    expect(parsed).toEqual({ code: "INVALID", message: "m" });
  });

  it("drops a malformed key or params rather than refusing the response", () => {
    for (const bad of [
      { key: 5 },
      { key: "x".repeat(1000) },
      { key: "bad key!" },
      { params: { a: { nested: 1 } } },
      { params: "nope" },
      { params: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, i])) },
    ]) {
      const r = parseServerMessage(res({ code: "INVALID", message: "m", ...bad }));
      expect(r.ok, JSON.stringify(bad).slice(0, 80)).toBe(true);
      if (r.ok && r.value.type === "res" && !r.value.ok) {
        expect(r.value.error.message).toBe("m");
        expect(r.value.error.key === undefined || r.value.error.params === undefined).toBe(true);
      }
    }
  });
});
