// A stand-in for a full-screen TUI such as Claude Code, for copy.e2e: turns on mouse tracking (DECSET 1000/1002/1006)
// and bracketed paste, records every byte it receives, and on single keys writes OSC 52 clipboard sequences.
// Usage: node fake-tui.mjs <stdin-log-file>
import { appendFileSync, writeFileSync } from "node:fs";

const [logFile] = process.argv.slice(2);
if (!logFile) throw new Error("usage: fake-tui.mjs <stdin-log-file>");
const ESC = "\x1b";
const BEL = "\x07";
const osc52 = (payload) => `${ESC}]52;c;${payload}${BEL}`;
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
/** Bytes of decoded text in the oversized write ("b"): above any sane cap. */
const BIG_BYTES = Number(process.env.FAKE_TUI_BIG_BYTES ?? 4 * 1024 * 1024);

writeFileSync(logFile, "");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${ESC}[?2004h`);
process.stdout.write("TUI_HAZIR\r\nTUI_SATIRI_SECILECEK_4711\r\n");

const quit = () => {
  process.stdout.write(`${ESC}[?1000l${ESC}[?1002l${ESC}[?1006l${ESC}[?2004l`);
  process.exit(0);
};
const keys = {
  w: () => process.stdout.write(osc52(b64("OSC52_YAZILDI_çğış_1"))),
  x: () => process.stdout.write(osc52(b64("OSC52_YAZILDI_2"))),
  // No selection target ("Pc" empty) is the clipboard too.
  e: () => process.stdout.write(`${ESC}]52;;${b64("OSC52_BOS_HEDEF_3")}${BEL}`),
  // ST-terminated instead of BEL.
  s: () => process.stdout.write(`${ESC}]52;c;${b64("OSC52_ST_4")}${ESC}\\`),
  r: () => process.stdout.write(osc52("?")),
  g: () => process.stdout.write(osc52("!!!bu-base64-değil@@@") + osc52("=====") + `${ESC}]52;${BEL}` + `${ESC}]52;c${BEL}`),
  b: () => process.stdout.write(osc52(b64("B".repeat(BIG_BYTES)))),
  q: quit,
};

process.stdin.on("data", (chunk) => {
  appendFileSync(logFile, chunk);
  const text = chunk.toString("utf8");
  if (text.length === 1 && keys[text]) keys[text]();
  if (text.length === 1) process.stdout.write(`TUS_${text === "\x03" ? "CTRL_C" : text}\r\n`);
});
