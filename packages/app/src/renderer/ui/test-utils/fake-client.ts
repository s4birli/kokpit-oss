// In-memory EngineClient for UI tests: scripted responses, emit helpers, call log.
import type {
  BgAgentSession,
  BrowserFrameMessage,
  BrowserInputEvent,
  Card,
  ClaudeAccount,
  FlowEntry,
  Method,
  ParamsOf,
  Project,
  ResultOf,
  Settings,
  SshHost,
  TerminalInfo,
  Todo,
  Tool,
  ToolStatus,
} from "@kokpit/shared";
import { FakeTodos } from "./fake-todos.ts";
import {
  EngineRequestError,
  type ConnectionState,
  type EngineClient,
  type EngineEvent,
} from "../../engine/types.ts";
import { FakeBrowser } from "./fake-browser.ts";
import { FakeFiles, type FakeTree } from "./fake-files.ts";
import { FakeClaudeAccounts } from "./fake-claude-accounts.ts";
import { FakeLogins } from "./fake-logins.ts"; // Girişler

export interface RequestCall {
  method: Method;
  params: unknown;
}

type Handler<M extends Method> = (params: ParamsOf<M>) => ResultOf<M> | Promise<ResultOf<M>>;
type HandlerMap = { [M in Method]?: Handler<M> };

class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...args: A) => void>();
  add(cb: (...args: A) => void): () => void {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }
  emit(...args: A): void {
    for (const cb of [...this.set]) cb(...args);
  }
  get size(): number {
    return this.set.size;
  }
}

export interface FakeSeed {
  projects?: Project[];
  cards?: Card[];
  terminals?: TerminalInfo[];
  hosts?: SshHost[];
  keys?: string[];
  tools?: Tool[];
  toolStatuses?: ToolStatus[];
  /** Engine settings; default `{}` (no global default tool). */
  settings?: Settings;
  /** Yapılacaklar: todos and day notes. */
  todos?: Todo[];
  notes?: Record<string, string>;
  /** İş F: folder tree served by files.* for every target. */
  files?: FakeTree;
  // ---- İş A (Adım 7): arka plan ajanları ----
  bgAgents?: BgAgentSession[];
  /** İş H: Claude accounts; default = only the default account "Benim". */
  claudeAccounts?: ClaudeAccount[];
}


/** İş W: update command the fake engine reports in flow.info, and one fake flow file (entry + text). */
export const FAKE_FLOW_UPDATE_COMMAND = "fake-akis-ciz";
export type FakeFlow = FlowEntry & { text: string };

/** Update command the fake engine reports in map.info. */
export const FAKE_MAP_UPDATE_COMMAND = "fake-graphify";

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${++idCounter}`;

export class FakeEngineClient implements EngineClient {
  state: ConnectionState = "open";
  transportMessage: string | undefined = undefined;
  readonly calls: RequestCall[] = [];
  readonly inputs: Array<{ terminalId: string; data: string }> = [];
  readonly resizes: Array<{ terminalId: string; cols: number; rows: number }> = [];
  closed = false;

  projects: Project[];
  cards: Card[];
  terminals: TerminalInfo[];
  hosts: SshHost[];
  keys: string[];
  tools: Tool[];
  toolStatuses: ToolStatus[];
  settings: Settings;
  /** A field initializer, so `defaults` below can spread its handlers. */
  readonly todos = new FakeTodos();
  /** İş A (Adım 7): background sessions; `bgAgentsError` is reported by bgAgents.list; logs text by id. */
  bgAgents: BgAgentSession[];
  bgAgentsError: string | undefined = undefined;
  bgAgentLogs: Record<string, string> = {};
  /** İş W: flow files served by flow.* for every target (list order = this order). */
  flows: FakeFlow[] = [];

  /** İş B: in-memory browser (requests, frames, acks, input). */
  readonly browser = new FakeBrowser();
  /** İş F: in-memory folder trees (files.list / files.read). */
  readonly files = new FakeFiles();
  /** Girişler: in-memory saved logins (logins.*). */
  readonly logins = new FakeLogins();
  /** İş H: Claude accounts (seeded with the default "Benim"). */
  readonly claudeAccounts = new FakeClaudeAccounts(
    (projectId, command) => this.openTerminal(projectId, undefined, undefined, command),
    () => this.projects.find((p) => p.builtin)?.id,
  );
  private readonly overrides: HandlerMap = {};
  private readonly gates = new Map<Method, Promise<void>>();
  private readonly stateL = new Listeners<[ConnectionState]>();
  private readonly eventL = new Listeners<[EngineEvent]>();
  private readonly reconnectL = new Listeners<[]>();
  private readonly outputL = new Map<string, Listeners<[string, boolean, boolean]>>();
  private readonly outputLostL = new Map<string, Listeners<[]>>();
  private readonly exitL = new Map<string, Listeners<[number | null]>>();

  constructor(seed: FakeSeed = {}) {
    this.projects = [...(seed.projects ?? [])];
    this.cards = [...(seed.cards ?? [])];
    this.terminals = [...(seed.terminals ?? [])];
    this.hosts = [...(seed.hosts ?? [])];
    this.keys = [...(seed.keys ?? [])];
    this.tools = [...(seed.tools ?? [])];
    this.toolStatuses = [...(seed.toolStatuses ?? [])];
    this.settings = { ...(seed.settings ?? {}) };
    this.todos.seed(seed.todos, seed.notes);
    this.files.tree = { ...(seed.files ?? {}) };
    this.bgAgents = [...(seed.bgAgents ?? [])];
    this.claudeAccounts.seed(seed.claudeAccounts); // İş H
  }


  // ---------- scripting ----------

  /** Replace the default in-memory behaviour of one method. */
  respond<M extends Method>(method: M, handler: Handler<M>): void {
    (this.overrides as Record<Method, unknown>)[method] = handler;
  }

  /** Make one method reject with an engine error. */
  fail(method: Method, code: EngineRequestError["code"], message: string): void {
    this.respond(method, () => {
      throw new EngineRequestError(code, message);
    });
  }

  /** Holds the answers of `methods` back (a slow engine) until the returned function is called. */
  hold(methods: readonly Method[]): () => void {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    for (const m of methods) this.gates.set(m, gate);
    return () => {
      for (const m of methods) if (this.gates.get(m) === gate) this.gates.delete(m);
      release();
    };
  }

  /** Restore the default in-memory behaviour of one method. */
  restore(method: Method): void {
    delete this.overrides[method];
  }

  callsOf<M extends Method>(method: M): ParamsOf<M>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params as ParamsOf<M>);
  }

  // ---------- emit helpers ----------

  setState(state: ConnectionState): void {
    this.state = state;
    this.stateL.emit(state);
  }
  /** `continued`: a further part of a replay already started (the panel must not reset). */
  emitOutput(terminalId: string, data: string, replay = false, continued = false): void {
    this.outputL.get(terminalId)?.emit(data, replay, continued);
  }
  emitOutputLost(terminalId: string): void {
    this.outputLostL.get(terminalId)?.emit();
  }
  emitExit(terminalId: string, exitCode: number | null): void {
    this.exitL.get(terminalId)?.emit(exitCode);
  }
  emitEvent(event: EngineEvent): void {
    this.eventL.emit(event);
  }
  /** Simulates a successful re-authentication: state goes open, then reconnect listeners fire. */
  emitReconnected(): void {
    this.setState("open");
    this.reconnectL.emit();
  }

  listenerCounts(): { state: number; event: number; reconnect: number; output: number; exit: number } {
    let output = 0;
    let exit = 0;
    for (const l of this.outputL.values()) output += l.size;
    for (const l of this.exitL.values()) exit += l.size;
    return { state: this.stateL.size, event: this.eventL.size, reconnect: this.reconnectL.size, output, exit };
  }

  // ---------- EngineClient ----------

  onState(cb: (state: ConnectionState) => void): () => void {
    return this.stateL.add(cb);
  }
  onEvent(cb: (event: EngineEvent) => void): () => void {
    return this.eventL.add(cb);
  }
  onReconnected(cb: () => void): () => void {
    return this.reconnectL.add(cb);
  }
  onOutput(terminalId: string, cb: (data: string, replay: boolean, continued: boolean) => void): () => void {
    return this.listenersFor(this.outputL, terminalId).add(cb);
  }
  onOutputLost(terminalId: string, cb: () => void): () => void {
    return this.listenersFor(this.outputLostL, terminalId).add(cb);
  }
  onExit(terminalId: string, cb: (exitCode: number | null) => void): () => void {
    return this.listenersFor(this.exitL, terminalId).add(cb);
  }
  sendInput(terminalId: string, data: string): void {
    this.inputs.push({ terminalId, data });
  }
  sendResize(terminalId: string, cols: number, rows: number): void {
    this.resizes.push({ terminalId, cols, rows });
  }
  close(): void {
    this.closed = true;
  }
  // İş B
  onBrowserFrame(projectId: string, cb: (frame: BrowserFrameMessage) => void): () => void {
    return this.browser.onFrame(projectId, cb);
  }
  sendBrowserInput(projectId: string, event: BrowserInputEvent): void {
    this.browser.inputs.push({ projectId, event });
  }
  sendBrowserAck(projectId: string, frameId: number): void {
    this.browser.acks.push({ projectId, frameId });
  }
  // Masaüstü

  request<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    this.calls.push({ method, params });
    if (this.state !== "open") {
      return Promise.reject(new EngineRequestError("DISCONNECTED", "bağlantı yok"));
    }
    const override = this.overrides[method] as Handler<M> | undefined;
    const handler = override ?? (this.defaults[method] as Handler<M>);
    return (this.gates.get(method) ?? Promise.resolve()).then(() => handler(params));
  }

  // ---------- default in-memory engine ----------

  private listenersFor<A extends unknown[]>(map: Map<string, Listeners<A>>, id: string): Listeners<A> {
    let l = map.get(id);
    if (!l) {
      l = new Listeners<A>();
      map.set(id, l);
    }
    return l;
  }

  private findTerminal(id: string): TerminalInfo {
    const t = this.terminals.find((x) => x.id === id);
    if (!t) throw new EngineRequestError("NOT_FOUND", `terminal yok: ${id}`);
    return t;
  }

  private find<T extends { id: string }>(list: T[], id: string, what: string): T {
    const x = list.find((i) => i.id === id);
    if (!x) throw new EngineRequestError("NOT_FOUND", `${what} yok: ${id}`);
    return x;
  }

  /** Like the engine: command > toolId > project default > global default > shell; toolId null = shell. */
  private openTerminal(
    projectId: string,
    cardId: string | undefined,
    requested?: string | null,
    command?: string,
  ): TerminalInfo {
    const id = nextId("term");
    const exists = (x: string | undefined) => (x !== undefined && this.tools.some((t) => t.id === x) ? x : undefined);
    const project = this.projects.find((p) => p.id === projectId);
    const toolId =
      command !== undefined || requested === null
        ? undefined
        : (requested ?? exists(project?.defaultToolId) ?? exists(this.settings.defaultToolId));
    const tool = toolId === undefined ? undefined : this.tools.find((t) => t.id === toolId);
    const typed = command ?? tool?.command;
    const terminal: TerminalInfo = {
      id,
      projectId,
      ...(cardId === undefined ? {} : { cardId }),
      ...(toolId === undefined ? {} : { toolId }),
      title: typed ?? id,
      status: "running",
      createdAt: new Date(0).toISOString(),
      ...(typed === undefined ? {} : { command: typed }),
    };
    this.terminals.push(terminal);
    this.terminalsChanged(terminal);
    return terminal;
  }

  /** Like the engine: every open/close is broadcast as terminals.changed, after the request's answer. */
  private terminalsChanged(t: TerminalInfo): void {
    const event: EngineEvent = {
      type: "event",
      name: "terminals.changed",
      projectId: t.projectId,
      ...(t.cardId !== undefined ? { cardId: t.cardId } : {}),
    };
    queueMicrotask(() => this.emitEvent(event));
  }

  private readonly defaults: { [M in Method]: Handler<M> } = {
    // Kendini güncelleme: the page never sends these (main's updater does); here so the table stays complete.
    "app.update.check": ({ app }) => ({ engine: { build: app, protocol: 0 }, update: null }),
    "app.update.download": () => ({ path: "", size: 0, sha256: "", expiresAt: "", entries: [] }),
    "app.update.report": () => ({}),
    "app.update.clients": () => ({ current: null, clients: [] }),
    // İş A: like the engine, every terminal grouped by project (project order, empty projects left out).
    "agents.summary": () => ({
      projects: this.projects
        .map((p) => ({ projectId: p.id, terminals: this.terminals.filter((t) => t.projectId === p.id) }))
        .filter((p) => p.terminals.length > 0),
    }),
    "projects.list": () => ({ projects: [...this.projects] }),
    "projects.create": ({ name, location, defaultToolId, browser, claudeAccountId }) => {
      const id = nextId("proj");
      const project: Project = {
        id,
        name,
        location: location.kind === "github" ? { ...location, path: `/data/repos/${id}` } : location,
        ...(defaultToolId === undefined ? {} : { defaultToolId }),
        ...(browser === undefined ? {} : { browser }),
        ...(claudeAccountId === undefined ? {} : { claudeAccountId }), // İş H
      };
      this.projects.push(project);
      return { project };
    },
    "projects.update": ({ projectId, ...patch }) => {
      const project = this.find(this.projects, projectId, "proje");
      applyPatch(project, patch);
      return { project };
    },
    "projects.delete": ({ projectId }) => {
      this.projects = this.projects.filter((p) => p.id !== projectId);
      return {};
    },
    "sshHosts.list": () => ({ hosts: [...this.hosts] }),
    "sshHosts.create": (fields) => {
      const host: SshHost = { ...fields, id: nextId("host"), source: "kokpit" };
      this.hosts.push(host);
      return { host };
    },
    "sshHosts.update": ({ hostId, ...patch }) => {
      const host = this.find(this.hosts, hostId, "sunucu");
      applyPatch(host, patch);
      return { host };
    },
    "sshHosts.delete": ({ hostId }) => {
      this.hosts = this.hosts.filter((h) => h.id !== hostId);
      return {};
    },
    "sshKeys.list": () => ({ keys: [...this.keys] }),
    "tools.list": () => ({ tools: [...this.tools] }),
    "tools.create": (fields) => {
      const tool: Tool = { ...fields, id: nextId("tool") };
      this.tools.push(tool);
      return { tool };
    },
    "tools.update": ({ toolId, ...patch }) => {
      const tool = this.find(this.tools, toolId, "araç");
      applyPatch(tool, patch);
      return { tool };
    },
    "tools.delete": ({ toolId }) => {
      this.tools = this.tools.filter((t) => t.id !== toolId);
      return {};
    },
    "tools.check": () => ({ statuses: [...this.toolStatuses] }),
    "settings.get": () => ({ settings: { ...this.settings } }),
    "settings.update": ({ defaultToolId }) => {
      if (defaultToolId != null) this.find(this.tools, defaultToolId, "araç");
      this.settings = defaultToolId == null ? {} : { defaultToolId };
      // Like the engine: every client hears about a settings change.
      queueMicrotask(() => this.emitEvent({ type: "event", name: "settings.changed" }));
      return { settings: { ...this.settings } };
    },
    "tools.install": ({ toolId }) => {
      const tool = this.find(this.tools, toolId, "araç");
      const builtin = this.projects.find((p) => p.builtin);
      if (!builtin || !tool.installCommand) throw new EngineRequestError("INVALID", "kurulamaz");
      return { terminal: this.openTerminal(builtin.id, undefined, undefined, tool.installCommand) };
    },
    "cards.list": ({ projectId }) => ({ cards: this.cards.filter((c) => c.projectId === projectId) }),
    "cards.create": ({ projectId, name }) => {
      const id = nextId("card");
      const card: Card = {
        id,
        projectId,
        name,
        branch: `branch-${id}`,
        worktreePath: `/wt/${id}`,
        createdAt: new Date(0).toISOString(),
      };
      this.cards.push(card);
      return { card };
    },
    "cards.delete": ({ cardId }) => {
      this.cards = this.cards.filter((c) => c.id !== cardId);
      return {};
    },
    "terminals.list": ({ cardId, projectId }) => ({
      terminals: this.terminals.filter((t) =>
        cardId !== undefined ? t.cardId === cardId : t.projectId === projectId && t.cardId === undefined,
      ),
    }),
    "terminal.open": ({ cardId, projectId, toolId, command }) => {
      const owner = cardId !== undefined ? this.find(this.cards, cardId, "kart").projectId : projectId!;
      return { terminal: this.openTerminal(owner, cardId, toolId, command) };
    },
    "terminal.attach": ({ terminalId }) => ({ terminal: this.findTerminal(terminalId) }),
    "terminal.detach": () => ({}),
    "terminal.close": ({ terminalId }) => {
      const closed = this.findTerminal(terminalId);
      this.terminals = this.terminals.filter((t) => t.id !== terminalId);
      this.terminalsChanged(closed);
      return {};
    },
    // ---- harita (İş C): no map by default; tests script these with respond() ----
    "map.info": () => ({ available: false, updateCommand: FAKE_MAP_UPDATE_COMMAND }),
    "map.token": () => {
      throw new EngineRequestError("NOT_FOUND", "Bu projede harita yok");
    },
    // ---- İş C (Adım 8): Claude envanteri; empty by default, tests script these with respond() ----
    "claude.inventory": () => ({ items: [], truncated: false, claudeMd: { user: false } }),
    "claude.inventory.read": () => {
      throw new EngineRequestError("NOT_FOUND", "Öğe bulunamadı");
    },
    // ---- Claude kullanımı: nothing counted by default; tests script these with respond() ----
    "claudeUsage.get": () => ({ accounts: [], sessionWindowHours: 5, longWindowDays: 7, refreshIntervalMs: 60_000, probeAvailable: false }),
    "claudeUsage.probe": () => {
      throw new EngineRequestError("INVALID", "Claude'a sorma bu motorda kapalı");
    },
    // ---- İş A (Adım 7): like the engine: attach opens a terminal in the session's project/card, else the built-in one ----
    "bgAgents.list": () => ({
      sessions: this.bgAgents.map((s) => ({ ...s })),
      ...(this.bgAgentsError !== undefined ? { error: this.bgAgentsError } : {}),
    }),
    "bgAgents.attach": ({ id }) => {
      const s = this.find(this.bgAgents, id, "arka plan ajanı");
      const projectId = s.projectId ?? this.projects.find((p) => p.builtin)?.id;
      if (projectId === undefined) throw new EngineRequestError("NOT_FOUND", "Ajanın projesi bulunamadı.");
      return { terminal: this.openTerminal(projectId, s.cardId, undefined, `claude attach ${id}`) };
    },
    "bgAgents.logs": ({ id }) => {
      this.find(this.bgAgents, id, "arka plan ajanı");
      return { text: this.bgAgentLogs[id] ?? "", truncated: false };
    },
    "bgAgents.stop": ({ id }) => {
      const s = this.find(this.bgAgents, id, "arka plan ajanı");
      this.bgAgents = this.bgAgents.map((x) => (x === s ? { id: s.id, name: s.name, state: "done", cwd: s.cwd, ...(s.projectId !== undefined ? { projectId: s.projectId } : {}), ...(s.cardId !== undefined ? { cardId: s.cardId } : {}) } : x));
      return {};
    },
    ...this.todos.handlers,
    ...this.browser.handlers,
    ...this.files.handlers,
    ...this.logins.handlers, // Girişler
    ...this.claudeAccounts.handlers, // İş H
    // ---- İş W: akış ----
    "flow.info": () => ({ available: true, dir: "docs/akis", updateCommand: FAKE_FLOW_UPDATE_COMMAND }),
    "flow.list": () => ({ flows: this.flows.map(({ text: _t, ...e }) => e), truncated: false }),
    "flow.read": ({ id }) => {
      const f = this.flows.find((x) => x.id === id);
      if (!f) throw new EngineRequestError("NOT_FOUND", "Akış bulunamadı");
      return { text: f.text };
    },
  };
}

/** Applies an update patch like the engine: undefined keeps, null clears. */
function applyPatch(target: object, patch: object): void {
  const t = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete t[k];
    else t[k] = v;
  }
}

// ---------- fixtures ----------

export function makeBgAgent(id: string, state: BgAgentSession["state"], extra: Partial<BgAgentSession> = {}): BgAgentSession {
  return { id, name: id, state, cwd: `/repos/${id}`, ...(state === "waiting" ? { waitingReason: "approval" as const } : {}), ...extra };
}

export function makeProject(id: string, name = id, extra: Partial<Project> = {}): Project {
  return { id, name, location: { kind: "local", path: `/repos/${id}` }, ...extra };
}

export function makeSshProject(id: string, name: string, hostId: string, path?: string): Project {
  return { id, name, location: { kind: "ssh", hostId, ...(path === undefined ? {} : { path }) } };
}

export function makeCard(id: string, projectId: string, name = id): Card {
  return { id, projectId, name, branch: `kokpit/${id}`, worktreePath: `/wt/${id}`, createdAt: new Date(0).toISOString() };
}

/** A card terminal. `projectId` only matters to tests that look at it. */
export function makeTerminal(id: string, cardId: string, title = id, projectId = `project-of-${cardId}`): TerminalInfo {
  return { id, projectId, cardId, title, status: "running", createdAt: new Date(0).toISOString() };
}

/** A project-level (cardless) terminal. */
export function makeProjectTerminal(id: string, projectId: string, title = id): TerminalInfo {
  return { id, projectId, title, status: "running", createdAt: new Date(0).toISOString() };
}

export function makeTool(id: string, name = id, extra: Partial<Tool> = {}): Tool {
  return { id, name, command: `${id}-komutu`, ...extra };
}

export function makeHost(id: string, name = id, extra: Partial<SshHost> = {}): SshHost {
  return { id, name, hostname: `${id}.example`, source: "kokpit", ...extra };
}
