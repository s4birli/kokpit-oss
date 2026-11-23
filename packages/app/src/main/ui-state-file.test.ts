// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_STATE_LIMITS } from "../renderer/engine/ui-state-ipc.ts";
import { createUiStateFile, UiStateError } from "./ui-state-file.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-ui-state-"));
  file = join(dir, "sub", "ui-state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state = { version: 1, layouts: { normal: { grid: {} } }, panels: {}, selection: { kind: "project", projectId: "p1" } };

describe("ui-state-file", () => {
  it("returns null when nothing is saved", async () => {
    expect(await createUiStateFile({ filePath: file }).load()).toBeNull();
  });

  it("round-trips through a fresh instance, owner-only file", async () => {
    await createUiStateFile({ filePath: file }).save(state);
    expect(await createUiStateFile({ filePath: file }).load()).toEqual(state);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid input and keeps the previous file", async () => {
    const store = createUiStateFile({ filePath: file });
    await store.save(state);
    await expect(store.save({ nope: true })).rejects.toBeInstanceOf(UiStateError);
    await expect(store.save("x".repeat(10))).rejects.toBeInstanceOf(UiStateError);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(state);
  });

  it("rejects state over the size limit", async () => {
    const store = createUiStateFile({ filePath: file, limits: { ...UI_STATE_LIMITS, maxBytes: 64 } });
    await expect(store.save({ ...state, panels: { a: { b: { c: "x".repeat(100) } } } })).rejects.toBeInstanceOf(UiStateError);
  });

  it("a corrupt, oversized or wrongly-shaped file loads as null", async () => {
    const store = createUiStateFile({ filePath: file, limits: { ...UI_STATE_LIMITS, maxBytes: 200 } });
    await store.save(state);
    writeFileSync(file, "{not json");
    expect(await store.load()).toBeNull();
    writeFileSync(file, JSON.stringify([1, 2]));
    expect(await store.load()).toBeNull();
    writeFileSync(file, JSON.stringify({ ...state, pad: "x".repeat(300) }));
    expect(await store.load()).toBeNull();
  });
});
