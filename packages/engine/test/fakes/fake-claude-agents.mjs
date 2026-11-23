#!/usr/bin/env node
// Fake `claude` for the background-agent end-to-end tests (engine and Electron). Never starts a real Claude.
// State: the JSON file $FAKE_CLAUDE_STATE = { sessions: [...raw `claude agents --json` entries...] }.
// Every invocation's argv is appended as one JSON line to $FAKE_CLAUDE_LOG (if set).
//   agents --json --all  → prints the sessions
//   logs <id>            → prints a few lines with escape sequences
//   stop <id>            → marks the session done (exit 1 + stderr for an unknown id)
//   attach <id>          → prints "FAKE-ATTACH <id>" and waits (like the real TUI would)
//   -p …                 → Claude kullanımı probe: stream-json lines with an answer text and a rate_limit_event
//                          built from state.rateLimits[<config dir or "">] ({ five_hour?, seven_day? })
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(args)}\n`);
const statePath = process.env.FAKE_CLAUDE_STATE;
const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};
if (!statePath) fail("fake claude: FAKE_CLAUDE_STATE not set");
const state = JSON.parse(readFileSync(statePath, "utf8"));
// İş H: with CLAUDE_CONFIG_DIR set, the sessions of that account dir (`byConfigDir[dir]`, none if absent).
const configDir = process.env.CLAUDE_CONFIG_DIR;
const list = () => (configDir ? ((state.byConfigDir ??= {})[configDir] ??= []) : state.sessions);
const find = (id) => list().find((s) => s.id === id);

switch (args[0]) {
  case "agents":
    process.stdout.write(`${JSON.stringify(list(), null, 2)}\n`);
    break;
  case "/login": // İş H: the login TUI; shows which account dir it would log into
    process.stdout.write(`FAKE-LOGIN CONFIG_DIR=[${configDir ?? ""}]\n`);
    setInterval(() => {}, 1 << 30);
    break;
  case "config-dir": // İş H
    process.stdout.write(`CONFIG_DIR=[${configDir ?? ""}]\n`);
    break;
  case "logs": {
    const s = find(args[1]);
    if (!s) fail(`No background session matches "${args[1]}"`);
    process.stdout.write(`\x1b[1m${s.name}\x1b[0m\r\n> çalışıyor…\r\n\x1b[32mFAKE-LOG ${s.id}\x1b[39m\r\n`);
    break;
  }
  case "stop": {
    const s = find(args[1]);
    if (!s) fail(`No background session matches "${args[1]}"`);
    s.state = "done";
    delete s.status;
    delete s.pid;
    writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(`Stopped ${s.id}\n`);
    break;
  }
  case "-p": {
    // Shape observed with Claude Code 2.1.327 (`claude -p --output-format stream-json --verbose`).
    const windows = (state.rateLimits ?? {})[configDir ?? ""];
    process.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "FAKE-PROBE-ANSWER" }] } })}\n`);
    if (windows) {
      process.stdout.write(`${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: windows } })}\n`);
    }
    process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "FAKE-PROBE-ANSWER" })}\n`);
    break;
  }
  case "attach":
    process.stdout.write(`FAKE-ATTACH ${args[1]}\n`);
    setInterval(() => {}, 1 << 30);
    break;
  default:
    fail(`fake claude: unsupported ${JSON.stringify(args)}`);
}
