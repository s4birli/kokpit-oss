import { createHash, timingSafeEqual } from "node:crypto";

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Constant-time key comparison. Hashing first gives equal-length inputs to
 * timingSafeEqual, so neither content nor length leaks through timing.
 * An empty key never matches (a misconfigured empty key must not open the door).
 */
export function keysEqual(a: string, b: string): boolean {
  const same = timingSafeEqual(digest(a), digest(b));
  return same && a.length > 0;
}
