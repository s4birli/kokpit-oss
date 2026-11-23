// In-memory fakes for the modules the server depends on. Test-only.
import type { Card, ParamsOf, Project, Settings, SshHost, TerminalInfo, Tool, ToolStatus } from "@kokpit/shared";
import {
  EngineError,
  type CardService,
  type EngineConfig,
  type LaunchSpec,
  type Logger,
  type ProjectService,
  type PtyManager,
  type SettingsService,
  type SshHostService,
  type StateStore,
  type StoredSettings,
  type TerminalListener,
  type ToolService,
} from "../../src/contracts.ts";
import type { LaunchInput } from "../../src/server.ts";

export const TEST_KEY = "test-key-0123456789";
export const BUILTIN_PROJECT_ID = "macmini";
const T0 = "2026-01-01T00:00:00.000Z";

export function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    configPath: "/tmp/kokpit-test/config.json",
    port: 0,
    dataDir: "/tmp/kokpit-test",
    bufferBytes: 1024 * 1024,
    shell: "/bin/sh",
    shellArgs: [],
    branchPrefix: "kokpit/",
    baseBranch: null,
    authTimeoutMs: 200,
    tailscaleRescanMs: 60_000,
    listenLocalhost: true,
    listenTailscale: false,
    tailscaleCidrs: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"],
    key: TEST_KEY,
    projects: [],
    ...overrides,
  };
}

export function makeProjects(): Project[] {
  return [
    { id: BUILTIN_PROJECT_ID, name: "Mac mini", location: { kind: "local", path: "/Users/test" }, builtin: true },
    { id: "p1", name: "Proje 1", location: { kind: "local", path: "/repos/p1" }, defaultToolId: "claude" },
    { id: "p2", name: "Proje 2", location: { kind: "local", path: "/repos/p2" } },
    { id: "ps", name: "Sunucu", location: { kind: "ssh", hostId: "oracle", path: "/srv/app" } },
  ];
}

export function makeHosts(): SshHost[] {
  return [
    { id: "oracle", name: "oracle", hostname: "oracle", source: "ssh-config" },
    {
      id: "h1",
      name: "Kutu",
      hostname: "10.0.0.5",
      user: "ubuntu",
      port: 2222,
      identityFile: "id_ed25519",
      source: "kokpit",
    },
  ];
}

export function makeTools(): Tool[] {
  return [
    {
      id: "claude",
      name: "Claude",
      command: "claude",
      installCommand: "npm i -g claude",
      checkCommand: "command -v claude",
    },
    { id: "codex", name: "Codex", command: "codex" },
  ];
}

export function makeCard(id: string, projectId = "p1"): Card {
  return {
    id,
    projectId,
    name: id,
    branch: `kokpit/${id}`,
    worktreePath: `/wt/${id}`,
    createdAt: T0,
  };
}

/** Records calls; `nextError` makes the next mutating call throw it. */
class Recorder {
  calls: { method: string; args: unknown[] }[] = [];
  nextError: Error | undefined;
  protected rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }
  protected throwIfArmed(): void {
    const e = this.nextError;
    if (e) {
      this.nextError = undefined;
      throw e;
    }
  }
  called(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }
}

export class FakeStore implements StateStore {
  projects = new Map<string, Project>();
  hosts = new Map<string, SshHost>();
  tools = new Map<string, Tool>();
  cards = new Map<string, Card>();
  terminals = new Map<string, TerminalInfo>();
  seeded = new Set<string>();
  listProjects(): Project[] {
    return [...this.projects.values()];
  }
  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }
  upsertProject(p: Project): void {
    this.projects.set(p.id, p);
  }
  removeProject(id: string): void {
    this.projects.delete(id);
  }
  listSshHosts(): SshHost[] {
    return [...this.hosts.values()];
  }
  getSshHost(id: string): SshHost | undefined {
    return this.hosts.get(id);
  }
  upsertSshHost(h: SshHost): void {
    this.hosts.set(h.id, h);
  }
  removeSshHost(id: string): void {
    this.hosts.delete(id);
  }
  listTools(): Tool[] {
    return [...this.tools.values()];
  }
  getTool(id: string): Tool | undefined {
    return this.tools.get(id);
  }
  upsertTool(t: Tool): void {
    this.tools.set(t.id, t);
  }
  removeTool(id: string): void {
    this.tools.delete(id);
  }
  listCards(projectId?: string): Card[] {
    return [...this.cards.values()].filter((c) => projectId === undefined || c.projectId === projectId);
  }
  getCard(cardId: string): Card | undefined {
    return this.cards.get(cardId);
  }
  addCard(card: Card): void {
    this.cards.set(card.id, card);
  }
  removeCard(cardId: string): void {
    this.cards.delete(cardId);
  }
  listTerminals(filter: { cardId?: string; projectId?: string } = {}): TerminalInfo[] {
    return [...this.terminals.values()].filter(
      (t) =>
        (filter.cardId === undefined || t.cardId === filter.cardId) &&
        (filter.projectId === undefined || t.projectId === filter.projectId),
    );
  }
  getTerminal(terminalId: string): TerminalInfo | undefined {
    return this.terminals.get(terminalId);
  }
  upsertTerminal(terminal: TerminalInfo): void {
    this.terminals.set(terminal.id, terminal);
  }
  removeTerminal(terminalId: string): void {
    this.terminals.delete(terminalId);
  }
  settings: StoredSettings = {};
  getSettings(): StoredSettings {
    return { ...this.settings };
  }
  updateSettings(patch: StoredSettings): void {
    this.settings = { ...this.settings, ...patch };
  }
  isSeeded(key: string): boolean {
    return this.seeded.has(key);
  }
  markSeeded(key: string): void {
    this.seeded.add(key);
  }
}

export class FakeProjects extends Recorder implements ProjectService {
  items = new Map<string, Project>(makeProjects().map((p) => [p.id, p]));
  /** What main.ts wires: closes the project's terminals before the record goes. */
  onBeforeDelete: ((projectId: string) => void) | undefined;
  private seq = 0;
  async init(): Promise<void> {
    this.rec("init");
  }
  list(): Project[] {
    this.rec("list");
    return [...this.items.values()];
  }
  get(projectId: string): Project | undefined {
    return this.items.get(projectId);
  }
  async create(input: ParamsOf<"projects.create">): Promise<Project> {
    this.rec("create", input);
    this.throwIfArmed();
    const id = `np${++this.seq}`;
    const location: Project["location"] =
      input.location.kind === "github" ? { ...input.location, path: `/data/repos/${id}` } : input.location;
    const p: Project = {
      id,
      name: input.name,
      location,
      ...(input.defaultToolId !== undefined ? { defaultToolId: input.defaultToolId } : {}),
    };
    this.items.set(id, p);
    return p;
  }
  update(input: ParamsOf<"projects.update">): Project {
    this.rec("update", input);
    this.throwIfArmed();
    const cur = this.items.get(input.projectId);
    if (!cur) throw new EngineError("NOT_FOUND", `project ${input.projectId} not found`);
    const next: Project = { ...cur, ...(input.name !== undefined ? { name: input.name } : {}) };
    if (input.defaultToolId === null) delete next.defaultToolId;
    else if (input.defaultToolId !== undefined) next.defaultToolId = input.defaultToolId;
    this.items.set(next.id, next);
    return next;
  }
  delete(projectId: string): void {
    this.rec("delete", projectId);
    this.throwIfArmed();
    const p = this.items.get(projectId);
    if (!p) throw new EngineError("NOT_FOUND", `project ${projectId} not found`);
    if (p.builtin) throw new EngineError("INVALID", "yerleşik proje silinemez");
    this.onBeforeDelete?.(projectId);
    this.items.delete(projectId);
  }
}

export class FakeSshHosts extends Recorder implements SshHostService {
  items = new Map<string, SshHost>(makeHosts().map((h) => [h.id, h]));
  keys = ["id_ed25519", "work_rsa"];
  private seq = 0;
  list(): SshHost[] {
    this.rec("list");
    return [...this.items.values()];
  }
  get(hostId: string): SshHost | undefined {
    return this.items.get(hostId);
  }
  create(input: ParamsOf<"sshHosts.create">): SshHost {
    this.rec("create", input);
    this.throwIfArmed();
    const h: SshHost = { id: `nh${++this.seq}`, ...input, source: "kokpit" };
    this.items.set(h.id, h);
    return h;
  }
  update(input: ParamsOf<"sshHosts.update">): SshHost {
    this.rec("update", input);
    this.throwIfArmed();
    const cur = this.items.get(input.hostId);
    if (!cur) throw new EngineError("NOT_FOUND", `host ${input.hostId} not found`);
    const next: SshHost = { ...cur, ...(input.name !== undefined ? { name: input.name } : {}) };
    this.items.set(next.id, next);
    return next;
  }
  delete(hostId: string): void {
    this.rec("delete", hostId);
    this.throwIfArmed();
    const h = this.items.get(hostId);
    if (!h) throw new EngineError("NOT_FOUND", `host ${hostId} not found`);
    if (h.source === "ssh-config") throw new EngineError("INVALID", "ssh config sunucusu silinemez");
    this.items.delete(hostId);
  }
  listKeys(): string[] {
    this.rec("listKeys");
    return [...this.keys];
  }
}

export class FakeTools extends Recorder implements ToolService {
  items = new Map<string, Tool>(makeTools().map((t) => [t.id, t]));
  private seq = 0;
  init(): void {
    this.rec("init");
  }
  list(): Tool[] {
    this.rec("list");
    return [...this.items.values()];
  }
  get(toolId: string): Tool | undefined {
    return this.items.get(toolId);
  }
  create(input: ParamsOf<"tools.create">): Tool {
    this.rec("create", input);
    this.throwIfArmed();
    const t: Tool = { id: `nt${++this.seq}`, ...input };
    this.items.set(t.id, t);
    return t;
  }
  update(input: ParamsOf<"tools.update">): Tool {
    this.rec("update", input);
    this.throwIfArmed();
    const cur = this.items.get(input.toolId);
    if (!cur) throw new EngineError("NOT_FOUND", `tool ${input.toolId} not found`);
    const next: Tool = { ...cur, ...(input.name !== undefined ? { name: input.name } : {}) };
    this.items.set(next.id, next);
    return next;
  }
  delete(toolId: string): void {
    this.rec("delete", toolId);
    this.throwIfArmed();
    if (!this.items.delete(toolId)) throw new EngineError("NOT_FOUND", `tool ${toolId} not found`);
  }
  async check(): Promise<ToolStatus[]> {
    this.rec("check");
    this.throwIfArmed();
    return [...this.items.values()].map((t) => ({ toolId: t.id, installed: t.checkCommand ? true : null }));
  }
}

/** Holds the global default tool as-is (no existence check on get, so the server's own check is tested). */
export class FakeSettings extends Recorder implements SettingsService {
  value: Settings = {};
  /** Tool lookup for update's NOT_FOUND, like the real service. */
  private readonly tools: { get(toolId: string): Tool | undefined };
  constructor(tools: { get(toolId: string): Tool | undefined }) {
    super();
    this.tools = tools;
  }
  init(): void {
    this.rec("init");
  }
  get(): Settings {
    this.rec("get");
    return { ...this.value };
  }
  update(input: ParamsOf<"settings.update">): Settings {
    this.rec("update", input);
    this.throwIfArmed();
    const id = input.defaultToolId;
    if (id != null && !this.tools.get(id)) throw new EngineError("NOT_FOUND", "araç bulunamadı");
    const tool = id === undefined ? this.value.defaultToolId : (id ?? undefined);
    this.value = tool !== undefined ? { defaultToolId: tool } : {};
    return { ...this.value };
  }
}

/** Stand-in for launch.ts: records every input, returns a recognisable LaunchSpec. */
export class FakeLaunch {
  inputs: LaunchInput[] = [];
  nextError: Error | undefined;
  readonly resolve = (input: LaunchInput): LaunchSpec => {
    this.inputs.push(input);
    const e = this.nextError;
    if (e) {
      this.nextError = undefined;
      throw e;
    }
    const cmd = input.command ?? input.tool?.command;
    return {
      file: input.host ? "/usr/bin/ssh" : "/bin/sh",
      args: [],
      cwd: input.card?.worktreePath ?? projectCwd(input.project),
      ...(cmd !== undefined ? { initialInput: `${cmd}\r` } : {}),
      title: cmd ?? "shell",
    };
  };
}

function projectCwd(p: Project): string {
  return p.location.kind === "ssh" ? "/" : (p.location.path ?? "/");
}

export class FakeCards extends Recorder implements CardService {
  private seq = 0;
  private readonly store: FakeStore;
  constructor(store: FakeStore) {
    super();
    this.store = store;
  }
  list(projectId: string): Card[] {
    this.rec("list", projectId);
    return this.store.listCards(projectId);
  }
  async create(projectId: string, name: string): Promise<Card> {
    this.rec("create", projectId, name);
    this.throwIfArmed();
    const card = { ...makeCard(`c${++this.seq}`, projectId), name };
    this.store.addCard(card);
    return card;
  }
  async delete(cardId: string): Promise<void> {
    this.rec("delete", cardId);
    this.throwIfArmed();
    if (!this.store.getCard(cardId)) throw new EngineError("NOT_FOUND", `card ${cardId} not found`);
    this.store.removeCard(cardId);
  }
}

interface FakeTerminal {
  info: TerminalInfo;
  history: string;
  listeners: Set<TerminalListener>;
}

type Target = { projectId: string; cardId?: string; toolId?: string };

/** Fake pty: emits only what the test pushes via emit()/exit(); records every call. */
export class FakePtys implements PtyManager {
  calls: { method: string; args: unknown[] }[] = [];
  terminals = new Map<string, FakeTerminal>();
  /** If set, write/resize throw this. */
  ioError: Error | undefined;
  private seq = 0;

  open(target: Target, launch: LaunchSpec, opts: { cols: number; rows: number }): TerminalInfo {
    this.calls.push({ method: "open", args: [target, launch, opts] });
    const info: TerminalInfo = {
      id: `t${++this.seq}`,
      ...target,
      title: launch.title,
      status: "running",
      createdAt: T0,
    };
    this.terminals.set(info.id, { info, history: "", listeners: new Set() });
    return info;
  }
  /** Test helper: a running terminal opened outside the server. */
  add(target: Target): TerminalInfo {
    const info: TerminalInfo = { id: `t${++this.seq}`, ...target, title: "shell", status: "running", createdAt: T0 };
    this.terminals.set(info.id, { info, history: "", listeners: new Set() });
    return info;
  }
  /** Test helper: a terminal that already exists (e.g. restored), with history. */
  seed(info: TerminalInfo, history = ""): void {
    this.terminals.set(info.id, { info, history, listeners: new Set() });
  }
  list(filter: { cardId?: string; projectId?: string }): TerminalInfo[] {
    this.calls.push({ method: "list", args: [filter] });
    return [...this.terminals.values()]
      .map((t) => t.info)
      .filter(
        (i) =>
          (filter.cardId === undefined || i.cardId === filter.cardId) &&
          (filter.projectId === undefined || i.projectId === filter.projectId),
      );
  }
  get(terminalId: string): TerminalInfo | undefined {
    return this.terminals.get(terminalId)?.info;
  }
  history(terminalId: string): string {
    this.calls.push({ method: "history", args: [terminalId] });
    return this.terminals.get(terminalId)?.history ?? "";
  }
  write(terminalId: string, data: string): void {
    this.calls.push({ method: "write", args: [terminalId, data] });
    if (this.ioError) throw this.ioError;
    if (!this.terminals.has(terminalId)) throw new EngineError("NOT_FOUND", "no terminal");
  }
  resize(terminalId: string, cols: number, rows: number): void {
    this.calls.push({ method: "resize", args: [terminalId, cols, rows] });
    if (this.ioError) throw this.ioError;
    if (!this.terminals.has(terminalId)) throw new EngineError("NOT_FOUND", "no terminal");
  }
  close(terminalId: string): void {
    this.calls.push({ method: "close", args: [terminalId] });
    this.terminals.delete(terminalId);
  }
  closeAllForCard(cardId: string): void {
    this.calls.push({ method: "closeAllForCard", args: [cardId] });
    for (const [id, t] of this.terminals) if (t.info.cardId === cardId) this.terminals.delete(id);
  }
  closeAllForProject(projectId: string): void {
    this.calls.push({ method: "closeAllForProject", args: [projectId] });
    for (const [id, t] of this.terminals) if (t.info.projectId === projectId) this.terminals.delete(id);
  }
  subscribe(terminalId: string, listener: TerminalListener): () => void {
    this.calls.push({ method: "subscribe", args: [terminalId] });
    const t = this.terminals.get(terminalId);
    if (!t) throw new EngineError("NOT_FOUND", "no terminal");
    t.listeners.add(listener);
    return () => {
      t.listeners.delete(listener);
    };
  }
  async shutdown(): Promise<void> {
    this.calls.push({ method: "shutdown", args: [] });
  }

  /** Test helper: the pty produced output (appended to history, sent to live listeners). */
  emit(terminalId: string, data: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`fake: no terminal ${terminalId}`);
    t.history += data;
    for (const l of [...t.listeners]) l.onData(data);
  }
  /** Test helper: the process exited. */
  exit(terminalId: string, exitCode: number | null): void {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`fake: no terminal ${terminalId}`);
    t.info = { ...t.info, status: "exited", exitCode };
    for (const l of [...t.listeners]) l.onExit(exitCode);
  }
  listenerCount(terminalId: string): number {
    return this.terminals.get(terminalId)?.listeners.size ?? 0;
  }
  called(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }
}

export interface LogEntry {
  level: "info" | "warn" | "error";
  msg: string;
  extra?: Record<string, unknown>;
}

export class FakeLogger implements Logger {
  entries: LogEntry[] = [];
  info(msg: string, extra?: Record<string, unknown>): void {
    this.entries.push({ level: "info", msg, ...(extra ? { extra } : {}) });
  }
  warn(msg: string, extra?: Record<string, unknown>): void {
    this.entries.push({ level: "warn", msg, ...(extra ? { extra } : {}) });
  }
  error(msg: string, extra?: Record<string, unknown>): void {
    this.entries.push({ level: "error", msg, ...(extra ? { extra } : {}) });
  }
  /** Everything logged, serialised — for "never logs the key" assertions. */
  dump(): string {
    return JSON.stringify(this.entries, (_k, v: unknown) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
  }
}
