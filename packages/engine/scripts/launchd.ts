// Installs / removes the Kokpit engine as a per-user launchd agent.
//
//   node packages/engine/scripts/launchd.ts install --config <path> [--label <label>] [--dry-run]
//   node packages/engine/scripts/launchd.ts uninstall [--label <label>]
//   node packages/engine/scripts/launchd.ts status [--label <label>]
//   node packages/engine/scripts/launchd.ts print --config <path> [--label <label>]
//
// All side effects go through CliDeps so tests run without touching launchd.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildPlistOptions,
  launchctlCommands,
  fullDiskAccessNotice,
  logPaths,
  parseLaunchctlPrint,
  renderPlist,
  resolveLabel,
  stableNodePath,
} from "../src/launchd.ts";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CliDeps {
  homedir: string;
  uid: number;
  env: Record<string, string | undefined>;
  execPath: string;
  cwd: string;
  /** Resolves symlinks; null when the path does not exist. */
  realpath(path: string): string | null;
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  mkdirp(path: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
  run(cmd: string, args: string[]): RunResult;
  sleep(ms: number): Promise<void>;
  stdout(s: string): void;
  stderr(s: string): void;
}

interface Defaults {
  label: string;
  throttleInterval: number;
  /** Relative to the user's home directory. */
  logDir: string;
  defaultLang: string;
  /** Relative to the user's home directory. */
  launchAgentsDir: string;
  labelEnv: string;
  plutil: string;
  launchctl: string;
  /** After bootout: poll `launchctl print` every bootoutPollMs, at most bootoutMaxPolls times, until it fails. */
  bootoutPollMs: number;
  bootoutMaxPolls: number;
  /** bootstrap is retried this many extra times, bootstrapRetryDelayMs apart, on these exit codes. */
  bootstrapRetries: number;
  bootstrapRetryDelayMs: number;
  /** 5 = "Input/output error": the previous instance is still being torn down. */
  bootstrapRetryExitCodes: number[];
}

const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATHS = {
  defaults: join(ENGINE_DIR, "launchd", "defaults.json"),
  entry: join(ENGINE_DIR, "src", "main.ts"),
};

function loadDefaults(): Defaults {
  return JSON.parse(readFileSync(PATHS.defaults, "utf8")) as Defaults;
}

const USAGE = `usage:
  launchd.ts install --config <path> [--label <label>] [--dry-run]
  launchd.ts uninstall [--label <label>]
  launchd.ts status [--label <label>]
  launchd.ts print --config <path> [--label <label>]
`;

class CliError extends Error {}

function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

function readDataDir(deps: CliDeps, configPath: string): string {
  let raw: string;
  try {
    raw = deps.readFile(configPath);
  } catch (e) {
    throw new CliError(`cannot read config ${configPath}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliError(`config ${configPath} is not valid JSON: ${(e as Error).message}`);
  }
  const dataDir = (parsed as { dataDir?: unknown } | null)?.dataDir;
  if (typeof dataDir !== "string" || dataDir === "") throw new CliError(`config ${configPath} has no "dataDir"`);
  const expanded = expandHome(dataDir, deps.homedir);
  if (!isAbsolute(expanded)) throw new CliError(`"dataDir" must be an absolute path, got ${JSON.stringify(dataDir)}`);
  return expanded;
}

function plan(deps: CliDeps, defaults: Defaults, label: string, configArg: string | undefined) {
  if (!configArg) throw new CliError("--config <path> is required");
  const configPath = resolve(deps.cwd, expandHome(configArg, deps.homedir));
  readDataDir(deps, configPath); // fail early on a broken config
  const home = deps.env.HOME || deps.homedir;
  const opts = buildPlistOptions({
    label,
    configPath,
    nodePath: deps.execPath,
    entryPath: PATHS.entry,
    env: { ...deps.env, HOME: home },
    defaultLang: defaults.defaultLang,
    logDir: defaults.logDir,
    throttleInterval: defaults.throttleInterval,
  });
  // TCC grants Full Disk Access to the resolved binary, not to a symlink.
  const fdaBinary = deps.realpath(deps.execPath) ?? deps.execPath;
  return { opts, xml: renderPlist(opts), logDir: logPaths(home, defaults.logDir).dir, fdaBinary };
}

function agentsDir(deps: CliDeps, defaults: Defaults): string {
  return join(deps.homedir, defaults.launchAgentsDir);
}

const shellQuote = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const cmdline = (cmd: string, args: string[]): string => [cmd, ...args].map(shellQuote).join(" ");

function must(deps: CliDeps, cmd: string, args: string[]): RunResult {
  const r = deps.run(cmd, args);
  if (r.status !== 0) {
    throw new CliError(`${cmdline(cmd, args)} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

/** bootout returns before launchd has finished removing the service; wait until `print` no longer finds it. */
async function waitUntilGone(deps: CliDeps, defaults: Defaults, printArgs: string[]): Promise<void> {
  for (let i = 0; i < defaults.bootoutMaxPolls; i++) {
    if (deps.run(defaults.launchctl, printArgs).status !== 0) return;
    if (i < defaults.bootoutMaxPolls - 1) await deps.sleep(defaults.bootoutPollMs);
  }
  deps.stderr(`launchd: service still present after bootout; bootstrapping anyway\n`);
}

async function bootstrapWithRetry(deps: CliDeps, defaults: Defaults, args: string[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const r = deps.run(defaults.launchctl, args);
    if (r.status === 0) return;
    const retryable = r.status !== null && defaults.bootstrapRetryExitCodes.includes(r.status);
    if (!retryable || attempt >= defaults.bootstrapRetries) {
      throw new CliError(`${cmdline(defaults.launchctl, args)} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
    }
    await deps.sleep(defaults.bootstrapRetryDelayMs);
  }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        label: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
    });
    const command = positionals[0];
    if (positionals.length !== 1 || !["install", "uninstall", "status", "print"].includes(command ?? "")) {
      deps.stderr(USAGE);
      return 64;
    }
    const defaults = loadDefaults();
    const label = resolveLabel({ flag: values.label, env: deps.env[defaults.labelEnv], fallback: defaults.label });
    const plistPath = join(agentsDir(deps, defaults), `${label}.plist`);
    const lc = launchctlCommands(deps.uid, label, plistPath);

    switch (command) {
      case "print": {
        // stdout stays a pure plist (pipeable); the notice goes to stderr.
        const p = plan(deps, defaults, label, values.config);
        deps.stdout(p.xml);
        deps.stderr(`${fullDiskAccessNotice(p.fdaBinary)}\n`);
        return 0;
      }
      case "install": {
        const p = plan(deps, defaults, label, values.config);
        if (values["dry-run"]) {
          deps.stdout(`# ${plistPath}\n${p.xml}\n`);
          deps.stdout(
            [
              `# commands (dry run, nothing executed):`,
              cmdline("mkdir", ["-p", p.logDir]),
              cmdline("mkdir", ["-p", agentsDir(deps, defaults)]),
              `# write ${shellQuote(plistPath)}`,
              cmdline(defaults.plutil, ["-lint", plistPath]),
              cmdline(defaults.launchctl, lc.bootout) + "  # failure ignored",
              cmdline(defaults.launchctl, lc.print) +
                `  # repeated until not found (every ${defaults.bootoutPollMs} ms, at most ${defaults.bootoutMaxPolls} times)`,
              cmdline(defaults.launchctl, lc.bootstrap) +
                `  # retried up to ${defaults.bootstrapRetries} times on exit ${defaults.bootstrapRetryExitCodes.join("/")}`,
              cmdline(defaults.launchctl, lc.kickstart),
              "",
              ...fullDiskAccessNotice(p.fdaBinary)
                .split("\n")
                .map((l) => `# ${l}`),
              "",
            ].join("\n"),
          );
          return 0;
        }
        deps.mkdirp(p.logDir);
        deps.mkdirp(agentsDir(deps, defaults));
        deps.writeFile(plistPath, p.xml);
        must(deps, defaults.plutil, ["-lint", plistPath]);
        deps.run(defaults.launchctl, lc.bootout); // not loaded yet is fine
        await waitUntilGone(deps, defaults, lc.print);
        await bootstrapWithRetry(deps, defaults, lc.bootstrap);
        must(deps, defaults.launchctl, lc.kickstart);
        deps.stdout(`installed ${label}\n  plist: ${plistPath}\n  logs:  ${p.opts.stdoutPath}\n         ${p.opts.stderrPath}\n`);
        deps.stdout(`${fullDiskAccessNotice(p.fdaBinary)}\n`);
        return 0;
      }
      case "uninstall": {
        deps.run(defaults.launchctl, lc.bootout); // not loaded is fine
        if (deps.exists(plistPath)) deps.remove(plistPath);
        deps.stdout(`uninstalled ${label}\n`);
        return 0;
      }
      case "status": {
        const r = deps.run(defaults.launchctl, lc.print);
        if (r.status !== 0) {
          deps.stdout(`${label}: not loaded (plist ${deps.exists(plistPath) ? "present" : "absent"}: ${plistPath})\n`);
          return 3;
        }
        const s = parseLaunchctlPrint(r.stdout);
        deps.stdout(
          [
            `${label}`,
            `  state:          ${s.state ?? "?"}`,
            `  pid:            ${s.pid ?? "-"}`,
            `  runs:           ${s.runs ?? "?"}`,
            `  last exit code: ${s.lastExitCode ?? "?"}`,
            `  plist:          ${s.path ?? plistPath}`,
            "",
          ].join("\n"),
        );
        return 0;
      }
    }
    return 64;
  } catch (e) {
    deps.stderr(`launchd: ${(e as Error).message}\n`);
    return e instanceof CliError ? 1 : 70;
  }
}

export function realDeps(): CliDeps {
  const realpath = (p: string): string | null => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  return {
    homedir: homedir(),
    uid: process.getuid?.() ?? 0,
    env: process.env,
    execPath: stableNodePath(process.execPath, process.env.PATH, realpath),
    cwd: process.cwd(),
    realpath,
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, d) => writeFileSync(p, d, { mode: 0o644 }),
    mkdirp: (p) => void mkdirSync(p, { recursive: true }),
    remove: (p) => rmSync(p, { force: true }),
    exists: (p) => existsSync(p),
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8" });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? r.error?.message ?? "" };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), realDeps());
}
