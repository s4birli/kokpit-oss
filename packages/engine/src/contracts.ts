// Module boundaries inside the engine. Each module implements one interface
// here and depends on the others only through these interfaces, so they can be
// built and tested in isolation (with fakes) and wired together in main.ts.
import { st, type Params, type SharedKey } from "@kokpit/shared/i18n";
import type { Card, ClaudeAccount, ErrorCode, ParamsOf, Project, SavedLogin, Settings, SshHost, TerminalInfo, Todo, Tool, ToolStatus } from "@kokpit/shared";

/** Fully resolved engine configuration. Nothing in the engine reads env or files except config.ts. */
export interface EngineConfig {
  /** Absolute path of the config file this was loaded from (or would be written to). */
  configPath: string;
  /** TCP port the engine listens on, on every allowed address. 0 = ephemeral (tests). */
  port: number;
  /** Root of everything the engine writes: state, buffers, worktrees. Lives on the external SSD. */
  dataDir: string;
  /** Max bytes of terminal history kept per terminal (ring buffer, also persisted). */
  bufferBytes: number;
  /** Shell executable for new terminals, and its args (e.g. ["-l"]). */
  shell: string;
  shellArgs: string[];
  /** Prefix for card branches, e.g. "kokpit/". */
  branchPrefix: string;
  /** Branch new cards start from. null = the repo's default branch (origin/HEAD, else current HEAD). */
  baseBranch: string | null;
  /** Close an unauthenticated connection after this long without a valid hello. */
  authTimeoutMs: number;
  /**
   * Client nonces of the last this-many handshakes are remembered, and a repeated one is refused (a replayed
   * handshake). Absent = only the per-connection fresh engine nonce protects against replay.
   */
  authNonceMemory?: number;
  /** How often to re-scan network interfaces for Tailscale addresses. */
  tailscaleRescanMs: number;
  /**
   * Performans: every client is pinged this often; one that answered no ping since the previous round (a MacBook
   * that slept, a dropped route) is dropped, and with it its screen / browser streams and the background-agent
   * polling it kept alive. Absent or 0 = no pings (a half-open connection then lives until TCP gives up).
   */
  wsPingIntervalMs?: number;
  /** Listen on loopback (127.0.0.1, ::1). */
  listenLocalhost: boolean;
  /** Listen on Tailscale interface addresses. */
  listenTailscale: boolean;
  /** CIDRs that identify Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48). */
  tailscaleCidrs: string[];
  /** Access key every client must present. Never logged. */
  key: string;
  projects: Project[];
}

/** Paths derived from EngineConfig.dataDir. */
export interface DataPaths {
  stateFile: string;
  buffersDir: string;
  worktreesDir: string;
  /** Clones of github projects: `<reposDir>/<projectId>`. */
  reposDir: string;
}

/** Machine paths the engine needs besides its data dir (resolved once from env/os in config.ts). */
export interface HostPaths {
  /** User's home dir; location of the built-in "Mac mini" project. */
  homeDir: string;
  /** ~/.ssh — the only place identity files may come from. */
  sshDir: string;
  /** ~/.ssh/config — read-only source of ssh host aliases. */
  sshConfigFile: string;
}

/** i18n: the catalog key (`engine.*`, `validation.*` of @kokpit/shared/i18n) and params of an error's text. */
export interface ErrorText {
  key: string;
  params?: Params;
}

export class EngineError extends Error {
  readonly code: ErrorCode;
  /** i18n: when set, the app shows the key's text in its own language; `message` is for apps without keys. */
  readonly text?: ErrorText;
  constructor(code: ErrorCode, message: string, text?: ErrorText) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    if (text) this.text = text;
  }
}

/**
 * i18n: an error whose text comes from the shared catalog — `message` in the engine's language (config `language`),
 * key + params for the app to translate.
 */
export function engineError(code: ErrorCode, key: SharedKey, params?: Params): EngineError {
  return new EngineError(code, st(key, params), { key, ...(params ? { params } : {}) });
}

/**
 * Durable record of projects, ssh hosts (source "kokpit" only), tools, cards and terminals.
 * Every mutation is persisted atomically (write temp file + rename) before the method returns,
 * so a reboot never loses a record that was acknowledged to a client.
 * File format v2; a v1 file (cards + terminals only, terminals without projectId) is migrated.
 */
export interface StateStore {
  listProjects(): Project[];
  getProject(projectId: string): Project | undefined;
  upsertProject(project: Project): void;
  removeProject(projectId: string): void;

  /** Only hosts the user created in Kokpit; ~/.ssh/config aliases are never stored. */
  listSshHosts(): SshHost[];
  getSshHost(hostId: string): SshHost | undefined;
  upsertSshHost(host: SshHost): void;
  removeSshHost(hostId: string): void;

  listTools(): Tool[];
  getTool(toolId: string): Tool | undefined;
  upsertTool(tool: Tool): void;
  removeTool(toolId: string): void;

  listCards(projectId?: string): Card[];
  getCard(cardId: string): Card | undefined;
  addCard(card: Card): void;
  removeCard(cardId: string): void;

  listTerminals(filter?: { cardId?: string; projectId?: string }): TerminalInfo[];
  getTerminal(terminalId: string): TerminalInfo | undefined;
  upsertTerminal(terminal: TerminalInfo): void;
  removeTerminal(terminalId: string): void;

  /** Stored settings; `defaultToolId: null` = the user chose "plain shell", absent = never set. */
  getSettings(): StoredSettings;
  /** Merges the given fields into the settings. */
  updateSettings(patch: StoredSettings): void;

  /** True once seed data (config projects, default tools, built-in project) has been applied. */
  isSeeded(key: string): boolean;
  markSeeded(key: string): void;
}

/** Settings as stored. Differs from the wire `Settings` in that null (explicit "no tool") is kept. */
export interface StoredSettings {
  defaultToolId?: string | null;
  /** İş H: Claude accounts (see claude-accounts.ts); absent until the default one is seeded. */
  claudeAccounts?: ClaudeAccount[];
}

export interface ProjectService {
  /** Seeds once: built-in "Mac mini" project (HostPaths.homeDir) and EngineConfig.projects as local projects. */
  init(): Promise<void>;
  list(): Project[];
  get(projectId: string): Project | undefined;
  /**
   * local: path must be an existing directory. github: clones into DataPaths.reposDir/<id> (GIT_FAILED on error,
   * nothing stored). ssh: hostId must exist in SshHostService. defaultToolId must exist. Throws EngineError.
   */
  create(input: ParamsOf<"projects.create">): Promise<Project>;
  update(input: ParamsOf<"projects.update">): Project;
  /** Refuses (INVALID) for the built-in project or when the project still has cards. Never touches files. */
  delete(projectId: string): void;
}

export interface SshHostService {
  /** ~/.ssh/config aliases (source "ssh-config", id = alias, read-only) + Kokpit hosts. */
  list(): SshHost[];
  get(hostId: string): SshHost | undefined;
  create(input: ParamsOf<"sshHosts.create">): SshHost;
  update(input: ParamsOf<"sshHosts.update">): SshHost;
  /** Refuses (INVALID) for ssh-config hosts and for hosts used by a project. */
  delete(hostId: string): void;
  /** Private key FILE NAMES in HostPaths.sshDir that have a matching `.pub`. Never reads key contents. */
  listKeys(): string[];
}

export interface ToolService {
  /** Seeds default tools once from tools.defaults.json. */
  init(): void;
  list(): Tool[];
  get(toolId: string): Tool | undefined;
  create(input: ParamsOf<"tools.create">): Tool;
  update(input: ParamsOf<"tools.update">): Tool;
  /** Refuses (INVALID) when a project uses it as default. */
  delete(toolId: string): void;
  /** Runs each checkCommand in config.shell with a timeout; null when no checkCommand. */
  check(): Promise<ToolStatus[]>;
}

export interface SettingsService {
  /** Seeds once: the initial global default tool (tools.defaults.json), unless the user already chose. */
  init(): void;
  /** Wire settings: `defaultToolId` only when set and the tool still exists; `screen` while it is on or a keep-alive is stored. */
  get(): Settings;
  /** `defaultToolId`: null = plain shell, a tool id must exist (NOT_FOUND). */
  update(input: ParamsOf<"settings.update">): Settings;
}

/** Exactly how a terminal process starts. Built by `resolveLaunch` (launch.ts), consumed by PtyManager. */
export interface LaunchSpec {
  file: string;
  args: string[];
  /** Local working directory (for ssh: the user's home, the remote dir is in args). */
  cwd: string;
  /** Typed into the terminal right after start (tool command + "\r"), if any. */
  initialInput?: string;
  title: string;
  /** Extra environment for the process (e.g. KOKPIT_CDP_URL, İş B). Never overrides Kokpit's own variables. */
  env?: Record<string, string>;
  /**
   * Adım 9 İş K: releases what the launch prepared for this one terminal (a temp file, a credential). PtyManager
   * calls it exactly once: when the process exits, when the terminal is closed, or when it could not be started.
   */
  onExit?: () => void;
}

export interface CardService {
  list(projectId: string): Card[];
  /** Creates branch `${branchPrefix}${slug}` + worktree under DataPaths.worktreesDir. Throws EngineError. */
  create(projectId: string, name: string): Promise<Card>;
  /**
   * Refuses with EngineError("DIRTY_WORKTREE", <reason listing files>) when the worktree has
   * uncommitted changes, untracked files included. Otherwise runs the onBeforeRemove hook
   * (closes the card's terminals), removes the worktree, keeps the branch, drops the record.
   */
  delete(cardId: string): Promise<void>;
}

export interface TerminalListener {
  onData(data: string): void;
  onExit(exitCode: number | null): void;
}

export interface PtyManager {
  /** Spawns `launch.file launch.args` in `launch.cwd`, then types `launch.initialInput` if set. */
  open(
    target: { projectId: string; cardId?: string; toolId?: string },
    launch: LaunchSpec,
    opts: { cols: number; rows: number },
  ): TerminalInfo;
  list(filter: { cardId?: string; projectId?: string }): TerminalInfo[];
  get(terminalId: string): TerminalInfo | undefined;
  /**
   * Yollar: the process id of a running terminal's shell (its current directory is where relative paths it printed
   * are looked for); undefined when it is not running. Optional: managers without processes (tests) leave it out.
   */
  pid?(terminalId: string): number | undefined;
  /** Buffered history (at most config.bufferBytes), including for exited terminals restored from disk. */
  history(terminalId: string): string;
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  /** Kills the process (if running) and forgets the terminal, including its buffer file. */
  close(terminalId: string): void;
  closeAllForCard(cardId: string): void;
  /** Closes every terminal of the project (card terminals included). Used when a project is deleted. */
  closeAllForProject(projectId: string): void;
  /** Live output after this call; returns unsubscribe. */
  subscribe(terminalId: string, listener: TerminalListener): () => void;
  /** Flush buffers to disk; terminals keep running only if the process survives (it won't on reboot). */
  shutdown(): Promise<void>;
}

// ---- tarayıcı (İş B) ----

/** Unpacked-extension folders of each project's browser, kept in the v2 state file (absent = none). */
export interface BrowserExtensionStore {
  getBrowserExtensions(projectId: string): string[];
  /** Replaces the project's list; an empty list removes the project's entry. */
  setBrowserExtensions(projectId: string, dirs: string[]): void;
}

/** Adım 9 İş A: each project's DevTools port, allocated once and kept across restarts (absent = none yet). */
export interface BrowserPortStore {
  getBrowserPort(projectId: string): number | undefined;
  listBrowserPorts(): Record<string, number>;
  /** `undefined` forgets the project's port. */
  setBrowserPort(projectId: string, port: number | undefined): void;
}

/**
 * The page zoom of each project's browser: one value for every app that shows it, owned by the engine.
 * `undefined` = nobody ever chose one (the configured default applies, and an app may hand over the zoom it used
 * to keep itself); `null` = the user chose the configured default; a number = the user's zoom.
 */
export interface BrowserZoomStore {
  getBrowserZoom(projectId: string): number | null | undefined;
  /** `undefined` forgets the project's entry (the project is gone). */
  setBrowserZoom(projectId: string, zoom: number | null | undefined): void;
}


// ---- girişler ----
/** One Keychain item (see keychain.ts). */
export interface KeychainItemRef {
  service: string;
  account: string;
}

/** Metadata of the saved logins. The password is never part of it: it lives in the Keychain. */
export interface LoginStore {
  /** In the order they were first saved; all projects when `projectId` is absent. */
  listLogins(projectId?: string): SavedLogin[];
  getLogin(id: string): SavedLogin | undefined;
  upsertLogin(login: SavedLogin): void;
  removeLogin(id: string): void;
  /** Keychain items whose login is gone but which could not be deleted yet (retried later). */
  listLoginOrphans(): KeychainItemRef[];
  setLoginOrphans(orphans: KeychainItemRef[]): void;
  /** The user accepted for this project that agents on the same browser can read a filled password. */
  isLoginRiskAccepted(projectId: string): boolean;
  setLoginRiskAccepted(projectId: string, accepted: boolean): void;
}

/** What the engine wrote into one project's Claude settings file — the only keys it may later change or remove. */
export interface ManagedClaudeSettings {
  /** Real path of the settings file. */
  file: string;
  /** `env` entries as written. */
  env: Record<string, string>;
  /** The engine created the file (it may delete it again once nothing else is in it). */
  createdFile?: boolean;
  /** The engine created the file's folder. */
  createdDir?: boolean;
}

export interface ClaudeSettingsStore {
  getManagedClaudeSettings(projectId: string): ManagedClaudeSettings | undefined;
  listManagedClaudeSettings(): Record<string, ManagedClaudeSettings>;
  /** `undefined` forgets the project's record. */
  setManagedClaudeSettings(projectId: string, record: ManagedClaudeSettings | undefined): void;
}

// ---- todos ----

/** Todos and day notes, kept in the same v2 state file (absent fields read as empty). */
export interface TodoStore {
  listTodos(): Todo[];
  /** Replaces the whole list in one atomic write (rollover and reordering touch many records). */
  replaceTodos(todos: Todo[]): void;
  /** date (YYYY-MM-DD) → note text. */
  getNotes(): Record<string, string>;
  /** Empty text removes the day's note. */
  setNote(date: string, text: string): void;
}

/** Yapılacaklar: per-day todo lists in the engine's local time zone, with rollover. Throws EngineError. */
export interface TodoService {
  /** Today's date key on the engine machine. */
  today(): string;
  /** Moves unfinished todos of earlier days to today (first on the list). True when anything moved. */
  rollover(): boolean;
  /** Rolls unfinished todos of earlier days over to today, then lists the day (default today) by order. */
  list(date?: string): { date: string; todos: Todo[] };
  create(input: ParamsOf<"todos.create">): Todo;
  update(input: ParamsOf<"todos.update">): Todo;
  delete(id: string): void;
  getNote(date?: string): { date: string; text: string };
  setNote(input: ParamsOf<"notes.set">): { date: string; text: string };
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  /** Detail nobody needs day to day. Absent = dropped (the engine's logger writes it only when asked to). */
  debug?(msg: string, extra?: Record<string, unknown>): void;
}
