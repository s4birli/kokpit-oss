// A deterministic, noisy program for terminal-history tests: escape-heavy, multi-byte lines until `bytes` UTF-8
// bytes are written, a marker line, then one numbered tick line every `tickMs` until killed.
// Run: `node flood.ts <bytes> <tickMs>`. The test imports the same generators to know what must come back.
import { fileURLToPath } from "node:url";

export const FLOOD_DONE = "SEL_BITTI";
const ESC = "\x1b";
const BEL = "\x07";
/** 1, 2, 3 and 4 byte UTF-8 characters (the last ones are surrogate pairs in UTF-16). */
const WIDE = "çğışöü €漢字 😀🚀";
/** Every OSC_EVERY-th line carries a long OSC payload, like a program setting the title or the clipboard. */
const OSC_EVERY = 97;
const OSC_PAYLOAD_CHARS = 1500;
/** Lines handed to stdout per write. */
const WRITE_LINES = 200;

export function floodLine(n: number): string {
  const colour = `${ESC}[38;5;${n % 256}m`;
  const osc = n % OSC_EVERY === 0 ? `${ESC}]0;${"t".repeat(OSC_PAYLOAD_CHARS)}${BEL}` : "";
  // Control characters dominate on purpose: each becomes six characters in JSON.
  return `${colour}S${n} ${WIDE}${ESC}[0m${ESC}[K${osc}\t${ESC}[1m${ESC}[22m\n`;
}

export function tickLine(n: number): string {
  return `TIK_${n}_${WIDE}\n`;
}

/** The lines the program writes before the ticks, in order. */
function floodLines(bytes: number): string[] {
  const lines: string[] = [];
  let total = 0;
  for (let n = 0; total < bytes; n++) {
    const line = floodLine(n);
    lines.push(line);
    total += Buffer.byteLength(line, "utf8");
  }
  lines.push(`${FLOOD_DONE}\n`);
  return lines;
}

/** Everything the program writes before the ticks. */
export function floodText(bytes: number): string {
  return floodLines(bytes).join("");
}

function write(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.write(text)) resolve();
    else process.stdout.once("drain", () => resolve());
  });
}

async function main(): Promise<void> {
  const bytes = Number(process.argv[2]);
  const tickMs = Number(process.argv[3]);
  if (!Number.isInteger(bytes) || bytes < 0 || !Number.isFinite(tickMs) || tickMs <= 0) throw new Error("usage: flood.ts <bytes> <tickMs>");
  // Whole lines per write: a write never ends inside a character.
  const lines = floodLines(bytes);
  for (let i = 0; i < lines.length; i += WRITE_LINES) await write(lines.slice(i, i + WRITE_LINES).join(""));
  for (let n = 0; ; n++) {
    await write(tickLine(n));
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
