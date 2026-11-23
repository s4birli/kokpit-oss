#!/usr/bin/env node
// A Claude Code session, reduced to the one contract Adım 9 İş A relies on (measured with Claude Code 2.1.326,
// see docs/kabul-testleri.md T-BGTAR): a session applies the `env` block of the project's settings file
// (`<cwd>/.claude/settings.local.json`) to itself and to the MCP servers it starts — also when the session was
// spawned by the shared `claude daemon`, whose own environment carries none of a Kokpit terminal's variables.
//
// Usage: fake-claude-session.mjs <settings path segments joined by "/"> <mcp command> [args…]
// Starts the MCP server with (this process's env + the settings file's env) and connects it to our stdio.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [settingsRel, command, ...args] = process.argv.slice(2);
if (!settingsRel || !command) {
  process.stderr.write("usage: fake-claude-session.mjs <settings file> <mcp command> [args…]\n");
  process.exit(2);
}

let settingsEnv = {};
try {
  const settings = JSON.parse(readFileSync(join(process.cwd(), settingsRel), "utf8"));
  if (settings && typeof settings.env === "object" && settings.env !== null) settingsEnv = settings.env;
} catch {
  /* no settings file: the session has only its own environment */
}

const child = spawn(command, args, { env: { ...process.env, ...settingsEnv }, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
