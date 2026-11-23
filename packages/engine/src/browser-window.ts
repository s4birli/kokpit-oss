// Gizli tarayıcı: helpers for a project Chrome's window mode ("hidden" = Chrome's headless mode, see
// chromeArgs). What a hidden Chrome presents of itself (User-Agent, client hints) is browser-identity.ts.

import { lstatSync, readFileSync } from "node:fs";

const MAX_PORT = 65535;

/**
 * The browser process (not a helper: no `--type=`) running `profileDir`, from `ps -ax -ww -o pid=,uid=,command=`
 * output: only processes of `uid` (the engine's own user — argv is anybody's to write: another macOS account can
 * name our profile and its own port in its command line). Also whether it runs headless and the DevTools port its
 * argv names — a CANDIDATE only: verifyProfileChrome must bind it to the system before anything trusts it. Chrome
 * puts `--user-data-dir` first and the path may hold spaces, so the flag must be followed by a space or the end of
 * the line (".../Acme" must not match ".../Acme2").
 */
export function findProfileChrome(psOutput: string, profileDir: string, uid: number): ProfileChrome | null {
  const flag = `--user-data-dir=${profileDir}`;
  for (const raw of psOutput.split("\n")) {
    const line = raw.trim();
    const [pidText, uidText] = line.split(/\s+/, 2);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || uidText !== String(uid)) continue;
    const at = line.indexOf(flag);
    if (at < 0) continue;
    const after = line.charAt(at + flag.length);
    if (after !== "" && after !== " ") continue;
    if (/(^|\s)--type=/.test(line)) continue;
    return { pid, headless: /(^|\s)--headless(=|\s|$)/.test(line), port: validPort(/(?:^|\s)--remote-debugging-port=(\d{1,5})(?:\s|$)/.exec(line)?.[1]) };
  }
  return null;
}

export interface ProfileChrome {
  pid: number;
  headless: boolean;
  port: number | null;
}

function validPort(text: string | undefined): number | null {
  const port = Number(text ?? NaN);
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : null;
}

/** Facts about a candidate, each read from the system rather than from its argv. */
export interface ProfileChromeFacts {
  candidate: ProfileChrome;
  /** The pid the profile's own SingletonLock (a symlink of ours inside the profile) names; null = none / not ours. */
  lockPid: number | null;
  /** The candidate's executable as the kernel maps it (lsof txt), resolved; null = unknown. */
  executable: string | null;
  /** The configured Chrome, resolved. */
  chromePath: string;
  /** Loopback TCP ports the candidate pid listens on (lsof). */
  listening: readonly number[];
  /** The profile's DevToolsActivePort (a regular file of ours inside the profile), when there is one. */
  activePort: number | null;
}

/**
 * The candidate as the engine may use it — adopt its DevTools endpoint, signal its pid — only when everything binds
 * it to this profile and to Chrome: the profile's lock names that pid, the pid runs the configured Chrome, and the
 * DevTools port (the profile's DevToolsActivePort, else argv) is one that very pid listens on. Else null: neither
 * connected to nor killed.
 */
export function verifyProfileChrome(f: ProfileChromeFacts): ProfileChrome | null {
  const { candidate } = f;
  if (f.lockPid !== candidate.pid) return null;
  if (f.executable === null || f.executable !== f.chromePath) return null;
  const port = f.activePort ?? candidate.port;
  if (port === null || !f.listening.includes(port)) return null;
  return { ...candidate, port };
}

/**
 * `lsof -a -p <pid> -iTCP -sTCP:LISTEN -P -n -Fn`: the ports it listens on at exactly `host` — the address the
 * engine connects to. A listener on another address (::1, a wildcard) proves nothing about `host:<port>`.
 */
export function lsofListenPorts(text: string, host: string): number[] {
  const ports: number[] = [];
  const prefix = `n${host}:`;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(prefix)) continue;
    const digits = line.slice(prefix.length);
    const port = /^\d{1,5}$/.test(digits) ? validPort(digits) : null;
    if (port !== null && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

/** `lsof -a -p <pid> -d txt -Fn`: the first mapped file is the process's executable. */
export function lsofExecutable(text: string): string | null {
  for (const line of text.split("\n")) if (line.startsWith("n/")) return line.slice(1);
  return null;
}

/** Chrome's profile lock is a symlink to "<hostname>-<pid>". */
export function singletonLockPid(target: string): number | null {
  const m = /-(\d+)$/.exec(target);
  const pid = Number(m?.[1] ?? NaN);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether `mapped` (the executable a process runs, from lsof) is the configured Chrome's executable: the same path,
 * or a regular file with exactly the same bytes. Chrome on macOS runs a clone of its own bundle from the user's temp
 * dir (".../com.google.Chrome.code_sign_clone/.../Google Chrome.app.bundle/Contents/MacOS/Google Chrome"), so the path
 * alone rejects our own Chrome. A file with Chrome's bytes is Chrome (signed; the uid check is separate). A link,
 * folder or missing file is not.
 */
export function isChromeExecutable(mapped: string | null, chromePath: string): boolean {
  if (mapped === null) return false;
  if (mapped === chromePath) return true;
  try {
    const a = lstatSync(mapped);
    const b = lstatSync(chromePath);
    if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
    return readFileSync(mapped).equals(readFileSync(chromePath));
  } catch {
    return false;
  }
}
