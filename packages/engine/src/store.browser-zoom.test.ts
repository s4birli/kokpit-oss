// The page zoom of each project's browser is the engine's (one value for every app that shows it) and lives in the
// v2 state file. The field is absent in files written before it (and whenever empty): such a file loads as "nobody
// chose a zoom yet", which is what lets an app hand over the zoom it used to keep itself.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_LIMITS } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError, type Logger } from "./contracts.ts";
import { createFileStore, createMemoryStore } from "./store.ts";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-store-zoom-"));
  file = join(dir, "state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.each([
  ["file", () => createFileStore(file, logger)],
  ["memory", () => createMemoryStore()],
] as const)("browser zoom (%s)", (_n, make) => {
  it("undefined = never chosen; a number = the user's zoom; null = the user chose the default; undefined forgets", () => {
    const s = make();
    expect(s.getBrowserZoom("p1")).toBeUndefined();
    s.setBrowserZoom("p1", 1.25);
    s.setBrowserZoom("p2", 0.8);
    expect(s.getBrowserZoom("p1")).toBe(1.25);
    s.setBrowserZoom("p1", null);
    expect(s.getBrowserZoom("p1")).toBeNull();
    expect(s.getBrowserZoom("p2")).toBe(0.8);
    s.setBrowserZoom("p1", undefined);
    expect(s.getBrowserZoom("p1")).toBeUndefined();
  });

  it("refuses a zoom outside the protocol's range", () => {
    const s = make();
    for (const bad of [0, -1, BROWSER_LIMITS.minZoom / 2, BROWSER_LIMITS.maxZoom + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => s.setBrowserZoom("p1", bad), String(bad)).toThrow(EngineError);
    }
    expect(s.getBrowserZoom("p1")).toBeUndefined();
  });
});

describe("browser zoom in the state file", () => {
  it("survives a restart (number and the chosen default); an empty map is not written", () => {
    const s = createFileStore(file, logger);
    s.markSeeded("x");
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("browserZooms");
    s.setBrowserZoom("p1", 1.1);
    s.setBrowserZoom("p2", null);
    const again = createFileStore(file, logger);
    expect(again.getBrowserZoom("p1")).toBe(1.1);
    expect(again.getBrowserZoom("p2")).toBeNull();
    expect(again.getBrowserZoom("p3")).toBeUndefined();
    again.setBrowserZoom("p1", undefined);
    again.setBrowserZoom("p2", undefined);
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("browserZooms");
  });

  it("migration: a state file written before the field existed loads with no zoom chosen, and keeps its content", () => {
    const s = createFileStore(file, logger);
    s.setBrowserPort("p1", 39201);
    const before = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(before).not.toHaveProperty("browserZooms");
    writeFileSync(file, JSON.stringify(before));
    const old = createFileStore(file, logger);
    expect(old.getBrowserZoom("p1")).toBeUndefined();
    expect(old.getBrowserPort("p1")).toBe(39201);
    old.setBrowserZoom("p1", 0.9);
    expect(createFileStore(file, logger).getBrowserZoom("p1")).toBe(0.9);
    expect(createFileStore(file, logger).getBrowserPort("p1")).toBe(39201);
  });
});
