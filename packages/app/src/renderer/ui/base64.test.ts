import { describe, expect, it } from "vitest";
import { base64ToBytes } from "./base64.ts";

const SIZES = [0, 1, 2, 3, 255, 4096];
const sample = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);
const encode = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
type WithNative = { fromBase64?: (s: string) => Uint8Array };

describe("base64ToBytes", () => {
  it("decodes to the same bytes with the native decoder", () => {
    for (const n of SIZES) expect(base64ToBytes(encode(sample(n)))).toEqual(sample(n));
  });

  it("…and with the fallback when the runtime has no Uint8Array.fromBase64", () => {
    const ctor = Uint8Array as unknown as WithNative;
    const native = ctor.fromBase64;
    ctor.fromBase64 = undefined;
    try {
      for (const n of SIZES) expect(base64ToBytes(encode(sample(n)))).toEqual(sample(n));
    } finally {
      ctor.fromBase64 = native;
    }
  });

  it("monkey: invalid base64 throws (the caller skips that frame)", () => {
    expect(() => base64ToBytes("@@@not base64@@@")).toThrow();
  });
});
