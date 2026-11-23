// i18n: the engine's language — for the text it writes itself (terminal notices, result messages) and the `message`
// of its errors. Default from config.defaults.json; engine.json `language`; env KOKPIT_LANGUAGE beats both.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "./contracts.ts";
import { loadConfig } from "./config.ts";

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as { language: string };

let root: string;
let cfgPath: string;
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ KOKPIT_CONFIG: cfgPath, HOME: join(root, "home"), SHELL: "/bin/sh", ...extra });
const write = (o: Record<string, unknown>): void => writeFileSync(cfgPath, JSON.stringify({ dataDir: join(root, "data"), key: "k".repeat(43), ...o }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kokpit-config-lang-"));
  cfgPath = join(root, "engine.json");
  mkdirSync(join(root, "home"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("config language", () => {
  it("defaults to config.defaults.json (the public build: English)", async () => {
    write({});
    expect(defaults.language).toBe("en");
    expect((await loadConfig({ env: env(), logger: quiet })).language).toBe(defaults.language);
  });

  it("engine.json `language` sets it", async () => {
    write({ language: "tr" });
    expect((await loadConfig({ env: env(), logger: quiet })).language).toBe("tr");
  });

  it("env KOKPIT_LANGUAGE beats the file", async () => {
    write({ language: "tr" });
    expect((await loadConfig({ env: env({ KOKPIT_LANGUAGE: "en" }), logger: quiet })).language).toBe("en");
  });

  it("refuses an unsupported language", async () => {
    write({ language: "de" });
    await expect(loadConfig({ env: env(), logger: quiet })).rejects.toThrow(/language/);
    write({});
    await expect(loadConfig({ env: env({ KOKPIT_LANGUAGE: "xx" }), logger: quiet })).rejects.toThrow(/language/);
  });
});
