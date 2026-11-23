import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { isStrictlyInside, isWithin, loadDefaultsFile, PathSegment } from "./fs-safety.ts";

describe("containment", () => {
  it.each([
    ["/a/b", "/a/b/c", true, true],
    ["/a/b", "/a/b", false, true],
    ["/a/b", "/a/bc", false, false],
    ["/a/b", "/a", false, false],
    ["/a/b/", "/a/b/c", true, true],
    ["/", "/etc", true, true],
  ])("%s vs %s", (dir, p, strict, within) => {
    expect(isStrictlyInside(dir, p)).toBe(strict);
    expect(isWithin(dir, p)).toBe(within);
  });
});

describe("PathSegment", () => {
  it.each(["", ".", "..", "a/b", "a\\b", "x".repeat(256)])("rejects %j", (s) => {
    expect(PathSegment.safeParse(s).success).toBe(false);
  });
  it("accepts a plain name", () => expect(PathSegment.safeParse(".git").success).toBe(true));
});

describe("loadDefaultsFile", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "kokpit-defaults-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const schema = z.object({ a: z.number(), b: z.string() }).strict();

  it("merges overrides over the file and validates", () => {
    const file = join(dir, "x.json");
    writeFileSync(file, JSON.stringify({ a: 1, b: "x" }));
    expect(loadDefaultsFile(schema, { a: 2 }, file, "x")).toEqual({ a: 2, b: "x" });
    expect(() => loadDefaultsFile(schema, { a: "no" }, file, "x")).toThrow(/invalid x config: a/);
    expect(() => loadDefaultsFile(schema, {}, join(dir, "missing.json"), "x")).toThrow(/cannot read x defaults/);
  });
});
