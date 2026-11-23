import { describe, expect, it } from "vitest";
import { childPath, formatBytes, lineNumbers, utf8Length } from "./files-format.ts";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1024, "1 KB"],
    [1536, "1,5 KB"],
    [3 * 1024 * 1024, "3 MB"],
    [5.25 * 1024 ** 3, "5,3 GB"],
  ])("%d → %s", (n, want) => {
    expect(formatBytes(n, "tr-TR")).toBe(want);
  });
});

describe("childPath", () => {
  it("joins with / below the root", () => {
    expect(childPath("", "src")).toBe("src");
    expect(childPath("src", "lib")).toBe("src/lib");
  });
});

describe("lineNumbers", () => {
  it.each([
    ["", "1"],
    ["a", "1"],
    ["a\n", "1"],
    ["a\nb", "1\n2"],
    ["a\r\nb\r\n", "1\n2"],
  ])("%j → %j", (text, want) => {
    expect(lineNumbers(text)).toBe(want);
  });
});

describe("utf8Length", () => {
  it("counts bytes", () => expect(utf8Length("aş")).toBe(3));
});
