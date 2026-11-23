// A stand-in for a program that prints links (Claude Code, a dev server), for links.e2e: plain URLs, OSC 8
// hyperlinks, a URL long enough to wrap, URLs in punctuation, a bare `localhost:PORT`, and schemes that must never
// be opened. With `track` it also turns mouse tracking on (DECSET 1000/1002/1006), as full-screen programs do, and
// records every byte it receives, so a test can tell whether a click reached the program.
// Usage: node fake-link-tui.mjs <stdin-log-file> <base-url> <track|plain>
import { appendFileSync, writeFileSync } from "node:fs";

const [logFile, base, mode] = process.argv.slice(2);
if (!logFile || !base || (mode !== "track" && mode !== "plain")) throw new Error("usage: fake-link-tui.mjs <stdin-log-file> <base-url> <track|plain>");
const ESC = "\x1b";
const ST = `${ESC}\\`;
const TRACK = mode === "track";
/** Path characters after `/uzun/`: longer than any terminal is wide, so the URL wraps over several rows. */
const LONG_PATH_CHARS = Number(process.env.FAKE_LINK_TUI_LONG_CHARS ?? 260);
const port = new URL(base).port;
const osc8 = (target, text) => `${ESC}]8;;${target}${ST}${text}${ESC}]8;;${ST}`;
const line = (text) => process.stdout.write(`${text}\r\n`);

writeFileSync(logFile, "");
process.stdin.setRawMode(true);
process.stdin.resume();
if (TRACK) process.stdout.write(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`);

line(`DUZ ${base}/duz?x=1`);
line(`OSC8 ${osc8(`${base}/osc8`, "Belgeler_Baglantisi")} sonu`);
line(`NOKTA Bkz. (${base}/parantez). Devam.`);
line(`YEREL localhost:${port}/yerel hazır`);
line(`UZUN ${base}/uzun/${"u".repeat(LONG_PATH_CHARS)}/SON bitti`);
line(`DOSYA file:///tmp/kokpit-link-test/dosya.txt`);
line(`VSCODE vscode://file/tmp/kokpit-link-test/dosya.txt`);
line(`JS ${osc8("javascript:document.title='JS_CALISTI'", "JS_TIKLA")}`);
line(`OZEL ${osc8("kokpit-test-scheme://calistir", "OZEL_TIKLA")}`);
line(`SAHTE ${osc8(`${base}/gercek`, "https://ornek.invalid/sahte")}`);
line("LINK_TUI_HAZIR");

process.stdin.on("data", (chunk) => {
  appendFileSync(logFile, chunk);
  const text = chunk.toString("utf8");
  if (text === "q") {
    if (TRACK) process.stdout.write(`${ESC}[?1000l${ESC}[?1002l${ESC}[?1006l`);
    process.exit(0);
  }
});
