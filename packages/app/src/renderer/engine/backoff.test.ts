import { describe, expect, it } from "vitest";
import { backoffDelay } from "./backoff.ts";

const policy = { initialMs: 100, maxMs: 1000, multiplier: 2, jitter: 0.5 };

describe("backoffDelay", () => {
  it("grows exponentially (random=1 means no jitter reduction)", () => {
    expect(backoffDelay(0, policy, () => 1)).toBe(100);
    expect(backoffDelay(1, policy, () => 1)).toBe(200);
    expect(backoffDelay(2, policy, () => 1)).toBe(400);
  });

  it("caps at maxMs", () => {
    expect(backoffDelay(10, policy, () => 1)).toBe(1000);
    expect(backoffDelay(10_000, policy, () => 1)).toBe(1000);
  });

  it("jitter subtracts up to jitter*base", () => {
    expect(backoffDelay(0, policy, () => 0)).toBe(50);
    expect(backoffDelay(3, policy, () => 0)).toBe(400);
  });

  it("stays within [base*(1-jitter), base] for random inputs", () => {
    for (let i = 0; i < 200; i++) {
      const attempt = Math.floor(Math.random() * 20);
      const d = backoffDelay(attempt, policy);
      const base = Math.min(1000, 100 * 2 ** attempt);
      expect(d).toBeGreaterThanOrEqual(base * 0.5);
      expect(d).toBeLessThanOrEqual(base);
    }
  });

  it("treats negative / non-finite attempts as 0 and clamps bad jitter", () => {
    expect(backoffDelay(-5, policy, () => 1)).toBe(100);
    expect(backoffDelay(Number.NaN, policy, () => 1)).toBe(100);
    expect(backoffDelay(0, { ...policy, jitter: 5 }, () => 0)).toBe(0);
    expect(backoffDelay(0, { ...policy, jitter: -1 }, () => 0)).toBe(100);
  });
});
