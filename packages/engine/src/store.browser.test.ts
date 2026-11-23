// İş B (uzantılar): each project's unpacked-extension folders live in the v2 state file; absent → none.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError, type Logger } from "./contracts.ts";
import { createFileStore, createMemoryStore } from "./store.ts";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-store-ext-"));
  file = join(dir, "state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.each([
  ["file", () => createFileStore(file, logger)],
  ["memory", () => createMemoryStore()],
] as const)("browser extension folders (%s)", (_n, make) => {
  it("starts empty, keeps per-project lists, empty list removes the project", () => {
    const s = make();
    expect(s.getBrowserExtensions("p1")).toEqual([]);
    s.setBrowserExtensions("p1", ["/e/a", "/e/b"]);
    s.setBrowserExtensions("p2", ["/e/c"]);
    expect(s.getBrowserExtensions("p1")).toEqual(["/e/a", "/e/b"]);
    expect(s.getBrowserExtensions("p2")).toEqual(["/e/c"]);
    s.setBrowserExtensions("p1", []);
    expect(s.getBrowserExtensions("p1")).toEqual([]);
  });

  it("returns copies", () => {
    const s = make();
    s.setBrowserExtensions("p1", ["/e/a"]);
    s.getBrowserExtensions("p1").push("/evil");
    expect(s.getBrowserExtensions("p1")).toEqual(["/e/a"]);
  });

  it("refuses relative paths and duplicates", () => {
    const s = make();
    expect(() => s.setBrowserExtensions("p1", ["rel"])).toThrow(EngineError);
    expect(() => s.setBrowserExtensions("p1", ["/a", "/a"])).toThrow(EngineError);
    expect(s.getBrowserExtensions("p1")).toEqual([]);
  });
});

describe("browser extension folders on disk", () => {
  it("survive a reopen; files without any keep their shape (field absent)", () => {
    const s = createFileStore(file, logger);
    s.markSeeded("x");
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("browserExtensions");
    s.setBrowserExtensions("p1", ["/e/a"]);
    expect(createFileStore(file, logger).getBrowserExtensions("p1")).toEqual(["/e/a"]);
    s.setBrowserExtensions("p1", []);
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("browserExtensions");
  });
});
