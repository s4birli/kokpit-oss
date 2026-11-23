// A stand-in for the end of a Claude Code session, for paths.e2e: it prints local file paths — the `open ~/…`
// line agents finish with, a file of the project, a refused and a missing path — with mouse tracking on
// (DECSET 1000/1002/1006), as Claude Code has it, and records every byte it receives, so a test can tell whether a
// click reached the program. It opens nothing itself.
// Usage: node fake-path-tui.mjs <stdin-log-file> <path>...   (each path is printed on a line of its own)
import { appendFileSync, writeFileSync } from "node:fs";

const [logFile, ...paths] = process.argv.slice(2);
if (!logFile || paths.length === 0) throw new Error("usage: fake-path-tui.mjs <stdin-log-file> <path>...");
const ESC = "\x1b";
const line = (text) => process.stdout.write(`${text}\r\n`);

writeFileSync(logFile, "");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`);

line("Rapor hazır. Görmek için:");
for (const path of paths) line(path);
line("YOL_TUI_HAZIR");

process.stdin.on("data", (chunk) => {
  appendFileSync(logFile, chunk);
  if (chunk.toString("utf8") === "q") {
    process.stdout.write(`${ESC}[?1000l${ESC}[?1002l${ESC}[?1006l`);
    process.exit(0);
  }
});
