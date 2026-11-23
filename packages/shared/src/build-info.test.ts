import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeBuildInfo, readBuildInfoFile } from "./build-info.ts";

const dir = mkdtempSync(join(tmpdir(), "kokpit-build-info-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const pkg = join(dir, "package.json");
writeFileSync(pkg, JSON.stringify({ version: "1.2.3" }));
const now = new Date("2026-11-18T09:08:07Z");

describe("computeBuildInfo", () => {
  it("version from package.json, commit from git, time of the build", () => {
    const info = computeBuildInfo({ packageJsonPath: pkg, now, git: (args) => (args[0] === "rev-parse" ? "abc1234def\n" : "") });
    expect(info).toEqual({ buildId: "1.2.3+20261118090807.abc1234def", version: "1.2.3", commit: "abc1234def", builtAt: "2026-11-18T09:08:07.000Z" });
  });

  it("uncommitted changes are visible in the id", () => {
    const info = computeBuildInfo({ packageJsonPath: pkg, now, git: (args) => (args[0] === "rev-parse" ? "abc1234def" : " M file.ts\n") });
    expect(info.buildId).toBe("1.2.3+20261118090807.abc1234def.dirty");
  });

  it("outside git the build is still identified", () => {
    const info = computeBuildInfo({
      packageJsonPath: pkg,
      now,
      git: () => {
        throw new Error("not a repo");
      },
    });
    expect(info.buildId).toBe("1.2.3+20261118090807.unknown");
  });

  it("two builds of the same commit get different ids", () => {
    const git = (args: string[]) => (args[0] === "rev-parse" ? "abc" : "");
    const a = computeBuildInfo({ packageJsonPath: pkg, now, git });
    const b = computeBuildInfo({ packageJsonPath: pkg, now: new Date(now.getTime() + 1000), git });
    expect(a.buildId).not.toBe(b.buildId);
  });
});

describe("readBuildInfoFile", () => {
  it("reads a valid file; missing or broken → undefined", () => {
    const info = computeBuildInfo({ packageJsonPath: pkg, now, git: () => "abc" });
    const file = join(dir, "build-info.json");
    writeFileSync(file, JSON.stringify(info));
    expect(readBuildInfoFile(file)).toEqual(info);
    writeFileSync(file, "{");
    expect(readBuildInfoFile(file)).toBeUndefined();
    expect(readBuildInfoFile(join(dir, "none.json"))).toBeUndefined();
  });
});
