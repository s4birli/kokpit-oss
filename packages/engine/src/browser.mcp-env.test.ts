// A user's own Playwright MCP plugin (`npx @playwright/mcp@latest`, no args — it only reads env) must drive the
// project's Kokpit Chrome and write outside the repo: local terminals of engine-browser projects get its env vars.
import type { Project } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import { browserTerminalEnv, commandStartsBrowser, type BrowserTerminalEnvOptions } from "./browser.ts";

const opts: BrowserTerminalEnvOptions = {
  cdpEndpointEnv: ["PLAYWRIGHT_MCP_CDP_ENDPOINT"],
  outputDirEnv: ["PLAYWRIGHT_MCP_OUTPUT_DIR"],
  // Adım 9 İş T: one folder per project.
  outputDirFor: (projectId) => `/var/folders/xy/T/kokpit-playwright-mcp/${projectId}`,
};
const url = (id: string) => `http://127.0.0.1:39${id.length}00`;
const local: Project = { id: "Acme", name: "Acme", location: { kind: "local", path: "/repos/Acme" } };

describe("browserTerminalEnv", () => {
  it("engine-side browser, local terminal: KOKPIT_CDP_URL plus the Playwright MCP endpoint (same URL) and output dir", () => {
    expect(browserTerminalEnv(local, url, opts)).toEqual({
      KOKPIT_CDP_URL: url("Acme"),
      PLAYWRIGHT_MCP_CDP_ENDPOINT: url("Acme"),
      PLAYWRIGHT_MCP_OUTPUT_DIR: "/var/folders/xy/T/kokpit-playwright-mcp/Acme",
    });
    expect(browserTerminalEnv({ ...local, browser: { runOn: "engine" } }, url, opts)).toHaveProperty("PLAYWRIGHT_MCP_CDP_ENDPOINT");
  });

  it("each project gets its own output dir", () => {
    const other = browserTerminalEnv({ ...local, id: "diger" }, url, opts);
    expect(other.PLAYWRIGHT_MCP_OUTPUT_DIR).toBe("/var/folders/xy/T/kokpit-playwright-mcp/diger");
    expect(other.PLAYWRIGHT_MCP_OUTPUT_DIR).not.toBe(browserTerminalEnv(local, url, opts).PLAYWRIGHT_MCP_OUTPUT_DIR);
  });

  it("a project without a usable output dir (null) gets the CDP names only", () => {
    expect(browserTerminalEnv(local, url, { ...opts, outputDirFor: () => null })).toEqual({
      KOKPIT_CDP_URL: url("Acme"),
      PLAYWRIGHT_MCP_CDP_ENDPOINT: url("Acme"),
    });
  });

  it("several names per variable (config lists) all get the value; empty lists add nothing", () => {
    const env = browserTerminalEnv(local, url, { ...opts, cdpEndpointEnv: ["A_CDP", "B_CDP"], outputDirEnv: [] });
    expect(env).toEqual({ KOKPIT_CDP_URL: url("Acme"), A_CDP: url("Acme"), B_CDP: url("Acme") });
  });

  it("nothing for ssh projects or a browser on the app's machine", () => {
    for (const p of [
      { ...local, location: { kind: "ssh", hostId: "oracle" } },
      { ...local, browser: { runOn: "client" } },
    ] as Project[]) {
      expect(browserTerminalEnv(p, url, opts)).toEqual({});
    }
  });
});

describe("commandStartsBrowser", () => {
  const prefixes = ["claude"];
  it.each([
    ["claude", true],
    ["claude --dangerously-skip-permissions", true],
    ["  claude agents", true],
    ['claude --append-system-prompt "$(cat x)"', true],
    ["FOO=1 BAR=x claude", true],
    ["/usr/local/bin/claude", true],
    ["claudette", false],
    ["codex", false],
    ["command gemini", false],
    ["echo claude", false],
    ["", false],
  ])("%j → %j", (cmd, out) => {
    expect(commandStartsBrowser(cmd, prefixes)).toBe(out);
  });
  it("an empty list turns it off", () => {
    expect(commandStartsBrowser("claude", [])).toBe(false);
  });
});
