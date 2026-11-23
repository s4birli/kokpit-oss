import { describe, expect, it } from "vitest";
import { checkUiState, UI_STATE_LIMITS } from "./ui-state-ipc.ts";

const good = { version: 1, layouts: {}, panels: {}, selection: null };

describe("checkUiState", () => {
  it("accepts a well-formed state and returns its JSON", () => {
    const r = checkUiState(good);
    expect(r).toEqual({ ok: true, json: JSON.stringify(good) });
  });

  it.each([
    ["null", null],
    ["a string", "{}"],
    ["an array", []],
    ["no version", { layouts: {}, panels: {}, selection: null }],
    ["layouts not an object", { ...good, layouts: [] }],
    ["panels not an object", { ...good, panels: "x" }],
    ["selection not an object", { ...good, selection: 5 }],
  ])("rejects %s", (_name, input) => {
    expect(checkUiState(input).ok).toBe(false);
  });

  it("rejects state over the size limit", () => {
    const big = { ...good, panels: { files: { "project:p": { blob: "x".repeat(UI_STATE_LIMITS.maxBytes) } } } };
    expect(checkUiState(big)).toEqual({ ok: false, error: expect.stringMatching(/büyük/) });
    expect(checkUiState(big, { ...UI_STATE_LIMITS, maxBytes: UI_STATE_LIMITS.maxBytes * 2 }).ok).toBe(true);
  });

  it("İş D: accepts per-project layouts up to the cap; more (or a wrong shape) is rejected", () => {
    const limits = { ...UI_STATE_LIMITS, maxProjectLayouts: 2 };
    const withProjects = (projects: unknown) => ({ ...good, version: 2, layouts: { inherited: {}, projects } });
    expect(checkUiState(withProjects({ a: {}, b: {} }), limits).ok).toBe(true);
    expect(checkUiState(withProjects({ a: {}, b: {}, c: {} }), limits)).toEqual({ ok: false, error: expect.stringMatching(/düzen/) });
    expect(checkUiState(withProjects([1]), limits).ok).toBe(false);
    expect(checkUiState(withProjects("x"), limits).ok).toBe(false);
  });

  it("rejects values that are not plain JSON (cycles)", () => {
    const cyc: Record<string, unknown> = { ...good, panels: {} };
    (cyc.panels as Record<string, unknown>).self = cyc;
    expect(checkUiState(cyc).ok).toBe(false);
  });
});
