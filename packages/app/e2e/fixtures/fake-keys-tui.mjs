// A stand-in for a full-screen TUI such as Claude Code (`claude agents`, its prompt), for keys.e2e: puts the tty in
// raw mode, records every byte it receives (appended to a log file) and switches terminal modes when told to — never
// the real `claude`. Modes are not switched through stdin (its bytes are what the test measures): the test writes the
// wanted mode names to `<log>.mode`, the program polls that file and confirms on screen with `KIP_<names>`.
// Usage: node fake-keys-tui.mjs <stdin-log-file>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [logFile] = process.argv.slice(2);
if (!logFile) throw new Error("usage: fake-keys-tui.mjs <stdin-log-file>");
const modeFile = `${logFile}.mode`;
const ESC = "\x1b";
const POLL_MS = 50;

/** Modes as Claude Code switches them. Bracketed paste and focus events are always on, as in Claude Code. */
const ALWAYS = `${ESC}[?2004h${ESC}[?1004h`;
const MODES = {
  // SGR mouse tracking: press/release and drag (no motion reports without a button).
  mouse: { on: `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`, off: `${ESC}[?1002l${ESC}[?1000l${ESC}[?1006l` },
  // DECCKM (application cursor keys: arrows as ESC O A) and DECKPAM.
  decckm: { on: `${ESC}[?1h${ESC}=`, off: `${ESC}[?1l${ESC}>` },
  // What Claude Code asks of terminals it believes speak them: kitty keyboard flags, modifyOtherKeys.
  kitty: { on: `${ESC}[>1u`, off: `${ESC}[<u` },
  modkeys: { on: `${ESC}[>4;2m`, off: `${ESC}[>4;0m` },
};

writeFileSync(logFile, "");
writeFileSync(modeFile, "");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write(ALWAYS);
/** A row as `claude agents` shows them: a link and a path; shown again with every mode switch, so it is on screen. */
const AGENT_ROW = "AJAN_1 https://ornek.invalid/ajan/1 /tmp/ajan-bir.txt\r\n";
process.stdout.write(`TUS_HAZIR\r\n${AGENT_ROW}`);

const active = new Set();
let lastSpec = null;
setInterval(() => {
  if (!existsSync(modeFile)) return;
  const spec = readFileSync(modeFile, "utf8").trim();
  if (spec === lastSpec) return;
  lastSpec = spec;
  const want = new Set(spec.split(/[ ,]+/).filter((m) => m in MODES));
  for (const m of active) if (!want.has(m)) process.stdout.write(MODES[m].off);
  for (const m of want) if (!active.has(m)) process.stdout.write(MODES[m].on);
  active.clear();
  for (const m of want) active.add(m);
  process.stdout.write(`KIP_${[...want].sort().join("+") || "duz"}\r\n${AGENT_ROW}`);
}, POLL_MS);

let count = 0;
process.stdin.on("data", (chunk) => {
  appendFileSync(logFile, chunk);
  count++;
  process.stdout.write(`ALINDI_${count}\r\n`);
});
