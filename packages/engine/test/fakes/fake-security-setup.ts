// Girişler: a FAKE macOS `security` tool for tests, so no test ever touches the real Keychain. A small script that
// keeps "Keychain items" in one temp JSON file and behaves like the real tool where the engine depends on it:
//   - `security -i` reads commands from stdin, one per line (double / single quotes and backslash escapes); a last
//     line without a newline is dropped; a line longer than 4095 characters is cut and the rest becomes the next
//     command (all measured on the real tool with `help` only);
//   - the exit status is the last command's (44 = item not found, 36 = interaction not allowed, …);
//   - `add-generic-password -U -a <account> -s <service> -w <secret>`, `find-generic-password -a -s -w`,
//     `delete-generic-password -a -s`.
// Every run is logged with its argv and environment — never its stdin — so tests can prove what other processes
// could have seen. Shared by the engine and Electron end-to-end tests.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How the fake answers: `ok`, or one of the real tool's failures, or `slow` (never answers), or `garbage` (find prints junk). */
export type FakeSecurityMode = "ok" | "locked" | "denied" | "canceled" | "nokeychain" | "slow" | "garbage" | "echo-error" | `allow-after:${number}`;
export type FakeSecurityCommand = "add-generic-password" | "find-generic-password" | "delete-generic-password";

export interface FakeSecurity {
  /** Value for the engine config's `logins.securityPath`. */
  path: string;
  /** Value for `logins.env`: the PATH the script needs to find node. */
  env: Record<string, string>;
  /** A path where no program exists. */
  missingPath: string;
  /** Mode of every command, or of one command only (the others stay as they are). */
  mode(mode: FakeSecurityMode, only?: FakeSecurityCommand): void;
  /** The "Keychain": `<service>\n<account>` → the stored secret, exactly as the tool was given it. */
  items(): Record<string, string>;
  /** One entry per run: argv (after the program name) and the environment the program saw. */
  runs(): { argv: string[]; env: Record<string, string> }[];
  clearRuns(): void;
  /**
   * Every command the tool executed, as its parsed words — also the ones that arrived on stdin (`-i`). The value
   * of `-w` is replaced by "<secret>": this log is safe to scan and shows exactly what was asked of the Keychain.
   */
  commands(): string[][];
  /** `<service>\n<account>` → who may read the item without asking: "security" (the creating tool) or "nobody" (`-T ""`). */
  trusted(): Record<string, "security" | "nobody">;
  /** Everything the fake logged about its runs (argv + env), as one text — for "the secret is not in here" checks. */
  runLog(): string;
}

const LINE_MAX = 4095;

const script = (store: string, log: string, modeFile: string, cmdLog: string, aclFile: string): string => `#!/usr/bin/env node
const fs = require("node:fs");
const STORE = ${JSON.stringify(store)}, LOG = ${JSON.stringify(log)}, MODE = ${JSON.stringify(modeFile)}, CMDS = ${JSON.stringify(cmdLog)}, ACL = ${JSON.stringify(aclFile)};
const loadAcl = () => (fs.existsSync(ACL) ? JSON.parse(fs.readFileSync(ACL, "utf8")) : {});
const saveAcl = (acl) => fs.writeFileSync(ACL, JSON.stringify(acl));
const argv = process.argv.slice(2);
fs.appendFileSync(LOG, JSON.stringify({ argv, env: process.env }) + "\\n");
const modes = fs.existsSync(MODE) ? JSON.parse(fs.readFileSync(MODE, "utf8")) : {};
const load = () => (fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {});
const save = (items) => { const tmp = STORE + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(items)); fs.renameSync(tmp, STORE); };
const fail = (status, text) => { process.stderr.write("security: " + text + "\\n"); return status; };
const NOT_FOUND = () => fail(44, "SecKeychainSearchCopyNext: The specified item could not be found in the keychain.");

function options(args, withValue) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-") || a.length !== 2) return null;
    if (withValue.includes(a[1])) { if (i + 1 >= args.length) return null; out[a[1]] = args[++i]; }
    else out[a[1]] = true;
  }
  return out;
}

async function run(args) {
  const cmd = args[0];
  fs.appendFileSync(CMDS, JSON.stringify(args.map((a, i) => (args[i - 1] === "-w" ? "<secret>" : a))) + "\\n");
  const mode = modes[cmd] || modes["*"] || "ok";
  // The user answers the Keychain dialog after a while (reads only: that is what an empty trusted list asks for).
  if (mode.startsWith("allow-after:") && cmd === "find-generic-password") await new Promise((r) => setTimeout(r, Number(mode.split(":")[1])));
  if (mode === "slow") await new Promise(() => setInterval(() => {}, 1000));
  if (mode === "locked") return fail(36, "SecKeychainItemCopyContent: User interaction is not allowed.");
  if (mode === "denied") return fail(51, "SecKeychainItemCopyContent: The user name or passphrase you entered is not correct.");
  if (mode === "canceled") return fail(128, "SecKeychainItemCopyContent: User canceled the operation.");
  if (mode === "nokeychain") return fail(50, "SecKeychainCopyDefault: The specified keychain could not be found.");
  if (mode === "echo-error") return fail(1, "unexpected: " + args.join(" "));
  // \`-w\` takes a value only when adding; for find it is the "print only the password" flag.
  const o = options(args.slice(1), cmd === "add-generic-password" ? ["a", "s", "w", "l", "j", "T"] : ["a", "s", "l", "j"]);
  if (!o || typeof o.a !== "string" || typeof o.s !== "string") return fail(2, cmd + ": usage");
  const key = o.s + "\\n" + o.a;
  const items = load();
  if (cmd === "add-generic-password") {
    if (typeof o.w !== "string") return fail(2, "add-generic-password: usage");
    if (key in items && !o.U) return fail(45, "SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.");
    // Like the real tool: the access list is set when the item is CREATED; an update (-U) leaves it alone.
    if (!(key in items)) { const acl = loadAcl(); acl[key] = o.T === "" ? "nobody" : "security"; saveAcl(acl); }
    items[key] = o.w;
    save(items);
    return 0;
  }
  if (cmd === "find-generic-password") {
    if (!(key in items)) return NOT_FOUND();
    process.stdout.write((mode === "garbage" ? "%%% bu bir zarf değil %%%" : items[key]) + "\\n");
    return 0;
  }
  if (cmd === "delete-generic-password") {
    if (!(key in items)) return NOT_FOUND();
    delete items[key];
    save(items);
    { const acl = loadAcl(); delete acl[key]; saveAcl(acl); }
    process.stdout.write("password has been deleted.\\n");
    return 0;
  }
  return fail(1, cmd + ": no such command");
}

/** The real tool's line parser: whitespace separates, "…" and '…' group, a backslash takes the next character. */
function split(line) {
  const out = [];
  let cur = null, quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\\\" && i + 1 < line.length) { cur = (cur ?? "") + line[++i]; continue; }
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur = cur ?? ""; continue; }
    if (/\\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    cur = (cur ?? "") + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

(async () => {
  if (argv[0] !== "-i") process.exit(await run(argv));
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  const lines = text.split("\\n");
  lines.pop(); // a last line without a newline is never run
  let status = 0;
  for (const whole of lines) {
    for (let at = 0; at < Math.max(whole.length, 1); at += ${LINE_MAX}) {
      const args = split(whole.slice(at, at + ${LINE_MAX}));
      if (args.length === 0) continue;
      status = await run(args);
      if (status !== 0) process.stderr.write(args[0] + ": returned " + status + "\\n");
    }
  }
  process.exit(status);
})();
`;

export function installFakeSecurity(root: string): FakeSecurity {
  const dir = join(root, "fake-security");
  mkdirSync(dir, { recursive: true });
  const store = join(dir, "keychain.json");
  const log = join(dir, "runs.jsonl");
  const modeFile = join(dir, "modes.json");
  const cmdLog = join(dir, "commands.jsonl");
  const aclFile = join(dir, "acl.json");
  writeFileSync(cmdLog, "");
  const path = join(dir, "security");
  writeFileSync(log, "");
  writeFileSync(path, script(store, log, modeFile, cmdLog, aclFile));
  chmodSync(path, 0o755);
  const modes: Record<string, FakeSecurityMode> = {};
  return {
    path,
    env: { PATH: dirname(process.execPath) },
    missingPath: join(dir, "yok", "security"),
    mode(mode, only) {
      if (only === undefined) for (const k of Object.keys(modes)) delete modes[k];
      modes[only ?? "*"] = mode;
      writeFileSync(modeFile, JSON.stringify(modes));
    },
    items: () => (existsSync(store) ? (JSON.parse(readFileSync(store, "utf8")) as Record<string, string>) : {}),
    runs: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }),
    clearRuns: () => {
      writeFileSync(log, "");
      writeFileSync(cmdLog, "");
    },
    commands: () =>
      readFileSync(cmdLog, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as string[]),
    trusted: () => (existsSync(aclFile) ? (JSON.parse(readFileSync(aclFile, "utf8")) as Record<string, "security" | "nobody">) : {}),
    runLog: () => readFileSync(log, "utf8"),
  };
}
