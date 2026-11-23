// Girişler: generic passwords in the macOS Keychain of the engine machine, through the system's `security` tool
// (path, names, limits and error rules from the config's `logins` block).
//
// How a secret travels — and where it must never be:
//   - STORE: `security add-generic-password … -w <secret>` would put the secret into the process list (argv is
//     world-readable with `ps`). Instead the tool is started as `security -i` ("interactive": it reads commands
//     from stdin) and the one command line is written to its stdin — a pipe only the two processes can read. The
//     argv of the process is exactly `-i`.
//   - READ: `security find-generic-password -a <account> -s <service> -w` prints the secret on its stdout (a pipe).
//     Its argv names the item only.
//   - The stored value is an envelope, `<secretPrefix><base64url(UTF-8)>`: ASCII without whitespace or quotes, so
//     the tool's line parser (measured: whitespace splits, quotes group, backslash escapes, 4095 characters per
//     line) can never be confused by a password, and `find … -w` (which prints hex for non-ASCII data) returns it
//     unchanged. It is an encoding for transport; the protection is the Keychain itself.
//   - ACCESS (`keychainAccess`, see logins-config.ts): by default `security` trusts ITSELF to read what it created,
//     which means every program of this user — an AI agent in a terminal too — could run
//     `security find-generic-password -w` and get the password without a question. In "confirm" mode (the default)
//     items are created with an empty trusted-application list (`-T ""`): every read, the engine's own included,
//     needs the user's click in macOS's dialog on the engine Mac. The access list is fixed when an item is CREATED
//     (the tool's help: "the application which creates an item is trusted… remove this default access by
//     explicitly specifying an empty app pathname: -T \"\""); whether `-U` (update) would reset it is not
//     documented, so in confirm mode the item is deleted and created again — one `security -i` run, two lines.
//     (`""` on an interactive line is an empty word, like in a shell — measured with `help ""`.)
//     If the user answers the dialog with "Always Allow", macOS adds `security` to that item's list: from then on
//     that item is readable silently again — their informed choice.
//   - The tool's stderr is read only to tell the failures apart; neither it nor stdout is ever logged or put into
//     an error. A KeychainError carries a kind and nothing else.
//   - The tool runs with the configured environment only (never the engine's access key) and is killed after
//     `timeoutMs`: a Keychain dialog nobody answers must not hang a request.
import { spawn as nodeSpawn } from "node:child_process";
import { KEYCHAIN_WORD, type LoginsConfig } from "./logins-config.ts";

export type KeychainFailure =
  /** No such item. */
  | "notFound"
  /** The Keychain is locked, or needs a dialog it may not show ("User interaction is not allowed"). */
  | "interaction"
  /** The user (or the item's access list) said no, or the Keychain password was wrong. */
  | "denied"
  /** No `security` tool, or no keychain to talk to. */
  | "unavailable"
  /** No answer within `timeoutMs` (typically: a dialog is waiting on the engine Mac's screen). */
  | "timeout"
  /** The item holds something this engine did not write. */
  | "garbage"
  /** The secret (or the command line) is over the configured size. */
  | "tooLarge"
  /** A reference that is not made of plain words, or an empty secret. */
  | "invalid"
  | "failed";

/** Carries the kind only — never the tool's output, never anything that was sent to it. */
export class KeychainError extends Error {
  readonly kind: KeychainFailure;
  constructor(kind: KeychainFailure) {
    super(`keychain: ${kind}`);
    this.name = "KeychainError";
    this.kind = kind;
  }
}

/** One Keychain item. Both parts are plain words (KEYCHAIN_WORD). */
export interface KeychainRef {
  service: string;
  account: string;
}

export interface Keychain {
  /** Creates the item or replaces its secret. */
  set(ref: KeychainRef, secret: string): Promise<void>;
  get(ref: KeychainRef): Promise<string>;
  /** False = there was no such item. */
  delete(ref: KeychainRef): Promise<boolean>;
}

export interface KeychainDeps {
  config: LoginsConfig;
  /** The engine's environment, for `envPassthrough`. */
  env?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The Keychain item of one login of one project. Ids that are not plain words are refused (`invalid`). */
export function keychainRef(config: Pick<LoginsConfig, "servicePrefix" | "accountFormat">, projectId: string, loginId: string): KeychainRef {
  if (!KEYCHAIN_WORD.test(projectId) || !KEYCHAIN_WORD.test(loginId)) throw new KeychainError("invalid");
  return { service: `${config.servicePrefix}${projectId}`, account: config.accountFormat.replaceAll("{loginId}", loginId) };
}

export function encodeSecret(secret: string, config: Pick<LoginsConfig, "secretPrefix">): string {
  return `${config.secretPrefix}${Buffer.from(secret, "utf8").toString("base64url")}`;
}

export function decodeSecret(stored: string, config: Pick<LoginsConfig, "secretPrefix">): string {
  if (!stored.startsWith(config.secretPrefix)) throw new KeychainError("garbage");
  const body = stored.slice(config.secretPrefix.length);
  if (!BASE64URL.test(body)) throw new KeychainError("garbage");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(body, "base64url"));
  } catch {
    throw new KeychainError("garbage");
  }
}

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export function createKeychain(deps: KeychainDeps): Keychain {
  const { config } = deps;
  const spawn = deps.spawn ?? nodeSpawn;
  const source = deps.env ?? process.env;

  function childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of config.envPassthrough) {
      const v = source[name];
      if (v !== undefined) env[name] = v;
    }
    return { ...env, ...config.env };
  }

  /** Runs the tool once. Rejects with a kind for "could not run / no answer / too much output"; never with output. */
  function run(args: readonly string[], stdin: string | undefined, timeoutMs: number = config.timeoutMs): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      let done = false;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let child;
      try {
        child = spawn(config.securityPath, [...args], { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        reject(new KeychainError("unavailable"));
        return;
      }
      const proc = child;
      const finish = (failure: KeychainFailure | undefined, code: number | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (failure) reject(new KeychainError(failure));
        else resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
      };
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        finish("timeout", null);
      }, timeoutMs);
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > config.maxOutputBytes) {
          proc.kill("SIGKILL");
          finish("garbage", null);
          return;
        }
        into.push(chunk);
      };
      proc.on("error", () => finish("unavailable", null));
      proc.stdout?.on("data", collect(out));
      proc.stderr?.on("data", collect(err));
      proc.on("close", (code) => finish(undefined, code));
      // A tool that exits without reading must not take the engine down with EPIPE.
      proc.stdin?.on("error", () => {});
      proc.stdin?.end(stdin ?? "");
    });
  }

  /** Which failure a non-zero exit is. The stderr text is matched and dropped. */
  function classify(r: RunResult): KeychainFailure {
    const text = r.stderr.toLowerCase();
    for (const kind of ["interaction", "denied", "unavailable", "notFound"] as const) {
      const rule = config.errors[kind];
      if ((r.code !== null && rule.exitCodes.includes(r.code)) || rule.patterns.some((p) => text.includes(p.toLowerCase()))) return kind;
    }
    return "failed";
  }

  function checked(ref: KeychainRef): KeychainRef {
    if (!KEYCHAIN_WORD.test(ref.service) || !KEYCHAIN_WORD.test(ref.account)) throw new KeychainError("invalid");
    return ref;
  }

  return {
    async set(ref, secret) {
      const { service, account } = checked(ref);
      if (secret === "") throw new KeychainError("invalid");
      if (Buffer.byteLength(secret, "utf8") > config.maxSecretBytes) throw new KeychainError("tooLarge");
      // One line, ended by a newline (the tool drops a last line without one). Every word is plain ASCII without
      // whitespace, quotes or backslashes, so nothing needs quoting.
      const item = `-a ${account} -s ${service}`;
      const line =
        config.keychainAccess === "confirm"
          ? `add-generic-password ${item} -w ${encodeSecret(secret, config)} -T ""\n`
          : `add-generic-password -U ${item} -w ${encodeSecret(secret, config)}\n`;
      if (line.length > config.maxCommandChars) throw new KeychainError("tooLarge");
      // confirm: delete first (its outcome does not matter — the status of the run is the last command's), so the
      // item is created with the empty access list whatever was there before.
      const r = await run(["-i"], config.keychainAccess === "confirm" ? `delete-generic-password ${item}\n${line}` : line);
      if (r.code !== 0) throw new KeychainError(classify(r));
    },
    async get(ref) {
      const { service, account } = checked(ref);
      // confirm: the user has to see and answer a dialog — a far longer wait than a tool call.
      const wait = config.keychainAccess === "confirm" ? config.confirmTimeoutMs : config.timeoutMs;
      const r = await run(["find-generic-password", "-a", account, "-s", service, "-w"], undefined, wait);
      if (r.code !== 0) throw new KeychainError(classify(r));
      return decodeSecret(r.stdout.toString("utf8").replace(/\r?\n$/, ""), config);
    },
    async delete(ref) {
      const { service, account } = checked(ref);
      const r = await run(["delete-generic-password", "-a", account, "-s", service], undefined);
      if (r.code === 0) return true;
      const kind = classify(r);
      if (kind === "notFound") return false;
      throw new KeychainError(kind);
    },
  };
}
