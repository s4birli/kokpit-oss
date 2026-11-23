import { describe, expect, it } from "vitest";
import { keysEqual } from "./auth.ts";

describe("keysEqual", () => {
  it("is true for identical keys", () => {
    expect(keysEqual("s3cret-key", "s3cret-key")).toBe(true);
  });
  it("is false for different keys of the same length", () => {
    expect(keysEqual("s3cret-key", "s3cret-kez")).toBe(false);
  });
  it("is false for different lengths (no throw from timingSafeEqual)", () => {
    expect(keysEqual("short", "a-much-longer-key")).toBe(false);
    expect(keysEqual("", "x")).toBe(false);
  });
  it("is false for a prefix", () => {
    expect(keysEqual("s3cret", "s3cret-key")).toBe(false);
  });
  it("handles unicode", () => {
    expect(keysEqual("anahtarğüş", "anahtarğüş")).toBe(true);
    expect(keysEqual("anahtarğüş", "anahtargus")).toBe(false);
  });
  it("never accepts an empty configured key", () => {
    expect(keysEqual("", "")).toBe(false);
  });
});
