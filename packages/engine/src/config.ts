// Loads the engine configuration. The only module that reads env or config files.
//
// Precedence (low → high): config.defaults.json (shipped next to this package)
// < user file (KOKPIT_CONFIG, else $XDG_CONFIG_HOME/kokpit/engine.json, else
// ~/.config/kokpit/engine.json) < env overrides (KOKPIT_PORT, KOKPIT_DATA_DIR,
// KOKPIT_KEY, KOKPIT_BUFFER_BYTES, KOKPIT_TERMINAL_ZDOTDIR, KOKPIT_BG_AGENTS_POLL_MS,
// KOKPIT_PLAYWRIGHT_MCP_OUTPUT_PARENT_DIR, KOKPIT_LANGUAGE).
//
// Engine tunables (flushIntervalMs, killGraceMs, slugMaxLen, slugFallback,
// gitCloneTimeoutMs, builtinProjectId, builtinProjectName, sshBinary, …) live
// as flat keys in the same files and are returned under `config.tunables`.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ACCESS_KEY_MIN_BYTES, isStrongAccessKey, type Project } from "@kokpit/shared";
import { LOCALES, type Locale } from "@kokpit/shared/i18n";
import { BrowserConfigSchema, BrowserFileSchema, type BrowserConfig } from "./browser-config.ts";
import { LoginsConfigSchema, LoginsFileSchema, type LoginsConfig } from "./logins-config.ts"; // Girişler
import type { DataPaths, EngineConfig, HostPaths, Logger } from "./contracts.ts";
import { PRIVATE_FILE_MODE } from "./fs-safety.ts";
import { createLogger } from "./logger.ts";
import { DEFAULT_LOCAL_HOST, isEngineAddress, isLoopbackAddress, localInterfaceAddresses } from "./net.ts";
import { slugify } from "./slug.ts";
import { MapConfigOverrideSchema, type MapConfigOverride } from "./map.ts";
import { FilesConfigOverrideSchema, type FilesConfigOverride } from "./files.ts";
import { ClaudeAccountsConfigSchema, ClaudeAccountsFileSchema, type ClaudeAccountsTunables } from "./claude-accounts.ts"; // İş H
import { FlowConfigOverrideSchema, type FlowConfigOverride } from "./flow.ts"; // İş W
import { ClaudeInventoryConfigOverrideSchema, type ClaudeInventoryConfigOverride } from "./claude-inventory.ts";
import { AppUpdatesConfigOverrideSchema, type AppUpdatesConfigOverride } from "./app-updates.ts"; // Kendini güncelleme
import { ClaudeUsageConfigOverrideSchema, type ClaudeUsageConfigOverride } from "./claude-usage.ts";

export interface EngineTunables {
  /** How often terminal buffers are flushed to disk. */
  flushIntervalMs: number;
  /** Grace period between SIGTERM/SIGHUP and SIGKILL when closing a terminal. */
  killGraceMs: number;
  /** Max length of a generated slug (card branch / project id). */
  slugMaxLen: number;
  /** Slug used when a name has no usable characters. */
  slugFallback: string;
  /** Max time a `git clone` of a github project may take. */
  gitCloneTimeoutMs: number;
  /** Id of the built-in project at the user's home dir. */
  builtinProjectId: string;
  /** Display name of the built-in project. */
  builtinProjectName: string;
  /** ssh client for terminals of ssh projects (a name looked up in PATH, or an absolute path). */
  sshBinary: string;
  /** İş A: agent activity tracking (file keys activityWindowMs, activityDebounceMs, …). */
  activity: ActivityTunables;
  /** İş A (Adım 7): background Claude sessions (file keys claudeBinary, bgAgentsPollMs, …). */
  bgAgents: BgAgentsTunables;
  /**
   * ZDOTDIR for terminal shells. Unset: terminals get none, so zsh uses $HOME (an engine started from a dev
   * shell or a test would otherwise hand its own ZDOTDIR, and that .zshrc, to every terminal).
   */
  terminalZdotdir?: string;
}

/** İş A: see activity.ts. */
export interface ActivityTunables {
  windowMs: number;
  debounceMs: number;
  scanLines: number;
  summaryMaxLen: number;
  tailChars: number;
}

/** İş A (Adım 7): see bg-agents.ts. */
export interface BgAgentsTunables {
  /** `claude` CLI (a name looked up in PATH, or an absolute path). */
  claudeBinary: string;
  /** How often `claude agents --json --all` runs while a client is connected; 0 = feature off. */
  pollMs: number;
  /** Performans: an unchanged list slows polling down to this (see bg-agents.ts `idlePollMaxMs`). */
  idlePollMaxMs: number;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Max characters of `bgAgents.logs` text (newest kept). */
  logsMaxChars: number;
}

/** EngineConfig plus engine tunables. Assignable to EngineConfig. */
export interface KokpitConfig extends EngineConfig {
  tunables: EngineTunables;
  /** i18n: language of the engine's own text (config.defaults.json, engine.json `language`, env KOKPIT_LANGUAGE). */
  language: Locale;
  /** İş C — Harita: overrides of map.defaults.json (engine.json `map`). */
  map: MapConfigOverride;
  /** İş F — Dosyalar: overrides of files.defaults.json (engine.json `files`). */
  files: FilesConfigOverride;
  /** İş W — Akış: overrides of flow.defaults.json (engine.json `flow`). */
  flow: FlowConfigOverride;
  /** İş C (Adım 8) — Claude envanteri: overrides of claude-inventory.defaults.json (engine.json `claudeInventory`). */
  claudeInventory: ClaudeInventoryConfigOverride;
  /** Kendini güncelleme: overrides of app-updates.defaults.json (engine.json `appUpdates`). */
  appUpdates: AppUpdatesConfigOverride;
  /** Claude kullanımı: overrides of claude-usage.defaults.json (engine.json `claudeUsage`). */
  claudeUsage: ClaudeUsageConfigOverride;
  /** İş B: Chrome per project (`browser` block, defaults merged key by key with the user file). */
  browser: BrowserConfig;
  /** Girişler: saved logins in the macOS Keychain (`logins` block, defaults merged key by key with the user file). */
  logins: LoginsConfig;
  /** İş H: Claude accounts (`claudeAccounts` block, defaults merged key by key with the user file). */
  claudeAccounts: ClaudeAccountsTunables;
}

const DEFAULTS_PATH = fileURLToPath(new URL("../config.defaults.json", import.meta.url));
const KEY_FILE_NAME = "engine.key";
const KEY_BYTES = 32;
const KEY_FILE_MODE = PRIVATE_FILE_MODE;

// Validation bounds (sanity limits, not settings).
const MAX_PORT = 65535;
const MAX_BUFFER_BYTES = 2 ** 30;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_ID_LEN = 200;
const MAX_KEY_LEN = 1000;
const MAX_ACTIVITY_COUNT = 10_000;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------- schemas ----------

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const absPathLike = z.string().min(1);

function isCidr(s: string): boolean {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(s);
  if (!m) return false;
  const fam = isIP(m[1]!);
  const bits = Number(m[2]);
  return (fam === 4 && bits <= 32) || (fam === 6 && bits <= 128);
}

/** Never echoes the key; tells how to make a strong one (a captured handshake proof must not allow offline guessing). */
const WEAK_KEY = `must be at least ${ACCESS_KEY_MIN_BYTES} random bytes, base64url (≥43 chars) or hex (≥64 chars); delete the engine.key file and restart to get one generated, or make one with: node -e "console.log(require('crypto').randomBytes(${ACCESS_KEY_MIN_BYTES}).toString('base64url'))"`;
const KeySchema = z.string().max(MAX_KEY_LEN).refine(isStrongAccessKey, { message: WEAK_KEY });

const ProjectInput = z
  .object({ name: z.string().min(1), repoPath: absPathLike, id: z.string().min(1).max(MAX_ID_LEN).optional() })
  .strict();

const FileSchema = z
  .object({
    port: int(0, MAX_PORT),
    dataDir: absPathLike,
    bufferBytes: int(1, MAX_BUFFER_BYTES),
    shell: absPathLike,
    shellArgs: z.array(z.string()),
    branchPrefix: z.string(),
    baseBranch: z.string().min(1).nullable(),
    authTimeoutMs: int(1, MAX_DURATION_MS),
    authNonceMemory: int(0, 1_000_000),
    tailscaleRescanMs: int(1, MAX_DURATION_MS),
    wsPingIntervalMs: int(0, MAX_DURATION_MS),
    listenLocalhost: z.boolean(),
    listenTailscale: z.boolean(),
    tailscaleCidrs: z.array(z.string().refine(isCidr, "expected a CIDR like 100.64.0.0/10")),
    key: KeySchema,
    projects: z.array(ProjectInput),
    flushIntervalMs: int(1, MAX_DURATION_MS),
    killGraceMs: int(0, MAX_DURATION_MS),
    slugMaxLen: int(1, MAX_ID_LEN),
    slugFallback: z.string().regex(SLUG_RE, "expected a lowercase ascii slug"),
    gitCloneTimeoutMs: int(1, MAX_DURATION_MS),
    builtinProjectId: z.string().max(MAX_ID_LEN).regex(SLUG_RE, "expected a lowercase ascii slug"),
    builtinProjectName: z.string().trim().min(1),
    sshBinary: z.string().min(1),
    map: MapConfigOverrideSchema,
    files: FilesConfigOverrideSchema,
    flow: FlowConfigOverrideSchema, // İş W
    claudeInventory: ClaudeInventoryConfigOverrideSchema,
    appUpdates: AppUpdatesConfigOverrideSchema, // Kendini güncelleme
    claudeUsage: ClaudeUsageConfigOverrideSchema,
    // İş A
    activityWindowMs: int(1, MAX_DURATION_MS),
    activityDebounceMs: int(0, MAX_DURATION_MS),
    activityScanLines: int(1, MAX_ACTIVITY_COUNT),
    activitySummaryMaxLen: int(1, MAX_ACTIVITY_COUNT),
    activityTailChars: int(1, MAX_BUFFER_BYTES),
    // İş A (Adım 7)
    claudeBinary: z.string().min(1),
    bgAgentsPollMs: int(0, MAX_DURATION_MS),
    bgAgentsIdlePollMaxMs: int(0, MAX_DURATION_MS),
    bgAgentsTimeoutMs: int(1, MAX_DURATION_MS),
    bgAgentsMaxOutputBytes: int(1, MAX_BUFFER_BYTES),
    bgAgentsLogsMaxChars: int(1, MAX_BUFFER_BYTES),
    browser: BrowserFileSchema, // İş B
    logins: LoginsFileSchema, // Girişler
    claudeAccounts: ClaudeAccountsFileSchema, // İş H
    terminalZdotdir: z.string().min(1).refine(isAbsolute, "must be an absolute path"),
    /** i18n: the language of the text the engine writes itself and of its errors' `message`. */
    language: z.enum(LOCALES),
  })
  .partial()
  .strict();
type FileConfig = z.infer<typeof FileSchema>;

class ConfigError extends Error {
  constructor(configPath: string, field: string, message: string) {
    super(`config ${configPath}: ${field}: ${message}`);
    this.name = "ConfigError";
  }
}

function parseFile(raw: unknown, source: string, configPath: string): FileConfig {
  const r = FileSchema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
  let msg = issue?.message ?? "invalid";
  if (issue?.code === "unrecognized_keys") msg += ` (${issue.keys.join(", ")})`;
  throw new ConfigError(configPath, field, `${msg} [${source}]`);
}

// ---------- helpers ----------

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function resolveConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  if (env.KOKPIT_CONFIG) return resolve(expandHome(env.KOKPIT_CONFIG, home));
  const base = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, home) : join(home, ".config");
  return join(base, "kokpit", "engine.json");
}

function readJson(path: string, configPath: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(configPath, label, `cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(configPath, label, `invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

function envOverrides(env: NodeJS.ProcessEnv, configPath: string): FileConfig {
  const out: Record<string, unknown> = {};
  const intVar = (name: string, field: string) => {
    const v = env[name];
    if (v === undefined || v === "") return;
    if (!/^\d+$/.test(v)) throw new ConfigError(configPath, field, `env ${name} must be a non-negative integer`);
    out[field] = Number(v);
  };
  intVar("KOKPIT_PORT", "port");
  intVar("KOKPIT_BUFFER_BYTES", "bufferBytes");
  intVar("KOKPIT_BG_AGENTS_POLL_MS", "bgAgentsPollMs");
  if (env.KOKPIT_DATA_DIR) out.dataDir = env.KOKPIT_DATA_DIR;
  if (env.KOKPIT_KEY !== undefined && env.KOKPIT_KEY !== "") out.key = env.KOKPIT_KEY;
  if (env.KOKPIT_TERMINAL_ZDOTDIR) out.terminalZdotdir = env.KOKPIT_TERMINAL_ZDOTDIR;
  if (env.KOKPIT_LANGUAGE) out.language = env.KOKPIT_LANGUAGE;
  return parseFile(out, "env KOKPIT_*", configPath);
}

function ensureDataDir(dir: string, configPath: string): void {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new ConfigError(configPath, "dataDir", `${dir} exists but is not a directory`);
    return;
  }
  const parent = dirname(dir);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new ConfigError(
      configPath,
      "dataDir",
      `veri klasörü erişilemiyor, disk bağlı mı? (${dir}; üst klasör ${parent} yok)`,
    );
  }
  mkdirSync(dir);
}

function loadOrCreateKey(dataDir: string, configPath: string, logger: Logger): string {
  const file = join(dataDir, KEY_FILE_NAME);
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    if ((mode & ~KEY_FILE_MODE) !== 0) {
      chmodSync(file, KEY_FILE_MODE);
      logger.warn("key file permissions were too wide; tightened to 0600", { file, mode: mode.toString(8) });
    }
    const key = readFileSync(file, "utf8").trim();
    if (!KeySchema.safeParse(key).success) {
      throw new ConfigError(configPath, "key", `key file ${file}: ${WEAK_KEY}`);
    }
    return key;
  }
  const key = randomBytes(KEY_BYTES).toString("base64url");
  writeFileSync(file, key + "\n", { mode: KEY_FILE_MODE, flag: "wx" });
  chmodSync(file, KEY_FILE_MODE);
  logger.info("generated new access key", { file });
  return key;
}

// ---------- public ----------

/** Home, ~/.ssh and ~/.ssh/config of the user the engine runs as. Creates nothing. */
export function hostPaths(env: NodeJS.ProcessEnv = process.env): HostPaths {
  const homeDir = env.HOME || homedir();
  const sshDir = join(homeDir, ".ssh");
  return { homeDir, sshDir, sshConfigFile: join(sshDir, "config") };
}


export async function loadConfig(opts: { env?: NodeJS.ProcessEnv; logger?: Logger } = {}): Promise<KokpitConfig> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? createLogger();
  const home = hostPaths(env).homeDir;
  const configPath = resolveConfigPath(env, home);

  const defaults = parseFile(readJson(DEFAULTS_PATH, configPath, "defaults"), `defaults ${DEFAULTS_PATH}`, configPath);

  const rawUser = readJson(configPath, configPath, "(root)");
  if (rawUser === undefined) logger.info("no user config file; using defaults and env", { configPath });
  const user = rawUser === undefined ? {} : parseFile(rawUser, "user file", configPath);

  const m: FileConfig = { ...defaults, ...user, ...envOverrides(env, configPath) };

  const required = <K extends keyof FileConfig>(k: K): NonNullable<FileConfig[K]> => {
    const v = m[k];
    if (v === undefined) throw new ConfigError(configPath, k, "required");
    return v as NonNullable<FileConfig[K]>;
  };

  // dataDir
  const dataDirRaw = expandHome(required("dataDir"), home);
  if (!isAbsolute(dataDirRaw)) throw new ConfigError(configPath, "dataDir", "must be an absolute path");
  const dataDir = resolve(dataDirRaw);
  ensureDataDir(dataDir, configPath);

  // shell
  const shell = m.shell ?? env.SHELL;
  if (!shell) throw new ConfigError(configPath, "shell", "not set in config and env SHELL is empty");
  if (!isAbsolute(shell)) throw new ConfigError(configPath, "shell", "must be an absolute path");

  const tunables: EngineTunables = {
    flushIntervalMs: required("flushIntervalMs"),
    killGraceMs: required("killGraceMs"),
    slugMaxLen: required("slugMaxLen"),
    slugFallback: required("slugFallback"),
    gitCloneTimeoutMs: required("gitCloneTimeoutMs"),
    builtinProjectId: required("builtinProjectId"),
    builtinProjectName: required("builtinProjectName"),
    sshBinary: required("sshBinary"),
    activity: {
      windowMs: required("activityWindowMs"),
      debounceMs: required("activityDebounceMs"),
      scanLines: required("activityScanLines"),
      summaryMaxLen: required("activitySummaryMaxLen"),
      tailChars: required("activityTailChars"),
    },
    bgAgents: {
      claudeBinary: required("claudeBinary"),
      pollMs: required("bgAgentsPollMs"),
      idlePollMaxMs: required("bgAgentsIdlePollMaxMs"),
      timeoutMs: required("bgAgentsTimeoutMs"),
      maxOutputBytes: required("bgAgentsMaxOutputBytes"),
      logsMaxChars: required("bgAgentsLogsMaxChars"),
    },
    ...(m.terminalZdotdir !== undefined ? { terminalZdotdir: m.terminalZdotdir } : {}),
  };

  // projects
  const seen = new Set<string>();
  const projects = required("projects").map((p, i): Project => {
    const id = p.id ?? slugify(p.name, tunables.slugMaxLen, tunables.slugFallback);
    if (seen.has(id)) throw new ConfigError(configPath, `projects.${i}.id`, `duplicate project id "${id}"`);
    seen.add(id);
    const repoPath = expandHome(p.repoPath, home);
    if (!isAbsolute(repoPath)) throw new ConfigError(configPath, `projects.${i}.repoPath`, "must be an absolute path");
    const abs = resolve(repoPath);
    if (!existsSync(abs)) logger.warn("project repo not found", { projectId: id, repoPath: abs });
    return { id, name: p.name, location: { kind: "local", path: abs } };
  });

  const key = m.key ?? loadOrCreateKey(dataDir, configPath, logger);

  const browser = parseBrowser({ ...defaults.browser, ...user.browser, ...browserEnvOverrides(env) }, configPath);
  return {
    configPath,
    language: required("language"),
    port: required("port"),
    dataDir,
    bufferBytes: required("bufferBytes"),
    shell,
    shellArgs: required("shellArgs"),
    branchPrefix: required("branchPrefix"),
    baseBranch: m.baseBranch ?? null,
    authTimeoutMs: required("authTimeoutMs"),
    authNonceMemory: required("authNonceMemory"),
    tailscaleRescanMs: required("tailscaleRescanMs"),
    wsPingIntervalMs: required("wsPingIntervalMs"),
    listenLocalhost: required("listenLocalhost"),
    listenTailscale: required("listenTailscale"),
    tailscaleCidrs: required("tailscaleCidrs"),
    key,
    projects,
    tunables,
    map: m.map ?? {},
    files: m.files ?? {},
    flow: m.flow ?? {}, // İş W
    claudeInventory: m.claudeInventory ?? {},
    appUpdates: m.appUpdates ?? {}, // Kendini güncelleme
    claudeUsage: m.claudeUsage ?? {},
    browser,
    logins: parseLogins({ ...defaults.logins, ...user.logins }, configPath), // Girişler
    claudeAccounts: parseClaudeAccounts({ ...defaults.claudeAccounts, ...user.claudeAccounts }, configPath), // İş H
  };
}

/** İş H: the merged claudeAccounts block must be complete and valid. */
function parseClaudeAccounts(raw: unknown, configPath: string): ClaudeAccountsTunables {
  const r = ClaudeAccountsConfigSchema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ConfigError(configPath, `claudeAccounts.${issue?.path.map(String).join(".") ?? ""}`, issue?.message ?? "invalid");
}

/** Girişler: the merged logins block must be complete and valid. */
function parseLogins(raw: unknown, configPath: string): LoginsConfig {
  const r = LoginsConfigSchema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ConfigError(configPath, `logins.${issue?.path.map(String).join(".") ?? ""}`, issue?.message ?? "invalid");
}


/** Adım 9 İş T: env beats the file for the Playwright MCP output parent dir (an empty value is ignored). */
function browserEnvOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const parent = env.KOKPIT_PLAYWRIGHT_MCP_OUTPUT_PARENT_DIR;
  return parent ? { playwrightMcpOutputParentDir: parent } : {};
}


/** İş B: the merged browser block must be complete and valid. */
function parseBrowser(raw: unknown, configPath: string): BrowserConfig {
  const r = BrowserConfigSchema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ConfigError(configPath, `browser.${issue?.path.map(String).join(".") ?? ""}`, issue?.message ?? "invalid");
}

function mkdirIfMissing(dir: string): void {
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

/**
 * Paths under dataDir; creates the buffers, worktrees and repos directories.
 * Non-recursive on purpose: if the external disk vanished, this throws instead
 * of recreating the tree on the internal disk.
 */
export function dataPaths(c: EngineConfig): DataPaths {
  const paths: DataPaths = {
    stateFile: join(c.dataDir, "state.json"),
    buffersDir: join(c.dataDir, "buffers"),
    worktreesDir: join(c.dataDir, "worktrees"),
    reposDir: join(c.dataDir, "repos"),
  };
  mkdirIfMissing(paths.buffersDir);
  mkdirIfMissing(paths.worktreesDir);
  mkdirIfMissing(paths.reposDir);
  return paths;
}
