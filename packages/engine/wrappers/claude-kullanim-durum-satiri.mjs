#!/usr/bin/env node
// Claude kullanımı — status line helper. Claude Code hands every status line command a JSON document on stdin; for
// claude.ai subscribers it carries `rate_limits` (five_hour / seven_day: used_percentage, resets_at). This helper
// stores ONLY those numbers in the account's config dir, where the Kokpit engine reads them (`claudeUsage.plan.
// snapshotFileName`), and then runs the user's own status line command, if any, with the same input.
//
//   node claude-kullanim-durum-satiri.mjs --out <file name> [-- <command> [args…]]
//
// In <config dir>/settings.json (the default account's is ~/.claude/settings.json):
//   "statusLine": { "type": "command",
//                   "command": "node '<this file>' --out kokpit-kullanim.json -- sh ~/.claude/statusline-command.sh" }
//
// The config dir is $CLAUDE_CONFIG_DIR (Claude Code sets the account apart with it), else Claude Code's default.
// Nothing else is read or written; no credentials, no network. It never fails the status line: on any problem it
// stores nothing and still runs the wrapped command.
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's config dir when CLAUDE_CONFIG_DIR is unset (its convention, not a Kokpit setting). */
const CLAUDE_DEFAULT_DIR_NAME = ".claude";
const WINDOWS = ["five_hour", "seven_day"];
const PRIVATE_FILE_MODE = 0o600;
const STDIN_FD = 0;

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split === -1 ? argv : argv.slice(0, split);
const wrapped = split === -1 ? [] : argv.slice(split + 1);
const outAt = own.indexOf("--out");
const outName = outAt === -1 ? undefined : own[outAt + 1];

let input = "";
try {
  input = readFileSync(STDIN_FD, "utf8");
} catch {
  // no stdin
}

/** `{ five_hour?: { used_percentage, resets_at }, seven_day?: … }` with finite numbers only; undefined when empty. */
function rateLimits(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const limits = data !== null && typeof data === "object" ? data.rate_limits : undefined;
  if (limits === null || typeof limits !== "object") return undefined;
  const out = {};
  for (const name of WINDOWS) {
    const w = limits[name];
    if (w === null || typeof w !== "object") continue;
    if (!Number.isFinite(w.used_percentage) || !Number.isFinite(w.resets_at)) continue;
    out[name] = { used_percentage: w.used_percentage, resets_at: w.resets_at };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const isFileName = (s) => typeof s === "string" && s !== "" && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\") && !s.includes("\0");

try {
  const limits = isFileName(outName) ? rateLimits(input) : undefined;
  if (limits) {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), CLAUDE_DEFAULT_DIR_NAME);
    const file = join(dir, outName);
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify({ capturedAt: Date.now(), rate_limits: limits }), { mode: PRIVATE_FILE_MODE, flag: "wx" });
      renameSync(tmp, file);
    } catch {
      rmSync(tmp, { force: true });
    }
  }
} catch {
  // never break the status line
}

if (wrapped.length > 0) {
  const r = spawnSync(wrapped[0], wrapped.slice(1), { input, stdio: ["pipe", "inherit", "inherit"] });
  process.exit(typeof r.status === "number" ? r.status : 0);
}
