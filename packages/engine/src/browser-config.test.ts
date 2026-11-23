// İş B: the `browser` block of the engine config (defaults + user file, merged per key).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_LIMITS } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import type { Logger } from "./contracts.ts";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const defaults = JSON.parse(readFileSync(new URL("../config.defaults.json", import.meta.url), "utf8")) as {
  browser: Record<string, unknown>;
};

let root: string;
let cfgPath: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kokpit-browser-config-"));
  cfgPath = join(root, "engine.json");
  dataDir = join(root, "data");
  mkdirSync(join(root, "home"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const load = (user: Record<string, unknown>) => {
  writeFileSync(cfgPath, JSON.stringify({ dataDir, ...user }));
  return loadConfig({ env: { KOKPIT_CONFIG: cfgPath, HOME: join(root, "home"), SHELL: "/bin/sh" }, logger });
};

describe("config.browser", () => {
  it("ships headful Chrome defaults, the built-in browser project and in-protocol frame limits", () => {
    expect(defaults.browser).toMatchObject({
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      testMode: false,
      profilesDirName: "browser-profiles",
      workspaceDirName: "browser-workspace",
      projectId: "web-tasks",
      projectName: "Browser tasks",
    });
    expect(defaults.browser.maxFrameChars as number).toBeLessThanOrEqual(BROWSER_LIMITS.maxFrameChars);
    // Adım 7 İş B: the tab strip must handle at least 20 tabs; the protocol caps the list.
    expect(defaults.browser.maxTabs as number).toBeGreaterThanOrEqual(20);
    expect(defaults.browser.maxTabs as number).toBeLessThanOrEqual(BROWSER_LIMITS.maxTabs);
  });

  it("hidden browsers present Chrome's own identity (asked of Chrome, no User-Agent text in config); false keeps headless Chrome's", async () => {
    expect(defaults.browser.hiddenIdentity).toBe(true);
    expect(defaults.browser).not.toHaveProperty("hiddenUserAgent");
    expect(defaults.browser.identityProbeUrl).toMatch(/^chrome:\/\//);
    expect((await load({ browser: { hiddenIdentity: false } })).browser.hiddenIdentity).toBe(false);
    await expect(load({ browser: { identityProbeUrl: "https://example.com/" } })).rejects.toThrow();
    await expect(load({ browser: { identityProbeUrl: "chrome://version\n" } })).rejects.toThrow();
    // The old template key still loads (older config files); null still turns the identity off, a template is unused.
    const legacy = await load({ browser: { hiddenUserAgent: null } });
    expect(legacy.browser.hiddenUserAgent).toBeNull();
    expect((await load({ browser: { hiddenUserAgent: "UA {major}" } })).browser.hiddenIdentity).toBe(true);
  });

  it("merges the user's browser keys over the defaults, key by key", async () => {
    const c = await load({ browser: { headless: true, chromePath: "/opt/chrome" } });
    expect(c.browser.headless).toBe(true);
    expect(c.browser.chromePath).toBe("/opt/chrome");
    expect(c.browser.projectName).toBe(defaults.browser.projectName);
    expect(c.browser.frameWindow).toBe(defaults.browser.frameWindow);
  });

  it("uses only the defaults without a browser block", async () => {
    const c = await load({});
    expect(c.browser).toEqual(defaults.browser);
  });

  it.each([
    ["chromePath", "chrome"],
    ["chromePath", ""],
    ["headless", "yes"],
    ["profilesDirName", "../x"],
    ["profilesDirName", "a/b"],
    ["workspaceDirName", ".."],
    ["projectId", "Tarayıcı"],
    ["projectName", " "],
    ["frameWindow", 0],
    ["maxFrameChars", BROWSER_LIMITS.maxFrameChars + 1],
    ["startTimeoutMs", 0],
    ["windowWidth", 0],
    ["unknownKey", 1],
    ["cdpPortBase", 80],
    ["cdpPortSpan", 0],
    ["maxTabs", 19],
    ["maxTabs", BROWSER_LIMITS.maxTabs + 1],
    ["maxTabs", 25.5],
    ["playwrightMcpOutputParentDir", "relative/dir"],
    ["playwrightMcpOutputParentDir", ""],
    ["playwrightMcpOutputParentDir", "/tmp/../etc"],
    ["playwrightMcpOutputRetentionDays", "7"],
    ["playwrightMcpOutputRetentionDays", null],
    ["playwrightMcpOutputSweepIntervalMs", 0],
    ["playwrightMcpOutputSweepIntervalMs", 1.5],
    ["playwrightMcpOutputSweepIntervalMs", -1],
    ["playwrightMcpOutputSweepMaxEntries", 0],
    ["playwrightMcpOutputSweepMaxEntries", 2.5],
  ])("rejects browser.%s = %j", async (field, value) => {
    await expect(load({ browser: { [field]: value } })).rejects.toThrow(/browser/);
  });

  // Adım 9 İş A
  it("names the Claude settings file inside a project as path segments; refuses escapes", async () => {
    expect(defaults.browser.claudeSettingsPath).toEqual([".claude", "settings.local.json"]);
    expect((await load({ browser: { claudeSettingsPath: ["cfg.json"] } })).browser.claudeSettingsPath).toEqual(["cfg.json"]);
    for (const bad of [[], [".."], [".claude", ".."], ["a/b"], ["."], [""], "x", [".claude", "a", "b", "c", "d", "e"]]) {
      await expect(load({ browser: { claudeSettingsPath: bad } })).rejects.toThrow(/browser\.claudeSettingsPath/);
    }
  });

  it("rejects a DevTools port range past 65535", async () => {
    await expect(load({ browser: { cdpPortBase: 65000, cdpPortSpan: 1000 } })).rejects.toThrow(/browser\.cdpPortSpan/);
  });

  it("rejects a non-object browser block", async () => {
    await expect(load({ browser: "headless" })).rejects.toThrow(/browser/);
  });

  // Adım 9 İş T
  describe("Playwright MCP output retention", () => {
    it("ships a 7 day limit, a sweep interval and a per-sweep bound; no parent dir (per-user temp)", async () => {
      expect(defaults.browser.playwrightMcpOutputRetentionDays).toBe(7);
      expect(defaults.browser.playwrightMcpOutputSweepIntervalMs as number).toBeGreaterThan(0);
      expect(defaults.browser.playwrightMcpOutputSweepMaxEntries as number).toBeGreaterThan(0);
      expect(defaults.browser).not.toHaveProperty("playwrightMcpOutputParentDir");
      expect((await load({})).browser.playwrightMcpOutputParentDir).toBeUndefined();
    });

    it("the user file overrides each key", async () => {
      const over = {
        playwrightMcpOutputParentDir: "/data/kokpit-out",
        playwrightMcpOutputRetentionDays: 30,
        playwrightMcpOutputSweepIntervalMs: 3_600_000,
        playwrightMcpOutputSweepMaxEntries: 500,
      };
      expect((await load({ browser: over })).browser).toMatchObject(over);
    });

    it.each([0, -1, -7, -0.5])("rejects a retention of %j days with a message that says why", async (days) => {
      await expect(load({ browser: { playwrightMcpOutputRetentionDays: days } })).rejects.toThrow(
        /browser\.playwrightMcpOutputRetentionDays.*0'dan büyük/,
      );
    });

    it("rejects an absurdly long retention", async () => {
      await expect(load({ browser: { playwrightMcpOutputRetentionDays: 1e9 } })).rejects.toThrow(/playwrightMcpOutputRetentionDays/);
    });

    it("accepts a fraction of a day", async () => {
      expect((await load({ browser: { playwrightMcpOutputRetentionDays: 0.5 } })).browser.playwrightMcpOutputRetentionDays).toBe(0.5);
    });

    it("env KOKPIT_PLAYWRIGHT_MCP_OUTPUT_PARENT_DIR wins over the file; empty is ignored; must be absolute", async () => {
      writeFileSync(cfgPath, JSON.stringify({ dataDir, browser: { playwrightMcpOutputParentDir: "/from/file" } }));
      const env = { KOKPIT_CONFIG: cfgPath, HOME: join(root, "home"), SHELL: "/bin/sh" };
      const withEnv = (v: string) => loadConfig({ env: { ...env, KOKPIT_PLAYWRIGHT_MCP_OUTPUT_PARENT_DIR: v }, logger });
      expect((await withEnv("/from/env")).browser.playwrightMcpOutputParentDir).toBe("/from/env");
      expect((await withEnv("")).browser.playwrightMcpOutputParentDir).toBe("/from/file");
      await expect(withEnv("rel")).rejects.toThrow(/browser\.playwrightMcpOutputParentDir/);
    });
  });
});
