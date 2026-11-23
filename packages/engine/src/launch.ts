// Pure: decides exactly how a terminal process starts (file, argv, cwd, the
// command typed after start). Never uses a local shell to build or run ssh: the
// ssh argv is an array, and the only shell-interpreted string is the remote
// command, whose single variable part (the remote path) is single-quoted.
import { basename, join } from "node:path";
import { RequestParams, type Card, type Project, type SshHost, type Tool } from "@kokpit/shared";
import { engineError, type EngineError, type EngineConfig, type HostPaths, type LaunchSpec } from "./contracts.ts";
import type { SharedKey } from "@kokpit/shared/i18n";

export interface LaunchInput {
  config: EngineConfig;
  hostPaths: HostPaths;
  project: Project;
  card?: Card;
  /** Required for ssh projects: the host `project.location.hostId` points at. */
  host?: SshHost;
  tool?: Tool;
  /** Wins over `tool.command`. */
  command?: string;
  /** ssh executable (config tunable `sshBinary`). */
  sshBinary: string;
  /** `{{name}}` → value for engine files referenced by tool commands (tools.defaults.json `files`). */
  placeholders?: Record<string, string>;
}

const HostFields = RequestParams["sshHosts.create"].shape;
const ENTER = "\r";
const REMOTE_LOGIN_SHELL = `exec "$SHELL" -l`;

/** `{{name}}` in a tool command: an engine file (tools.defaults.json `files`). */
export const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/**
 * Replaces each `{{name}}` that has a value; unknown names stay as typed. Tool commands are stored with the
 * placeholders so the paths always point into the engine that is running now, not the one that seeded them.
 */
export function expandPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (m, name: string) => (Object.hasOwn(values, name) ? values[name]! : m));
}

/** POSIX single-quote escaping: the result is always exactly one shell word with the literal value. */
export function quoteShellArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Command ssh runs on the server: cd into `path` (if any), then replace itself with a login shell. */
export function remoteShellCommand(path: string | undefined): string {
  return path === undefined || path === "" ? REMOTE_LOGIN_SHELL : `cd ${quoteShellArg(path)} && ${REMOTE_LOGIN_SHELL}`;
}

function invalid(key: SharedKey): EngineError {
  return engineError("INVALID", key);
}

function token(value: unknown, what: SharedKey): string {
  const r = HostFields.hostname.safeParse(value);
  if (!r.success || typeof value !== "string") throw invalid(what);
  return value;
}

/** ssh argv before `--`: tty, and for Kokpit hosts port and identity file. */
function sshOptions(host: SshHost, hostPaths: HostPaths): string[] {
  return ["-t", ...sshConnectOptions(host, hostPaths)];
}

/** ssh connection options for a host (no tty): for Kokpit hosts port and identity file, nothing for aliases. */
export function sshConnectOptions(host: SshHost, hostPaths: HostPaths): string[] {
  const opts: string[] = [];
  // ssh-config aliases: ssh applies the alias's own Port/IdentityFile; repeating them could only diverge.
  if (host.source === "ssh-config") return opts;
  if (host.port !== undefined) {
    if (!HostFields.port.safeParse(host.port).success) throw invalid("engine.launch.badPort");
    opts.push("-p", String(host.port));
  }
  if (host.identityFile !== undefined) {
    if (!HostFields.identityFile.safeParse(host.identityFile).success) throw invalid("engine.launch.badKey");
    opts.push("-i", join(hostPaths.sshDir, host.identityFile), "-o", "IdentitiesOnly=yes");
  }
  return opts;
}

/** `user@hostname`, or the ssh-config alias. Every part is checked to be a safe token (never an option). */
export function sshTarget(host: SshHost): string {
  if (host.source === "ssh-config") return token(host.id, "engine.launch.badAlias");
  const hostname = token(host.hostname, "engine.launch.badAddress");
  return host.user === undefined ? hostname : `${token(host.user, "engine.launch.badUser")}@${hostname}`;
}

export function resolveLaunch(input: LaunchInput): LaunchSpec {
  const { config, hostPaths, project, card, host, tool, sshBinary } = input;
  const typed = input.command ?? (tool && expandPlaceholders(tool.command, input.placeholders ?? {}));
  const initial = typed !== undefined && typed !== "" ? { initialInput: typed + ENTER } : {};
  const named = input.command ?? tool?.name;
  if (card && card.projectId !== project.id) throw invalid("engine.launch.cardNotInProject");

  const loc = project.location;
  if (loc.kind === "ssh") {
    if (card) throw invalid("engine.launch.noCardsOnSsh");
    if (!host) throw invalid("engine.launch.hostNotFound");
    if (host.id !== loc.hostId) throw invalid("engine.launch.hostNotInProject");
    if (loc.path?.includes("\0")) throw invalid("engine.launch.badRemoteDir");
    return {
      file: sshBinary,
      args: [...sshOptions(host, hostPaths), "--", sshTarget(host), remoteShellCommand(loc.path)],
      cwd: hostPaths.homeDir,
      ...initial,
      title: named ?? host.name,
    };
  }

  const cwd = card?.worktreePath ?? loc.path;
  if (cwd === undefined) throw invalid("engine.launch.notCloned");
  return { file: config.shell, args: [...config.shellArgs], cwd, ...initial, title: named ?? basename(config.shell) };
}
