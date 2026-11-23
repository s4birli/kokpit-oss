// Pure helpers for running the engine as a per-user launchd agent (gui domain).
// No I/O here: scripts/launchd.ts reads inputs and performs the side effects.
import { basename, delimiter, dirname, isAbsolute, join, normalize, sep } from "node:path";

export interface PlistOptions {
  label: string;
  /** [node, entry]: node itself, never a shell wrapper (TCC grants Full Disk Access per binary). */
  programArguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  keepAlive: boolean;
  /** Seconds launchd waits between restarts. */
  throttleInterval: number;
  runAtLoad: boolean;
}

// Characters XML 1.0 cannot represent at all (even escaped).
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function xmlEscape(s: string): string {
  return s
    .replace(XML_INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const str = (s: string): string => `<string>${xmlEscape(s)}</string>`;
const bool = (b: boolean): string => (b ? "<true/>" : "<false/>");
const key = (k: string): string => `<key>${xmlEscape(k)}</key>`;

export function renderPlist(o: PlistOptions): string {
  if (!Number.isInteger(o.throttleInterval) || o.throttleInterval < 0) {
    throw new Error(`throttleInterval must be a non-negative integer, got ${o.throttleInterval}`);
  }
  const i1 = "\t";
  const i2 = "\t\t";
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    i1 + key("Label"),
    i1 + str(o.label),
    i1 + key("ProgramArguments"),
    i1 + "<array>",
    ...o.programArguments.map((a) => i2 + str(a)),
    i1 + "</array>",
    i1 + key("WorkingDirectory"),
    i1 + str(o.workingDirectory),
    i1 + key("EnvironmentVariables"),
    i1 + "<dict>",
    ...Object.entries(o.environment).flatMap(([k, v]) => [i2 + key(k), i2 + str(v)]),
    i1 + "</dict>",
    i1 + key("StandardOutPath"),
    i1 + str(o.stdoutPath),
    i1 + key("StandardErrorPath"),
    i1 + str(o.stderrPath),
    i1 + key("RunAtLoad"),
    i1 + bool(o.runAtLoad),
    i1 + key("KeepAlive"),
    i1 + bool(o.keepAlive),
    i1 + key("ThrottleInterval"),
    i1 + `<integer>${o.throttleInterval}</integer>`,
    i1 + key("ProcessType"),
    i1 + str("Interactive"),
    `</dict>`,
    `</plist>`,
    ``,
  ];
  return lines.join("\n");
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveLabel(i: { flag?: string; env?: string; fallback: string }): string {
  const label = i.flag || i.env || i.fallback;
  if (!LABEL_RE.test(label) || label.includes("..")) throw new Error(`invalid launchd label: ${JSON.stringify(label)}`);
  return label;
}

export interface BuildInput {
  label: string;
  configPath: string;
  nodePath: string;
  entryPath: string;
  /** The installing process' environment (PATH, HOME, SHELL, LANG are carried over). */
  env: Record<string, string | undefined>;
  defaultLang: string;
  /** Log directory relative to HOME. Must be on the internal disk: launchd cannot open log files on removable volumes. */
  logDir: string;
  throttleInterval: number;
}

export const STDOUT_LOG = "engine.out.log";
export const STDERR_LOG = "engine.err.log";

export function logPaths(home: string, logDir: string): { dir: string; out: string; err: string } {
  if (!isAbsolute(home)) throw new Error(`HOME must be absolute: ${home}`);
  const rel = logDir ? normalize(logDir) : "";
  if (!rel || isAbsolute(rel) || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`logDir must be a relative path inside HOME, got ${JSON.stringify(logDir)}`);
  }
  const dir = join(home, rel);
  return { dir, out: join(dir, STDOUT_LOG), err: join(dir, STDERR_LOG) };
}

/** Where to grant Full Disk Access to `binary` (the fully resolved node executable). */
export function fullDiskAccessNotice(binary: string): string {
  return [
    `Tam Disk Erişimi gereken ikili: ${binary}`,
    `Sistem Ayarları › Gizlilik ve Güvenlik › Tam Disk Erişimi › + › Cmd+Shift+G ile bu yolu ekleyin.`,
  ].join("\n");
}

/** PATH, deduplicated, with node's own directory guaranteed present (launchd starts with a minimal PATH). */
function pathWithNode(path: string | undefined, nodePath: string): string {
  const nodeDir = dirname(nodePath);
  const entries = [...new Set((path ?? "").split(delimiter).filter(Boolean))];
  return entries.includes(nodeDir) ? entries.join(delimiter) : [nodeDir, ...entries].join(delimiter);
}

/**
 * process.execPath is the fully resolved binary (e.g. a versioned Homebrew
 * Cellar path) and breaks on upgrade. Prefer the first `node` on PATH that
 * resolves to the same binary; otherwise keep execPath.
 */
export function stableNodePath(
  execPath: string,
  path: string | undefined,
  realpath: (p: string) => string | null,
): string {
  const target = realpath(execPath) ?? execPath;
  for (const dir of (path ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, basename(execPath));
    if (realpath(candidate) === target) return candidate;
  }
  return execPath;
}

export function buildPlistOptions(i: BuildInput): PlistOptions {
  for (const [name, p] of Object.entries({
    configPath: i.configPath,
    nodePath: i.nodePath,
    entryPath: i.entryPath,
  })) {
    if (!isAbsolute(p)) throw new Error(`${name} must be absolute: ${p}`);
  }
  const home = i.env.HOME;
  if (!home) throw new Error("HOME is not set");
  if (!isAbsolute(home)) throw new Error(`HOME must be absolute: ${home}`);

  const environment: Record<string, string> = {
    PATH: pathWithNode(i.env.PATH, i.nodePath),
    HOME: home,
  };
  if (i.env.SHELL) environment.SHELL = i.env.SHELL;
  environment.LANG = i.env.LANG || i.defaultLang;
  environment.KOKPIT_CONFIG = i.configPath;

  // When dataDir's disk is not mounted yet the config loader exits non-zero;
  // KeepAlive + ThrottleInterval relaunch the engine later.
  const logs = logPaths(home, i.logDir);
  return {
    label: i.label,
    programArguments: [i.nodePath, i.entryPath],
    workingDirectory: home,
    environment,
    stdoutPath: logs.out,
    stderrPath: logs.err,
    keepAlive: true,
    throttleInterval: i.throttleInterval,
    runAtLoad: true,
  };
}

export function launchctlCommands(
  uid: number,
  label: string,
  plistPath: string,
): { bootout: string[]; bootstrap: string[]; kickstart: string[]; print: string[] } {
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  return {
    bootout: ["bootout", target],
    bootstrap: ["bootstrap", domain, plistPath],
    kickstart: ["kickstart", "-k", target],
    print: ["print", target],
  };
}

export interface LaunchdStatus {
  state: string | null;
  pid: number | null;
  runs: number | null;
  lastExitCode: string | null;
  path: string | null;
}

/** Summary of `launchctl print gui/<uid>/<label>`; only top-level fields of the service block. */
export function parseLaunchctlPrint(out: string): LaunchdStatus {
  const s: LaunchdStatus = { state: null, pid: null, runs: null, lastExitCode: null, path: null };
  let depth = 0;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line.endsWith("{")) {
      depth++;
      if (depth > 1) continue;
    }
    if (line === "}") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    const m = /^([a-z ]+?) = (.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m as unknown as [string, string, string];
    if (k === "state") s.state = v;
    else if (k === "pid") s.pid = Number(v);
    else if (k === "runs") s.runs = Number(v);
    else if (k === "last exit code") s.lastExitCode = v;
    else if (k === "path") s.path = v;
  }
  return s;
}
