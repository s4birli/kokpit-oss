// "Claude + browser": Claude Code with the project's Chrome attached through Playwright MCP. The tool's command
// runs a POSIX wrapper shipped with the engine that builds the MCP config from KOKPIT_CDP_URL at launch.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadToolDefaults, TOOL_DEFAULTS_PATH } from "./tools.ts";

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ENGINE_DIR, "wrappers", "claude-tarayici.sh");
const PKG = "@playwright/mcp@0.0.84";
/**
 * The engine's name for the Playwright MCP output folder (config `browser.playwrightMcpOutputDirName`). The wrapper's
 * fallback — used only when the terminal carries no usable PLAYWRIGHT_MCP_OUTPUT_DIR — still spells this name itself;
 * the tests below compare against the config value, so the two cannot drift apart unnoticed.
 */
const OUTPUT_DIR_NAME = (JSON.parse(readFileSync(join(ENGINE_DIR, "config.defaults.json"), "utf8")) as { browser: { playwrightMcpOutputDirName: string } }).browser
  .playwrightMcpOutputDirName;

let dir: string;
let binDir: string;
let argvFile: string;
let devtools: http.Server;
let liveUrl: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-claude-browser-"));
  binDir = join(dir, "bin");
  argvFile = join(dir, "argv.json");
  // Fake `claude`: records its argv (never the real one).
  const fake = join(dir, "bin-claude.mjs");
  writeFileSync(fake, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));\n`);
  mkdirSync(binDir);
  writeFileSync(join(binDir, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`);
  chmodSync(join(binDir, "claude"), 0o755);
  devtools = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/json/version" ? JSON.stringify({ Browser: "Chrome/test" }) : "{}");
  });
  await new Promise<void>((r) => devtools.listen(0, "127.0.0.1", () => r()));
  liveUrl = `http://127.0.0.1:${(devtools.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => devtools.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/** Async on purpose: the fake DevTools server lives in this process and must keep answering. */
async function run(env: Record<string, string>, args: string[] = []) {
  rmSync(argvFile, { force: true });
  const child = spawn("/bin/sh", [SCRIPT, ...args], {
    env: { PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: dir, FAKE_ARGV: argvFile, KOKPIT_MCP_PACKAGE: PKG, KOKPIT_BROWSER_WAIT_S: "0", ...env },
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  let argv: string[] | null = null;
  try {
    argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  } catch {
    argv = null;
  }
  return { code, out, argv };
}

type McpConfig = { mcpServers: Record<string, { type: string; command: string; args: string[] }> };
const configOf = (argv: string[]): McpConfig => {
  const i = argv.indexOf("--mcp-config");
  expect(i, "--mcp-config present").toBeGreaterThanOrEqual(0);
  // --mcp-config is variadic in Claude Code: it must come last, or it would swallow a prompt argument.
  expect(i).toBe(argv.length - 2);
  return JSON.parse(argv[i + 1]!) as McpConfig;
};

describe("tools.defaults.json: Claude + browser", () => {
  it("ships the tool: wrapper path resolved and quoted, pinned Playwright MCP, opens the browser, seed step 4", () => {
    const d = loadToolDefaults(TOOL_DEFAULTS_PATH);
    const tool = d.tools.find((t) => t.id === "claude-tarayici");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("Claude + browser");
    expect(tool!.opensBrowser).toBe(true);
    // Stored as a template; the shell-quoted script path of the running engine is filled in at launch.
    expect(tool!.command).toContain("sh {{claudeBrowserScript}}");
    expect(d.fileArgs).toMatchObject({ claudeBrowserScript: `'${SCRIPT}'` });
    expect(tool!.command).toMatch(/KOKPIT_MCP_PACKAGE=@playwright\/mcp@\d+\.\d+\.\d+ /);
    expect(tool!.command).toMatch(/KOKPIT_BROWSER_WAIT_S=\d+ /);
    const claude = d.tools.find((t) => t.id === "claude")!;
    expect(tool!.checkCommand).toBe(claude.checkCommand);
    expect(tool!.installCommand).toBe(claude.installCommand);
    expect(tool!.waitingPatterns).toEqual(claude.waitingPatterns);
    expect(d.laterSteps).toContainEqual({ key: "default-tools-4", toolIds: ["claude-tarayici"] });
    // No other default starts a browser.
    expect(d.tools.filter((t) => t.opensBrowser).map((t) => t.id)).toEqual(["claude-tarayici"]);
  });
});

describe("wrappers/claude-tarayici.sh", () => {
  it("browser up: starts claude with Playwright MCP on the project's CDP endpoint, user args first", async () => {
    const r = await run({ KOKPIT_CDP_URL: liveUrl }, ["--model", "x", "merhaba"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/Tarayıcı panelinden/);
    expect(r.argv!.slice(0, 3)).toEqual(["--model", "x", "merhaba"]);
    expect(configOf(r.argv!)).toEqual({
      mcpServers: {
        "kokpit-tarayici": {
          type: "stdio",
          command: "npx",
          // Snapshots go to the user's temp dir, never into the project (would make the card's worktree dirty).
          args: ["-y", PKG, "--cdp-endpoint", liveUrl, "--output-dir", join(dir, OUTPUT_DIR_NAME)],
        },
      },
    });
  });

  it("refuses to run without TMPDIR (snapshot output must not land in the project folder)", async () => {
    const r = await run({ KOKPIT_CDP_URL: liveUrl, TMPDIR: "" });
    expect(r.code).not.toBe(0);
    expect(r.argv).toBeNull();
  });

  // Adım 9 İş T: the engine gives each project's terminals their own output folder.
  it("uses the project's output dir the engine put in the terminal (PLAYWRIGHT_MCP_OUTPUT_DIR), even without TMPDIR", async () => {
    const projectOut = join(dir, OUTPUT_DIR_NAME, "Acme");
    const variants: Record<string, string>[] = [{}, { TMPDIR: "" }];
    for (const extra of variants) {
      const r = await run({ KOKPIT_CDP_URL: liveUrl, PLAYWRIGHT_MCP_OUTPUT_DIR: projectOut, ...extra });
      expect(r.code).toBe(0);
      expect(configOf(r.argv!).mcpServers["kokpit-tarayici"]!.args.slice(-2)).toEqual(["--output-dir", projectOut]);
    }
  });

  it.each(["relative/out", "/tmp/a b", '/tmp/x"y', "/tmp/$(id)", "/tmp/../etc"])(
    "an unusable PLAYWRIGHT_MCP_OUTPUT_DIR (%j) falls back to the per-user temp folder",
    async (bad) => {
      const r = await run({ KOKPIT_CDP_URL: liveUrl, PLAYWRIGHT_MCP_OUTPUT_DIR: bad });
      expect(r.code).toBe(0);
      expect(configOf(r.argv!).mcpServers["kokpit-tarayici"]!.args.slice(-2)).toEqual(["--output-dir", join(dir, OUTPUT_DIR_NAME)]);
    },
  );

  it("browser not up: prints the Turkish hint and still starts claude (Playwright MCP connects on first use)", async () => {
    const r = await run({ KOKPIT_CDP_URL: "http://127.0.0.1:1" });
    expect(r.out).toMatch(/Önce Tarayıcı panelinden tarayıcıyı aç/);
    expect(r.code).toBe(0);
    expect(configOf(r.argv!).mcpServers["kokpit-tarayici"]!.args).toContain("http://127.0.0.1:1");
  });

  it("no KOKPIT_CDP_URL (ssh project or browser on the app's computer): explains and does not start claude", async () => {
    const r = await run({});
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/KOKPIT_CDP_URL/);
    expect(r.out).toMatch(/Mac mini/);
    expect(r.argv).toBeNull();
  });

  it("monkey: an endpoint or package that could break out of the JSON (or point off loopback) is refused", async () => {
    for (const url of [
      'http://127.0.0.1:1"],"x":["',
      "http://127.0.0.1:1/x",
      "http://10.0.0.5:9222",
      "http://127.0.0.1:",
      "ws://127.0.0.1:9222",
      "http://127.0.0.1:9222\nx",
      "http://127.0.0.1:99999999",
    ]) {
      const r = await run({ KOKPIT_CDP_URL: url });
      expect(r.code, url).not.toBe(0);
      expect(r.argv, url).toBeNull();
    }
    for (const pkg of ['@playwright/mcp@1"x', "", "-y", "@playwright/mcp@0.0.84 --foo", "a\\b"]) {
      const r = await run({ KOKPIT_CDP_URL: liveUrl, KOKPIT_MCP_PACKAGE: pkg });
      expect(r.code, pkg).not.toBe(0);
      expect(r.argv, pkg).toBeNull();
    }
    const badWait = await run({ KOKPIT_CDP_URL: liveUrl, KOKPIT_BROWSER_WAIT_S: "x; rm -rf /" });
    expect(badWait.code).not.toBe(0);
    expect(badWait.argv).toBeNull();
  });

  it("waits for a browser that is still starting (KOKPIT_BROWSER_WAIT_S)", async () => {
    // Start answering only after the script began polling.
    const late = http.createServer((_q, res) => res.end("{}"));
    const port = await new Promise<number>((r) => {
      const probe = http.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => r(p));
      });
    });
    const t = setTimeout(() => late.listen(port, "127.0.0.1"), 1200);
    rmSync(argvFile, { force: true });
    const child = spawn("/bin/sh", [SCRIPT], {
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        TMPDIR: dir,
        FAKE_ARGV: argvFile,
        KOKPIT_MCP_PACKAGE: PKG,
        KOKPIT_BROWSER_WAIT_S: "10",
        KOKPIT_CDP_URL: `http://127.0.0.1:${port}`,
      },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    clearTimeout(t);
    await new Promise<void>((r) => late.close(() => r()));
    expect(code).toBe(0);
    expect(out).not.toMatch(/Tarayıcı panelinden/);
    expect(JSON.parse(readFileSync(argvFile, "utf8"))).toContain("--mcp-config");
  }, 20_000);
});
