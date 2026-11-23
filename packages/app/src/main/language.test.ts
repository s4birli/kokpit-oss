import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLanguageStore, defaultLanguage, LANGUAGE_TEST_ENV } from "./language.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-lang-"));
  file = join(dir, "language.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("defaultLanguage", () => {
  it("is the build's default", () => {
    expect(defaultLanguage({ compiled: "tr", env: {}, isPackaged: true })).toBe("tr");
    expect(defaultLanguage({ compiled: "en", env: {}, isPackaged: false })).toBe("en");
  });
  it("a test run (unpackaged) may name another one; a packaged app ignores it", () => {
    expect(defaultLanguage({ compiled: "en", env: { [LANGUAGE_TEST_ENV]: "tr" }, isPackaged: false })).toBe("tr");
    expect(defaultLanguage({ compiled: "en", env: { [LANGUAGE_TEST_ENV]: "tr" }, isPackaged: true })).toBe("en");
  });
  it("an unsupported compiled or test value falls back to a supported language", () => {
    expect(defaultLanguage({ compiled: "xx", env: { [LANGUAGE_TEST_ENV]: "yy" }, isPackaged: false })).toMatch(/^(en|tr)$/);
  });
});

describe("language store", () => {
  it("without a file: the default", () => {
    expect(createLanguageStore({ filePath: file, fallback: "tr" }).load()).toBe("tr");
  });

  it("keeps the choice across restarts", async () => {
    await createLanguageStore({ filePath: file, fallback: "tr" }).save("en");
    expect(createLanguageStore({ filePath: file, fallback: "tr" }).load()).toBe("en");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ language: "en" });
  });

  it("a corrupt, foreign or hostile file is the default", () => {
    for (const content of ["{", "[]", '"en"', '{"language":"xx"}', '{"language":5}', '{"__proto__":{"language":"en"}}', "x".repeat(100_000)]) {
      writeFileSync(file, content);
      expect(createLanguageStore({ filePath: file, fallback: "tr" }).load(), content.slice(0, 30)).toBe("tr");
    }
  });

  it("refuses to store an unsupported language", async () => {
    const store = createLanguageStore({ filePath: file, fallback: "tr" });
    for (const bad of ["xx", "", null, 5, { language: "en" }, "en\u0000"]) await expect(store.save(bad)).rejects.toThrow();
    expect(store.load()).toBe("tr");
  });
});
