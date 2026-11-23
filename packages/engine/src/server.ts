// HTTP + WebSocket front of the engine. Binds only the addresses net.ts selects
// (loopback + Tailscale, never a wildcard), authenticates every connection with
// the access key, and routes protocol requests to the engine services.
import http from "node:http";
import os from "node:os";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  CLOSE_CODES,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseClientMessage,
  splitOutputData,
  toolAllowedForProject,
  type BuildInfo,
  type Card,
  type ClientMessage,
  type Method,
  type ParamsOf,
  type Project,
  type RequestMessage,
  type ResultOf,
  type ServerMessage,
  type SshHost,
  type TerminalInfo,
  type Tool,
} from "@kokpit/shared";
import type { ActivityTracker } from "./activity.ts";
import {
  AUTH_LABELS,
  authProof,
  BUILD_FEATURES,
  type FeatureSet,
  keySecret,
  newNonce,
  proofMatches,
  type BuildInfo as AuthBuildInfo,
} from "@kokpit/shared";
import {
  EngineError,
  engineError,
  type CardService,
  type EngineConfig,
  type LaunchSpec,
  type Logger,
  type ProjectService,
  type PtyManager,
  type SettingsService,
  type SshHostService,
  type StateStore,
  type TodoService,
  type ToolService,
} from "./contracts.ts";
import { st, type Params, type SharedKey } from "@kokpit/shared/i18n";
import { todoHandlers } from "./handlers/todos.ts";
import { agentsHandlers } from "./handlers/agents.ts";
import { bgAgentsHandlers } from "./handlers/bgagents.ts";
import type { BgAgentsService } from "./bg-agents.ts";
import type { ClaudeAccountService } from "./claude-accounts.ts";
import { claudeAccountHandlers } from "./handlers/claude-accounts.ts";
import { claudeUsageHandlers } from "./handlers/claude-usage.ts";
import { isLoopbackAddress, localClientAddress, selectListenAddresses } from "./net.ts";
import { createMapHandlers } from "./handlers/map.ts";
import type { MapService } from "./map.ts";
import type { BrowserManager } from "./browser.ts";
import { createBrowserHandlers } from "./handlers/browser.ts";
import type { FileService } from "./files.ts";
import { createFilesHandlers } from "./handlers/files.ts";
import type { MediaService } from "./files-media.ts";
import type { PreviewService } from "./files-preview.ts"; // Yollar
import type { CwdLookup, PathLocator } from "./local-paths.ts"; // Yollar
import { OpenDeclinedError, type TerminalOpenService } from "./terminal-open.ts"; // Yollar
import { createPathActions } from "./handlers/paths.ts"; // Yollar
import type { FlowService } from "./flow.ts"; // İş W
import { createFlowHandlers } from "./handlers/flow.ts"; // İş W
import type { ClaudeInventoryService } from "./claude-inventory.ts";
import type { ClaudeUsageService } from "./claude-usage.ts";
import { createClaudeHandlers } from "./handlers/claude.ts";
import { createLoginHandlers } from "./handlers/logins.ts"; // Girişler
import type { LoginService } from "./logins.ts";
import type { AppUpdateService } from "./app-updates.ts"; // Kendini güncelleme
import { createAppUpdateHandlers } from "./handlers/app-update.ts"; // Kendini güncelleme

/**
 * Everything resolveLaunch needs, already looked up and validated by the server:
 * `card` for card terminals, `host` for ssh projects. At most one of `tool` / `command`
 * is set (an explicit command wins over any tool, so `tool` is then left out).
 */
export interface LaunchInput {
  project: Project;
  card?: Card;
  host?: SshHost;
  tool?: Tool;
  command?: string;
  /** İş H: Claude account for this terminal instead of the project's (login, attach of another account's agent). */
  claudeAccountId?: string;
}

export interface EngineServerDeps {
  config: EngineConfig;
  store: StateStore;
  projects: ProjectService;
  sshHosts: SshHostService;
  tools: ToolService;
  settings: SettingsService;
  cards: CardService;
  ptys: PtyManager;
  logger: Logger;
  version: string;
  resolveLaunch: (input: LaunchInput) => LaunchSpec;
  /** Project that tools.install terminals open in (the built-in "Mac mini" project). */
  builtinProjectId: string;
  getInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** İş C — Harita: graphify maps (map.* requests + the token HTTP route). Absent = disabled. */
  map?: MapService;
  /** Yapılacaklar (todos.*, notes.*); optional so fakes without it still build a server. */
  todos?: TodoService;
  /** İş A: activity tracker feeding `ptys` (see activity.ts `withActivity`). */
  activity?: ActivityTracker;
  /** İş B: per-project Chrome. Absent = browser requests answer INVALID. */
  browsers?: BrowserManager;
  /** Programs whose terminals start the project's browser (like a tool with `opensBrowser`). Absent = none. */
  browserStartCommands?: readonly string[];
  /** İş F — Dosyalar: read-only folder browsing (files.*). Absent = requests answer INVALID. */
  files?: FileService;
  /** Dosyalar — medya: one file streamed over HTTP for a token (files.mediaUrl + the token route). Absent = INVALID. */
  media?: MediaService;
  /**
   * Yollar: paths a terminal printed — what they point at, and local pages served for a project's browser
   * (files.locate, files.previewUrl, browser.openFile + the preview route). Absent = those requests answer INVALID.
   */
  paths?: { locator: PathLocator; preview: PreviewService; cwd: CwdLookup };
  /** Yollar: `open` run inside a Kokpit terminal (the shim's route). Absent = no such route. */
  terminalOpen?: TerminalOpenService;
  /** İş W — Akış: Mermaid flow files of a project (flow.*). Absent = unavailable / INVALID. */
  flow?: FlowService;
  /** İş C (Adım 8): Claude envanteri (claude.inventory*). Absent = requests answer INVALID. */
  claudeInventory?: ClaudeInventoryService;
  /** İş A (Adım 7): background Claude sessions; polled while clients are connected. Absent = empty list. */
  bgAgents?: BgAgentsService;
  /** Girişler: saved logins of a project's browser (logins.*). Absent = empty list, actions INVALID. */
  logins?: LoginService;
  /** İş H: Claude accounts (claudeAccounts.*). Absent = empty list, actions INVALID. */
  claudeAccounts?: { service: ClaudeAccountService; loginCommand: string };
  /**
   * Kendini güncelleme: this engine's build identity, sent with `hello.ok` and `app.update.check`. Absent (tests,
   * fakes) = a placeholder made from `version`.
   */
  build?: BuildInfo;
  /** Tests only: replaces the handshake's HMAC steps (e.g. to hold a handshake between its checks). */
  handshakeCrypto?: { proofMatches?: typeof proofMatches; authProof?: typeof authProof };
  /** Kendini güncelleme: published app builds (app.update.* + the token HTTP route). Absent = nothing is published. */
  appUpdates?: AppUpdateService;
  /** Claude kullanımı (claudeUsage.*). Absent = requests answer INVALID. */
  claudeUsage?: ClaudeUsageService;
  /**
   * Optional feature modules (kokpit.features.json, narrowed by KOKPIT_FEATURES). A request or frame owned by a feature
   * that is off answers UNKNOWN_METHOD / is dropped, exactly as if the module were not built in. Absent = the build's set.
   */
  features?: FeatureSet;
}

export interface EngineServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  addresses(): { host: string; port: number }[];
}

/** MAX_MESSAGE_BYTES counts UTF-16 code units; a UTF-8 frame can be up to ~4 bytes per unit. */
const WS_MAX_PAYLOAD = MAX_MESSAGE_BYTES * 4;
const INTERNAL_MESSAGE = "internal error";

interface Listener {
  host: string;
  port: number;
  http: http.Server;
  wss: WebSocketServer;
}

/** Where a connection stands in the mutual handshake (@kokpit/shared auth.ts). */
type AuthStage =
  | { stage: "hello" }
  | { stage: "proof"; clientNonce: string; serverNonce: string; secret: Uint8Array; grant: { id: string; projectId: string } | undefined }
  /** The client's proof is being checked (async); any frame now is out of order. */
  | { stage: "checking" };

interface Conn {
  ws: WebSocket;
  remote: string;
  authed: boolean;
  auth: AuthStage;
  closed: boolean;
  authTimer: NodeJS.Timeout | undefined;
  /** Performans: answered the last ping (or has not been pinged yet). See `wsPingIntervalMs`. */
  alive: boolean;
  /** terminalId → unsubscribe */
  subs: Map<string, () => void>;
  /**
   * Adım 9 İş K: set when the connection authenticated with a screen grant instead of the access key. It then acts
   * for that one project only and may send nothing but requests for SCREEN_MCP_METHODS; it gets no broadcasts and
   * does not count as an app client. Absent = the app (access key): unrestricted.
   */
  scope?: { grantId: string; projectId: string };
}

const SCOPED_METHODS: readonly string[] = [];
/** i18n: an error's text for a `res` built here: `message` in the engine's language, key + params for the app. */
const errorText = (key: SharedKey, params?: Params): { message: string; key: string; params?: Params } => ({ message: st(key, params), key, ...(params ? { params } : {}) });

/** Per-request context. `after` queues work to run once this request's `res` has been sent. */
interface Ctx {
  conn: Conn;
  after(fn: () => void): void;
}

type Handler<M extends Method> = (ctx: Ctx, params: ParamsOf<M>) => Promise<ResultOf<M>> | ResultOf<M>;

export function createEngineServer(deps: EngineServerDeps): EngineServer {
  const { config, store, projects, sshHosts, tools, settings, cards, ptys, logger, version, resolveLaunch } = deps;
  const getInterfaces = deps.getInterfaces ?? (() => os.networkInterfaces());
  const build: BuildInfo = deps.build ?? { buildId: `${version}-unbuilt`, version, commit: "unknown", builtAt: new Date(0).toISOString() };
  const features = deps.features ?? BUILD_FEATURES;

  const listeners = new Map<string, Listener>();
  const conns = new Set<Conn>();
  /** One server-level subscription per running terminal, to broadcast terminals.changed once on exit. */
  const exitWatchers = new Map<string, () => void>();
  let port = config.port;
  let rescanTimer: NodeJS.Timeout | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  let rescanning = false;
  let stopped = false;

  // ---------- sending ----------

  /**
   * The only way a frame leaves the engine. Nothing over MAX_MESSAGE_BYTES is ever written: the receiver would drop
   * it unread. Terminal data is split before it gets here (sendOutput); anything else that large is a bug in what
   * produced it, so it is logged, and a `res` is replaced by an error so the request does not hang until its timeout.
   */
  function send(conn: Conn, msg: ServerMessage, method?: Method): void {
    if (conn.closed || conn.ws.readyState !== conn.ws.OPEN) return;
    const raw = JSON.stringify(msg);
    if (raw.length <= MAX_MESSAGE_BYTES) {
      conn.ws.send(raw);
      return;
    }
    logger.error("frame too large, not sent", {
      remote: conn.remote,
      type: msg.type,
      ...(msg.type === "event" ? { name: msg.name } : {}),
      ...(method !== undefined ? { method } : {}),
      size: raw.length,
      limit: MAX_MESSAGE_BYTES,
    });
    if (msg.type === "res") {
      conn.ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: { code: "INTERNAL", ...errorText("engine.server.tooLarge") } } satisfies ServerMessage));
    }
  }

  /**
   * Terminal data as `output` frames, each inside the frame limit whatever the data holds (see splitOutputData).
   * A replay is numbered so the receiver clears the terminal once, at part 0, and can tell a missing part.
   */
  function sendOutput(conn: Conn, terminalId: string, data: string, replay: boolean): void {
    const pieces = splitOutputData(data);
    for (const [index, piece] of pieces.entries()) {
      send(conn, { type: "output", terminalId, data: piece, ...(replay ? { replay: true, part: { index, total: pieces.length } } : {}) });
    }
  }

  function broadcast(msg: ServerMessage): void {
    for (const c of conns) if (c.authed && !c.scope) send(c, msg);
  }

  /** İş A (Adım 7): background-agent polling runs only while someone is connected. */
  function clientsChanged(): void {
    let n = 0;
    for (const c of conns) if (c.authed && !c.scope) n++;
    deps.bgAgents?.setClientCount(n);
  }

  function closeConn(conn: Conn, code: number, reason: string): void {
    if (conn.closed) return;
    conn.closed = true;
    cleanupConn(conn);
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
  }

  function cleanupConn(conn: Conn): void {
    if (conn.authTimer) clearTimeout(conn.authTimer);
    conn.authTimer = undefined;
    for (const unsub of conn.subs.values()) unsub();
    conn.subs.clear();
    browser.dropConn(conn);
    // Media URLs belong to the connection that asked for them.
    deps.media?.revokeOwner(conn);
    deps.appUpdates?.revokeOwner(conn);
    conns.delete(conn);
    clientsChanged();
  }

  // ---------- terminal plumbing ----------

  function terminalsChanged(t: { projectId: string; cardId?: string | undefined }): ServerMessage {
    return {
      type: "event",
      name: "terminals.changed",
      projectId: t.projectId,
      ...(t.cardId !== undefined ? { cardId: t.cardId } : {}),
    };
  }

  function watchExit(info: TerminalInfo): void {
    const terminalId = info.id;
    if (exitWatchers.has(terminalId)) return;
    const event = terminalsChanged(info);
    const unsub = ptys.subscribe(terminalId, {
      onData: () => {},
      onExit: () => {
        exitWatchers.get(terminalId)?.();
        exitWatchers.delete(terminalId);
        // After the per-connection exit frames for the same event.
        queueMicrotask(() => broadcast(event));
      },
    });
    exitWatchers.set(terminalId, unsub);
  }

  /** Forget every server-side subscription to terminals that are gone (or about to be). */
  function forgetTerminals(terminalIds: string[]): void {
    for (const tid of terminalIds) {
      unwatchExit(tid);
      dropAllSubs(tid);
    }
  }

  function unwatchExit(terminalId: string): void {
    exitWatchers.get(terminalId)?.();
    exitWatchers.delete(terminalId);
  }

  /** Drop every connection's subscription to a terminal that no longer exists. */
  function dropAllSubs(terminalId: string): void {
    for (const c of conns) {
      c.subs.get(terminalId)?.();
      c.subs.delete(terminalId);
    }
  }

  /** Replay + live subscribe, synchronously in one tick so no output is lost or duplicated. */
  function attach(conn: Conn, terminalId: string): void {
    conn.subs.get(terminalId)?.();
    conn.subs.delete(terminalId);
    const info = ptys.get(terminalId);
    if (!info) return;
    sendOutput(conn, terminalId, ptys.history(terminalId), true);
    if (info.status === "exited") {
      send(conn, { type: "exit", terminalId, exitCode: info.exitCode ?? null });
      return;
    }
    const unsub = ptys.subscribe(terminalId, {
      onData: (data) => sendOutput(conn, terminalId, data, false),
      onExit: (exitCode) => {
        conn.subs.get(terminalId)?.();
        conn.subs.delete(terminalId);
        send(conn, { type: "exit", terminalId, exitCode });
      },
    });
    conn.subs.set(terminalId, unsub);
    watchExit(info);
  }

  function requireProject(projectId: string): Project {
    const project = projects.get(projectId);
    if (!project) throw new EngineError("NOT_FOUND", `project ${projectId} not found`);
    return project;
  }

  function requireCard(cardId: string): Card {
    const card = store.getCard(cardId);
    if (!card) throw new EngineError("NOT_FOUND", `card ${cardId} not found`);
    return card;
  }

  function requireTool(toolId: string): Tool {
    const tool = tools.get(toolId);
    if (!tool) throw new EngineError("NOT_FOUND", `tool ${toolId} not found`);
    return tool;
  }

  function hostFor(project: Project): SshHost | undefined {
    if (project.location.kind !== "ssh") return undefined;
    const host = sshHosts.get(project.location.hostId);
    if (!host) throw new EngineError("NOT_FOUND", `ssh host ${project.location.hostId} not found`);
    return host;
  }

  /** A default tool that may have been deleted meanwhile; missing → undefined (with a warning). */
  function defaultTool(toolId: string | undefined, scope: Record<string, unknown>): Tool | undefined {
    if (toolId === undefined) return undefined;
    const tool = tools.get(toolId);
    if (!tool) logger.warn("default tool missing, skipping it", { ...scope, toolId });
    return tool;
  }

  /**
   * Explicit command > explicit toolId > project's default tool > global default tool > plain shell.
   * `toolId: null` = plain shell on purpose (no default applies).
   */
  function pickStart(
    project: Project,
    toolId: string | null | undefined,
    command: string | undefined,
  ): { tool?: Tool; command?: string } {
    if (command !== undefined) return { command };
    if (toolId === null) return {};
    if (toolId !== undefined) {
      const tool = requireTool(toolId);
      return { tool };
    }
    // A default the project does not allow is skipped like a deleted one: the terminal still opens.
    const allowed = (tool: Tool | undefined): Tool | undefined => (tool && toolAllowedForProject(tool, project) ? tool : undefined);
    const tool =
      allowed(defaultTool(project.defaultToolId, { projectId: project.id })) ??
      allowed(defaultTool(settings.get().defaultToolId, { scope: "settings" }));
    return tool ? { tool } : {};
  }

  /** Spawn, then (after the res) attach the requesting connection and tell everyone. */
  function openTerminal(
    ctx: Ctx,
    input: LaunchInput,
    size: { cols: number; rows: number },
  ): { terminal: TerminalInfo } {
    const launch = resolveLaunch(input);
    const target = {
      projectId: input.project.id,
      ...(input.card ? { cardId: input.card.id } : {}),
      ...(input.tool ? { toolId: input.tool.id } : {}),
    };
    const terminal = ptys.open(target, launch, size);
    ctx.after(() => {
      attach(ctx.conn, terminal.id);
      broadcast(terminalsChanged(terminal));
    });
    return { terminal };
  }

  function changed(name: "projects.changed" | "sshHosts.changed" | "tools.changed" | "settings.changed"): void {
    broadcast({ type: "event", name });
  }

  function requireTerminal(terminalId: string) {
    const info = ptys.get(terminalId);
    if (!info) throw new EngineError("NOT_FOUND", `terminal ${terminalId} not found`);
    return info;
  }

  // ---------- request handlers ----------

  // Yollar: a path a terminal printed, resolved here; a local page gets an address of this very listener.
  const pathActions = deps.paths
    ? createPathActions({
        ...deps.paths,
        requireProject,
        requireCard,
        terminal: (id) => ptys.get(id),
        terminalPid: (id) => ptys.pid?.(id),
        localAddress: () => localClientAddress([...listeners.values()]),
      })
    : undefined;
  const browser = createBrowserHandlers({
    browsers: deps.browsers,
    requireProject,
    send,
    broadcast,
    logger,
    startCommands: deps.browserStartCommands ?? [],
    fileUrl: pathActions ? (ref) => pathActions.engineUrl(ref) : undefined,
  });
  /**
   * Yollar: what `open` in a terminal may do — show an address or a local page in THAT terminal's project browser,
   * then tell the apps to show the Tarayıcı panel. The same checks as for a link click (handlers/browser.ts).
   */
  const terminalOpenActions = {
    /** The project's browser, when `open` may use it (checked before anything is issued or started). */
    target(projectId: string): { browsers: BrowserManager; projectId: string } {
      const project = requireProject(projectId);
      if (!deps.browsers || project.location.kind === "ssh" || project.browser?.runOn === "client") {
        throw engineError("INVALID", "engine.server.noEngineBrowser");
      }
      if (project.openInBrowser === false) throw new OpenDeclinedError(st("engine.server.openNotRedirected"), { key: "engine.server.openNotRedirected" });
      return { browsers: deps.browsers, projectId: project.id };
    },
    async show(target: { browsers: BrowserManager; projectId: string }, url: string): Promise<void> {
      await target.browsers.openUrl(target.projectId, url);
      broadcast({ type: "event", name: "browser.reveal", projectId: target.projectId });
    },
    async url(grant: { projectId: string }, url: string): Promise<void> {
      await this.show(this.target(grant.projectId), url);
    },
    async file(grant: { projectId: string; cardId?: string | undefined }, path: string): Promise<void> {
      const target = this.target(grant.projectId);
      if (!pathActions) throw engineError("INVALID", "engine.server.filesNotInBrowser");
      // A card that is gone, or no longer of this project, is not this terminal's any more.
      if (grant.cardId !== undefined && requireCard(grant.cardId).projectId !== target.projectId) throw engineError("FORBIDDEN", "engine.server.scopedOnly");
      const ref = grant.cardId !== undefined ? { cardId: grant.cardId, path } : { projectId: target.projectId, path };
      await this.show(target, (await pathActions.engineUrl(ref)).url);
    },
  };
  const offBgAgents = deps.bgAgents?.onChange(() => broadcast({ type: "event", name: "bgAgents.changed" }));
  const offClaudeUsage = deps.claudeUsage?.onChange(() => broadcast({ type: "event", name: "claudeUsage.changed" }));

  const handlers: { [M in Method]: Handler<M> } = {
    ...agentsHandlers({ ptys, projects, activity: deps.activity, broadcast }),
    "projects.list": () => ({ projects: projects.list() }),
    "projects.create": async (_c, p) => {
      const project = await projects.create(p);
      changed("projects.changed");
      return { project };
    },
    "projects.update": (_c, p) => {
      const project = projects.update(p);
      changed("projects.changed");
      return { project };
    },
    "projects.delete": (_c, p) => {
      // The service's onBeforeDelete hook closes the project's terminals; drop our subscriptions to them.
      const terminalIds = ptys.list({ projectId: p.projectId }).map((t) => t.id);
      projects.delete(p.projectId);
      forgetTerminals(terminalIds);
      changed("projects.changed");
      return {};
    },
    "sshHosts.list": () => ({ hosts: sshHosts.list() }),
    "sshHosts.create": (_c, p) => {
      const host = sshHosts.create(p);
      changed("sshHosts.changed");
      return { host };
    },
    "sshHosts.update": (_c, p) => {
      const host = sshHosts.update(p);
      changed("sshHosts.changed");
      return { host };
    },
    "sshHosts.delete": (_c, p) => {
      sshHosts.delete(p.hostId);
      changed("sshHosts.changed");
      return {};
    },
    "sshKeys.list": () => ({ keys: sshHosts.listKeys() }),
    "tools.list": () => ({ tools: tools.list() }),
    "tools.create": (_c, p) => {
      const tool = tools.create(p);
      changed("tools.changed");
      return { tool };
    },
    "tools.update": (_c, p) => {
      const tool = tools.update(p);
      changed("tools.changed");
      return { tool };
    },
    "tools.delete": (_c, p) => {
      tools.delete(p.toolId);
      changed("tools.changed");
      return {};
    },
    "tools.check": async () => ({ statuses: await tools.check() }),
    "settings.get": () => ({ settings: settings.get() }),
    "settings.update": (_c, p) => {
      const next = settings.update(p);
      changed("settings.changed");
      return { settings: next };
    },
    "tools.install": (ctx, p) => {
      const tool = requireTool(p.toolId);
      if (tool.installCommand === undefined) {
        throw engineError("INVALID", "engine.server.noInstallCommand", { tool: tool.name });
      }
      const project = requireProject(deps.builtinProjectId);
      return openTerminal(ctx, { project, command: tool.installCommand }, { cols: p.cols, rows: p.rows });
    },
    "cards.list": (_c, p) => {
      requireProject(p.projectId);
      return { cards: cards.list(p.projectId) };
    },
    "cards.create": async (_c, p) => {
      requireProject(p.projectId);
      const card = await cards.create(p.projectId, p.name);
      broadcast({ type: "event", name: "cards.changed", projectId: card.projectId });
      return { card };
    },
    "cards.delete": async (_c, p) => {
      const card = requireCard(p.cardId);
      const terminalIds = ptys.list({ cardId: card.id }).map((t) => t.id);
      await cards.delete(card.id);
      forgetTerminals(terminalIds);
      broadcast({ type: "event", name: "cards.changed", projectId: card.projectId });
      return {};
    },
    "terminals.list": (_c, p) => {
      if (p.cardId !== undefined) {
        const card = requireCard(p.cardId);
        return { terminals: ptys.list({ cardId: card.id }) };
      }
      const project = requireProject(p.projectId ?? "");
      return { terminals: ptys.list({ projectId: project.id }).filter((t) => t.cardId === undefined) };
    },
    "terminal.open": (ctx, p) => {
      const card = p.cardId !== undefined ? requireCard(p.cardId) : undefined;
      const project = requireProject(card ? card.projectId : (p.projectId ?? ""));
      const host = hostFor(project);
      const input: LaunchInput = {
        project,
        ...(card ? { card } : {}),
        ...(host ? { host } : {}),
        ...pickStart(project, p.toolId, p.command),
      };
      const opened = openTerminal(ctx, input, { cols: p.cols, rows: p.rows });
      browser.onTerminalOpen(project, input.tool, input.command);
      return opened;
    },
    "terminal.attach": ({ conn, after }, p) => {
      const terminal = requireTerminal(p.terminalId);
      if (terminal.status === "running") {
        try {
          ptys.resize(terminal.id, p.cols, p.rows);
        } catch (err) {
          logger.warn("resize on attach failed", { terminalId: terminal.id, err: errText(err) });
        }
      }
      // Drop the old subscription now, so nothing slips in between res and replay.
      conn.subs.get(terminal.id)?.();
      conn.subs.delete(terminal.id);
      after(() => attach(conn, terminal.id));
      return { terminal };
    },
    "terminal.detach": ({ conn }, p) => {
      requireTerminal(p.terminalId);
      conn.subs.get(p.terminalId)?.();
      conn.subs.delete(p.terminalId);
      return {};
    },
    "terminal.close": (_c, p) => {
      const terminal = requireTerminal(p.terminalId);
      forgetTerminals([terminal.id]);
      ptys.close(terminal.id);
      broadcast(terminalsChanged(terminal));
      return {};
    },
    ...createMapHandlers({ map: deps.map, requireProject }),
    ...todoHandlers({ todos: deps.todos, broadcast }),
    ...bgAgentsHandlers<Ctx>({
      service: deps.bgAgents,
      openTerminal: (ctx, t, size) => {
        const project = requireProject(t.projectId);
        const card = t.cardId !== undefined ? requireCard(t.cardId) : undefined;
        const host = hostFor(project);
        const account = t.accountId !== undefined ? { claudeAccountId: t.accountId } : {}; // İş H
        return openTerminal(ctx, { project, ...(card ? { card } : {}), ...(host ? { host } : {}), command: t.command, ...account }, size);
      },
    }),
    ...claudeAccountHandlers<Ctx>({
      service: deps.claudeAccounts?.service,
      builtinProjectId: deps.builtinProjectId,
      loginCommand: deps.claudeAccounts?.loginCommand ?? "",
      broadcast,
      openTerminal: (ctx, t, size) =>
        openTerminal(ctx, { project: requireProject(t.projectId), command: t.command, claudeAccountId: t.claudeAccountId }, size),
    }),
    ...claudeUsageHandlers({ service: deps.claudeUsage }), // Claude kullanımı
    ...browser.requests,
    ...createFilesHandlers<Ctx>({ files: deps.files, media: deps.media, requireProject, requireCard, paths: pathActions }),
    ...createFlowHandlers({ flow: deps.flow, requireProject, requireCard }), // İş W
    ...createClaudeHandlers({ inventory: deps.claudeInventory, requireProject, requireCard }),
    ...createLoginHandlers({ logins: deps.logins, requireProject }), // Girişler
    ...createAppUpdateHandlers<Ctx>({ updates: deps.appUpdates, identity: { build, protocol: PROTOCOL_VERSION } }), // Kendini güncelleme
  };

  /** A newer app — or a module this build has off — asked for something this engine does not have. */
  function answerUnknownMethod(conn: Conn, id: number, method: string): void {
    logger.warn("unknown method", { remote: conn.remote, method });
    send(conn, { type: "res", id, ok: false, error: { code: "UNKNOWN_METHOD", ...errorText("engine.server.unknownMethod", { method }) } });
  }

  async function handleRequest(conn: Conn, msg: RequestMessage): Promise<void> {
    if (conn.scope && !SCOPED_METHODS.includes(msg.method)) return refuseScoped(conn, msg.id, msg.method);
    if (!features.isMethodEnabled(msg.method)) return answerUnknownMethod(conn, msg.id, msg.method);
    const handler = handlers[msg.method] as Handler<Method>;
    const pending: (() => void)[] = [];
    const ctx: Ctx = { conn, after: (fn) => pending.push(fn) };
    let reply: ServerMessage;
    try {
      const result = await handler(ctx, msg.params as ParamsOf<Method>);
      reply = { type: "res", id: msg.id, ok: true, result };
    } catch (err) {
      pending.length = 0;
      if (err instanceof EngineError) {
        reply = { type: "res", id: msg.id, ok: false, error: { code: err.code, message: err.message, ...err.text } };
      } else {
        logger.error("request failed", { method: msg.method, remote: conn.remote, err: errText(err) });
        reply = { type: "res", id: msg.id, ok: false, error: { code: "INTERNAL", message: INTERNAL_MESSAGE } };
      }
    }
    send(conn, reply, msg.method);
    for (const fn of pending) {
      try {
        fn();
      } catch (err) {
        logger.error("post-response step failed", { method: msg.method, err: errText(err) });
      }
    }
  }

  /** Adım 9 İş K: a scoped connection asked for a method outside its scope. Nothing is looked up or run. */
  function refuseScoped(conn: Conn, id: number, method: string): void {
    logger.warn("scoped connection refused", { remote: conn.remote, projectId: conn.scope?.projectId, method });
    send(conn, { type: "res", id, ok: false, error: { code: "FORBIDDEN", ...errorText("engine.server.scopedOnly") } });
  }

  function handleAuthed(conn: Conn, msg: ClientMessage): void {
    if (conn.scope && msg.type !== "req") {
      // Terminal input, resize, acks, a second hello…: none of it belongs to a scoped connection.
      logger.warn("scoped connection sent a frame outside its scope", { remote: conn.remote, projectId: conn.scope.projectId, type: msg.type });
      closeConn(conn, CLOSE_CODES.BAD_MESSAGE, "forbidden");
      return;
    }
    // A stream frame of a module that is off (e.g. its input or ack) is dropped like one of an unknown module.
    if (msg.type !== "req" && !features.isMethodEnabled(msg.type)) return;
    switch (msg.type) {
      case "auth.hello":
      case "auth.proof":
        closeConn(conn, CLOSE_CODES.BAD_MESSAGE, "unexpected hello");
        return;
      case "input":
        try {
          ptys.write(msg.terminalId, msg.data);
        } catch (err) {
          inputFailed(msg.terminalId, err);
        }
        return;
      case "resize":
        try {
          ptys.resize(msg.terminalId, msg.cols, msg.rows);
        } catch (err) {
          logger.warn("resize failed", { terminalId: msg.terminalId, err: errText(err) });
        }
        return;
      case "req":
        void handleRequest(conn, msg);
        return;
      case "browser.input":
      case "browser.ack":
        browser.onMessage(conn, msg);
        return;
    }
  }

  // ---------- handshake (@kokpit/shared auth.ts) ----------

  /** The handshake's HMAC steps; injectable so tests can hold a handshake between its checks. */
  const crypto = { proofMatches, authProof, ...deps.handshakeCrypto };
  /** Client nonces of recent handshakes, oldest first: a repeated one is a replay. */
  const recentNonces = new Set<string>();
  const nonceMemory = config.authNonceMemory ?? 0;

  function refuse(conn: Conn, why: string): void {
    logger.warn("unauthorized connection rejected", { remote: conn.remote, why });
    closeConn(conn, CLOSE_CODES.UNAUTHORIZED, "unauthorized");
  }

  /** Frames before authentication: `auth.hello`, then `auth.proof`. Anything else ends the connection. */
  async function onHandshakeFrame(conn: Conn, raw: string | undefined, parsed: ReturnType<typeof parseClientMessage> | undefined): Promise<void> {
    // A client of the old protocol sent its key (or grant) in clear. It is not looked at; the client must be updated.
    if (raw !== undefined && (!parsed || !parsed.ok) && isOldHello(raw)) {
      logger.warn("outdated client refused (it sent its secret in clear)", { remote: conn.remote });
      closeConn(conn, CLOSE_CODES.OUTDATED_CLIENT, "outdated client");
      return;
    }
    const msg = parsed?.ok === true ? parsed.value : undefined;
    const auth = conn.auth;
    if (msg?.type === "auth.hello" && auth.stage === "hello") {
      if (recentNonces.has(msg.nonce)) return refuse(conn, "replayed nonce");
      if (nonceMemory > 0) {
        recentNonces.add(msg.nonce);
        while (recentNonces.size > nonceMemory) recentNonces.delete(recentNonces.values().next().value!);
      }
      // Two ways in, never mixed: the access key (the app, unrestricted) or a live screen grant (scoped). An
      // unknown grant still gets a challenge, with a secret nobody holds: whether a grant id exists is not told.
      let secret: Uint8Array;
      let grant: { id: string; projectId: string } | undefined;
      if (msg.grant !== undefined) {
        const found = undefined as { secret: Uint8Array; grant: { id: string; projectId: string } } | undefined; // no grants in this edition
        secret = found?.secret ?? globalThis.crypto.getRandomValues(new Uint8Array(32));
        grant = found?.grant;
      } else {
        secret = keySecret(config.key);
      }
      const serverNonce = newNonce();
      conn.auth = { stage: "proof", clientNonce: msg.nonce, serverNonce, secret, grant };
      send(conn, { type: "auth.challenge", nonce: serverNonce });
      return;
    }
    if (msg?.type === "auth.proof" && auth.stage === "proof") {
      conn.auth = { stage: "checking" };
      // The scope is set BEFORE anything is awaited (still unauthenticated): a revocation of the grant during the
      // checks below finds this connection and closes it.
      if (auth.grant) conn.scope = { grantId: auth.grant.id, projectId: auth.grant.projectId };
      const ok = await crypto.proofMatches(auth.secret, AUTH_LABELS.client, auth.serverNonce, auth.clientNonce, msg.proof);
      if (conn.closed) return;
      if (!ok) return refuse(conn, "wrong proof");
      const proof = await crypto.authProof(auth.secret, AUTH_LABELS.engine, auth.clientNonce, auth.serverNonce);
      // Re-checked right before the connection becomes authenticated: nothing is awaited between here and there.
      if (conn.closed) return;
      conn.authed = true;
      if (conn.authTimer) clearTimeout(conn.authTimer);
      conn.authTimer = undefined;
      if (auth.grant) logger.info("screen client authenticated", { remote: conn.remote, projectId: auth.grant.projectId, grantId: auth.grant.id });
      else logger.info("client authenticated", { remote: conn.remote });
      clientsChanged();
      send(conn, { type: "hello.ok", engineVersion: version, engineBuild: build as AuthBuildInfo, protocol: PROTOCOL_VERSION, proof });
      return;
    }
    refuse(conn, "frame out of order");
  }

  // ---------- connections ----------

  function onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const remote = `${req.socket.remoteAddress ?? "?"}:${req.socket.remotePort ?? "?"}`;
    const conn: Conn = { ws, remote, authed: false, auth: { stage: "hello" }, closed: false, authTimer: undefined, alive: true, subs: new Map() };
    conns.add(conn);
    conn.authTimer = setTimeout(() => {
      logger.warn("auth timeout", { remote });
      closeConn(conn, CLOSE_CODES.UNAUTHORIZED, "unauthorized");
    }, config.authTimeoutMs);

    ws.on("error", (err) => logger.warn("websocket error", { remote, err: errText(err) }));
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("close", () => {
      conn.closed = true;
      cleanupConn(conn);
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (conn.closed) return;
      const raw = isBinary ? undefined : rawToString(data);
      const parsed = raw === undefined ? undefined : parseClientMessage(raw);
      if (!conn.authed) {
        void onHandshakeFrame(conn, raw, parsed);
        return;
      }
      if (parsed && !parsed.ok && parsed.badRequest) {
        const { id, method, message } = parsed.badRequest;
        if (conn.scope && !SCOPED_METHODS.includes(method)) return refuseScoped(conn, id, method);
        if (!features.isMethodEnabled(method)) return answerUnknownMethod(conn, id, method);
        logger.warn("invalid params", { remote, method, reason: message });
        send(conn, { type: "res", id, ok: false, error: { code: "INVALID", message } });
        return;
      }
      // Kendini güncelleme: a newer app asked for something this engine does not have. It gets an answer; the
      // connection — and every terminal the user has open on it — stays.
      if (parsed && !parsed.ok && parsed.unknownMethod) {
        const { id, method } = parsed.unknownMethod;
        if (conn.scope) return refuseScoped(conn, id, method);
        return answerUnknownMethod(conn, id, method);
      }
      if (!parsed || !parsed.ok) {
        logger.warn("bad message", { remote, reason: parsed ? parsed.error : "binary frame" });
        closeConn(conn, CLOSE_CODES.BAD_MESSAGE, "bad message");
        return;
      }
      handleAuthed(conn, parsed.value);
    });
  }

  // ---------- listeners ----------

  function onHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://engine").pathname;
    } catch {
      pathname = "";
    }
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (deps.map?.handleHttp(req, res)) return;
    if (deps.media?.handleHttp(req, res)) return;
    if (deps.appUpdates?.handleHttp(req, res)) return;
    if (deps.paths?.preview.handleHttp(req, res)) return;
    if (deps.terminalOpen?.handleHttp(req, res, terminalOpenActions)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  }

  async function bind(host: string): Promise<Listener> {
    const server = http.createServer(onHttpRequest);
    const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
    wss.on("connection", onConnection);
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on("error", () => {});
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => logger.error("listener error", { host, err: errText(err) }));
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    if (port === 0) port = boundPort;
    logger.info("listening", { host, port: boundPort });
    return { host, port: boundPort, http: server, wss };
  }

  async function unbind(l: Listener): Promise<void> {
    for (const ws of l.wss.clients) ws.terminate();
    l.wss.close();
    l.http.closeAllConnections();
    await new Promise<void>((resolve) => l.http.close(() => resolve()));
    logger.info("stopped listening", { host: l.host, port: l.port });
  }

  function desiredAddresses(): string[] {
    let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
    try {
      interfaces = getInterfaces();
    } catch (err) {
      logger.warn("reading network interfaces failed", { err: errText(err) });
    }
    return selectListenAddresses(interfaces, config);
  }

  async function sync(): Promise<void> {
    const desired = desiredAddresses();
    for (const [host, l] of [...listeners]) {
      if (!desired.includes(host)) {
        listeners.delete(host);
        await unbind(l);
      }
    }
    for (const host of desired) {
      if (listeners.has(host) || stopped) continue;
      try {
        const l = await bind(host);
        if (stopped) {
          await unbind(l);
          return;
        }
        listeners.set(host, l);
      } catch (err) {
        logger.warn("bind failed", { host, port, err: errText(err) });
      }
    }
  }

  /** The input failure logged last and how often it repeated since (each key typed into a dead terminal fails). */
  let lastInputFailure: { key: string; repeats: number } | undefined;

  /** Performans: logged once per run of the same failure (terminal + reason), without the stack of an expected one. */
  function inputFailed(terminalId: string, err: unknown): void {
    const why = err instanceof EngineError ? { code: err.code, message: err.message } : { err: errText(err) };
    const key = JSON.stringify([terminalId, why]);
    if (lastInputFailure?.key === key) {
      lastInputFailure.repeats++;
      return;
    }
    const repeats = lastInputFailure?.repeats ?? 0;
    lastInputFailure = { key, repeats: 0 };
    logger.warn("input failed", { terminalId, ...why, ...(repeats > 0 ? { repeatsBefore: repeats } : {}) });
  }

  /**
   * Performans: a client that answered no ping since the previous round is gone in all but name (its machine
   * sleeps, its route dropped). It is dropped, so the streams it watched stop instead of capturing for nobody.
   */
  function pingClients(): void {
    for (const conn of [...conns]) {
      if (conn.closed) continue;
      if (!conn.alive) {
        logger.warn("client unresponsive", { remote: conn.remote, intervalMs: config.wsPingIntervalMs });
        conn.closed = true;
        cleanupConn(conn);
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        /* the socket is closing: its close event cleans up */
      }
    }
  }

  return {
    async start() {
      stopped = false;
      await sync();
      if (config.listenLocalhost && ![...listeners.keys()].some(isLoopbackAddress)) {
        await this.stop();
        throw new Error("could not bind any loopback address");
      }
      rescanTimer = setInterval(() => {
        if (rescanning || stopped) return;
        rescanning = true;
        sync()
          .catch((err: unknown) => logger.error("interface rescan failed", { err: errText(err) }))
          .finally(() => {
            rescanning = false;
          });
      }, config.tailscaleRescanMs);
      rescanTimer.unref();
      const pingMs = config.wsPingIntervalMs ?? 0;
      if (pingMs > 0) {
        pingTimer = setInterval(pingClients, pingMs);
        pingTimer.unref();
      }
    },
    async stop() {
      stopped = true;
      if (rescanTimer) clearInterval(rescanTimer);
      rescanTimer = undefined;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = undefined;
      for (const conn of [...conns]) closeConn(conn, 1001, "engine stopping");
      for (const unsub of exitWatchers.values()) unsub();
      exitWatchers.clear();
      browser.stop();
      deps.media?.stop();
      deps.appUpdates?.stop();
      deps.paths?.preview.stop();
      offBgAgents?.();
      offClaudeUsage?.();
      deps.bgAgents?.setClientCount(0);
      const all = [...listeners.values()];
      listeners.clear();
      await Promise.all(all.map(unbind));
    },
    addresses() {
      return [...listeners.values()].map((l) => ({ host: l.host, port: l.port }));
    },
  };
}

/** A first frame of the old protocol (`hello` with the key, `hello.screen` with the grant token). */
function isOldHello(raw: string): boolean {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) && ["hello", "hello.screen"].includes((v as { type?: unknown }).type as string);
  } catch {
    return false;
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function errText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
