// File-backed StateStore. The whole state lives in one JSON file that is
// rewritten atomically (temp file + fsync + rename) on every mutation, before
// the mutating method returns.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { PRIVATE_FILE_MODE } from "./fs-safety.ts";
import { dirname } from "node:path";
import { z } from "zod";
import {
  BROWSER_LIMITS,
  CardSchema,
  ClaudeAccountSchema,
  ProjectSchema,
  SavedLoginSchema,
  SshHostSchema,
  TerminalInfoSchema,
  TodoSchema,
  ToolSchema,
  isDateKey,
  NOTE_TEXT_MAX,
  type Card,
  type Project,
  type SavedLogin,
  type SshHost,
  type TerminalInfo,
  type Todo,
  type Tool,
} from "@kokpit/shared";
import {
  EngineError,
  type BrowserExtensionStore,
  type BrowserPortStore,
  type BrowserZoomStore,
  type ClaudeSettingsStore,
  type KeychainItemRef,
  type Logger,
  type LoginStore,
  type ManagedClaudeSettings,
  type StateStore,
  type StoredSettings,
  type TodoStore,
} from "./contracts.ts";
import { KEYCHAIN_WORD } from "./logins-config.ts";

const STATE_VERSION = 2;

type WithId = { id: string };

function uniqueIds(ctx: z.RefinementCtx, lists: Record<string, readonly WithId[]>): void {
  for (const [name, list] of Object.entries(lists)) {
    const ids = new Set<string>();
    for (const x of list) {
      if (ids.has(x.id)) ctx.addIssue({ code: "custom", path: [name], message: `duplicate id ${x.id}` });
      ids.add(x.id);
    }
  }
}

const StoredSettingsSchema = z
  .object({
    defaultToolId: z.string().min(1).max(200).nullable().optional(),
    // ---- İş H: Claude hesapları ----
    claudeAccounts: z
      .array(ClaudeAccountSchema)
      .superRefine((claudeAccounts, ctx) => uniqueIds(ctx, { claudeAccounts }))
      .optional(),
  })
  .strict();

// ---- todos ----
const NoteDate = z.string().refine(isDateKey, "YYYY-MM-DD expected");
const NotesSchema = z.record(NoteDate, z.string().min(1).max(NOTE_TEXT_MAX));
const TodoListSchema = z.array(TodoSchema).superRefine((todos, ctx) => uniqueIds(ctx, { todos }));

// ---- tarayıcı (İş B) ----
const ExtensionDirsSchema = z
  .array(z.string().min(1).max(BROWSER_LIMITS.maxExtensionPathLength).refine((p) => p.startsWith("/"), "absolute path expected"))
  .max(BROWSER_LIMITS.maxExtensions)
  .refine((l) => new Set(l).size === l.length, "duplicate folder");
const BrowserExtensionsSchema = z.record(z.string().min(1).max(200), ExtensionDirsSchema);

// ---- Adım 9 İş A ---- projectId → DevTools port; projectId → what the engine wrote into the Claude settings file
const ProjectKey = z.string().min(1).max(200);
const BrowserPortSchema = z.number().int().min(1024).max(65535);
const BrowserPortsSchema = z.record(ProjectKey, BrowserPortSchema);
// ---- tarayıcı yakınlaştırması ---- projectId → the user's zoom; null = the user chose the configured default
const BrowserZoomSchema = z.number().min(BROWSER_LIMITS.minZoom).max(BROWSER_LIMITS.maxZoom);
const BrowserZoomsSchema = z.record(ProjectKey, BrowserZoomSchema.nullable());
const ManagedClaudeSettingsSchema = z
  .object({
    file: z.string().min(1).max(BROWSER_LIMITS.maxExtensionPathLength).refine((p) => p.startsWith("/"), "absolute path expected"),
    env: z.record(z.string().min(1).max(200), z.string().max(BROWSER_LIMITS.maxExtensionPathLength)),
    createdFile: z.boolean().optional(),
    createdDir: z.boolean().optional(),
  })
  .strict();
const ClaudeBrowserSettingsSchema = z.record(ProjectKey, ManagedClaudeSettingsSchema);
// ---- girişler ---- metadata of the saved logins (the passwords are in the Keychain, never here), and Keychain
// items of deleted projects that could not be deleted yet
const LoginListSchema = z.array(SavedLoginSchema).superRefine((logins, ctx) => uniqueIds(ctx, { logins }));
const KeychainWord = z.string().min(1).max(500).regex(KEYCHAIN_WORD);
const LoginRiskSchema = z.array(ProjectKey).max(10_000);
const LoginOrphansSchema = z.array(z.object({ service: KeychainWord, account: KeychainWord }).strict()).max(10_000);


const StateFileSchema = z
  .object({
    version: z.literal(STATE_VERSION),
    projects: z.array(ProjectSchema),
    sshHosts: z.array(SshHostSchema),
    tools: z.array(ToolSchema),
    cards: z.array(CardSchema),
    terminals: z.array(TerminalInfoSchema),
    seeded: z.array(z.string()),
    /** Absent in v2 files written before settings existed. */
    settings: StoredSettingsSchema.default({}),
    // ---- todos ---- (absent in v2 files written before Adım 6, and whenever empty)
    todos: z.array(TodoSchema).default([]),
    notes: NotesSchema.default({}),
    // ---- tarayıcı (İş B) ---- projectId → unpacked-extension folders (absent when none)
    browserExtensions: BrowserExtensionsSchema.default({}),
    // ---- Adım 9 İş A ---- (absent in files written before it, and whenever empty)
    browserPorts: BrowserPortsSchema.default({}),
    claudeBrowserSettings: ClaudeBrowserSettingsSchema.default({}),
    // ---- tarayıcı yakınlaştırması ---- (absent in files written before the engine owned the zoom, and whenever empty)
    browserZooms: BrowserZoomsSchema.default({}),
    // ---- girişler ---- (absent in files written before it, and whenever empty)
    logins: z.array(SavedLoginSchema).default([]),
    loginOrphans: LoginOrphansSchema.default([]),
    /** Projects in which the user accepted the agent risk of filling a login. */
    loginRiskAccepted: LoginRiskSchema.default([]),
  })
  .superRefine((s, ctx) =>
    uniqueIds(ctx, {
      projects: s.projects,
      sshHosts: s.sshHosts,
      tools: s.tools,
      cards: s.cards,
      terminals: s.terminals,
      todos: s.todos,
      logins: s.logins,
    }),
  );

/** v1: cards + card terminals only; terminals had no projectId. */
const V1TerminalSchema = TerminalInfoSchema.omit({ projectId: true }).extend({ cardId: z.string().min(1) });
const V1FileSchema = z
  .object({ version: z.literal(1), cards: z.array(CardSchema), terminals: z.array(V1TerminalSchema) })
  .superRefine((s, ctx) => uniqueIds(ctx, { cards: s.cards, terminals: s.terminals }));

export interface State {
  projects: Project[];
  sshHosts: SshHost[];
  tools: Tool[];
  cards: Card[];
  terminals: TerminalInfo[];
  seeded: string[];
  settings: StoredSettings;
  todos: Todo[];
  notes: Record<string, string>;
  browserExtensions: Record<string, string[]>;
  browserPorts: Record<string, number>;
  claudeBrowserSettings: Record<string, ManagedClaudeSettings>;
  browserZooms: Record<string, number | null>;
  logins: SavedLogin[];
  loginOrphans: KeychainItemRef[];
  loginRiskAccepted: string[];
}

/** Everything the file store implements. */
export type EngineStore = StateStore & TodoStore & BrowserExtensionStore & BrowserPortStore & ClaudeSettingsStore & BrowserZoomStore & LoginStore;

const emptyState = (): State => ({
  projects: [],
  sshHosts: [],
  tools: [],
  cards: [],
  terminals: [],
  seeded: [],
  settings: {},
  todos: [],
  notes: {},
  browserExtensions: {},
  browserPorts: {},
  claudeBrowserSettings: {},
  browserZooms: {},
  logins: [],
  loginOrphans: [],
  loginRiskAccepted: [],
});

let tmpCounter = 0;

function fsyncDir(dir: string): void {
  // Best effort: makes the rename durable; not supported on every platform/fs.
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* ignore */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Writes `content` to a temp file beside `file` (created with `mode`), fsyncs it and renames it over `file`. */
export function writeAtomic(file: string, content: string, mode = PRIVATE_FILE_MODE): void {
  const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`;
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp may not exist */
    }
    throw e;
  }
  fsyncDir(dirname(file));
}

function moveAside(file: string, logger: Logger, reason: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let target = `${file}.corrupt-${stamp}`;
  for (let n = 1; existsSync(target); n++) target = `${file}.corrupt-${stamp}-${n}`;
  renameSync(file, target);
  logger.warn("state file unreadable; moved aside, starting empty", { file, movedTo: target, reason });
}

function migrateV1(v1: z.infer<typeof V1FileSchema>, logger: Logger): State {
  const cardProject = new Map(v1.cards.map((c) => [c.id, c.projectId]));
  const terminals: TerminalInfo[] = [];
  const dropped: string[] = [];
  for (const t of v1.terminals) {
    const projectId = cardProject.get(t.cardId);
    if (projectId === undefined) dropped.push(t.id);
    else terminals.push({ ...t, projectId });
  }
  if (dropped.length > 0) {
    logger.warn("state v1 migration: dropped terminals whose card is missing", { terminalIds: dropped });
  }
  return { ...emptyState(), cards: v1.cards, terminals };
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.map(String).join(".") || "(root)"}: ${issue?.message ?? "invalid"}`;
}

/** Reads the state file. `migrated` = it was a v1 file and must be rewritten as v2. */
function load(file: string, logger: Logger): { state: State; migrated: boolean } {
  const empty = { state: emptyState(), migrated: false };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    moveAside(file, logger, `invalid JSON: ${(e as Error).message}`);
    return empty;
  }
  if (raw !== null && typeof raw === "object" && (raw as { version?: unknown }).version === 1) {
    const v1 = V1FileSchema.safeParse(raw);
    if (!v1.success) {
      moveAside(file, logger, `v1: ${describeIssue(v1.error)}`);
      return empty;
    }
    return { state: migrateV1(v1.data, logger), migrated: true };
  }
  const r = StateFileSchema.safeParse(raw);
  if (!r.success) {
    moveAside(file, logger, describeIssue(r.error));
    return empty;
  }
  const { version: _v, ...state } = r.data;
  return { state, migrated: false };
}

function validate<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new EngineError("INVALID", `invalid ${what}: ${issue?.path.map(String).join(".")}: ${issue?.message}`);
  }
  return r.data;
}

const copy = <T>(v: T): T => structuredClone(v);

function upsertById<T extends WithId>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

/**
 * The StateStore logic over an in-memory State. `persist` runs with the next state before it
 * replaces the current one, so a failed write leaves memory unchanged.
 */
function createStore(initial: State, persist: (next: State) => void): EngineStore {
  let state = initial;
  const commit = (next: State) => {
    persist(next);
    state = next;
  };
  const find = <T extends WithId>(list: readonly T[], id: string): T | undefined => {
    const x = list.find((y) => y.id === id);
    return x && copy(x);
  };
  const without = <K extends Exclude<keyof State, "seeded" | "settings" | "notes" | "browserExtensions" | "browserPorts" | "claudeBrowserSettings" | "browserZooms" | "loginOrphans" | "loginRiskAccepted">>(key: K, id: string) => {
    const list = state[key] as readonly WithId[];
    if (!list.some((x) => x.id === id)) return;
    commit({ ...state, [key]: list.filter((x) => x.id !== id) });
  };

  return {
    listProjects: () => state.projects.map(copy),
    getProject: (id) => find(state.projects, id),
    upsertProject: (project) => {
      const p = validate(ProjectSchema, project, "project");
      commit({ ...state, projects: upsertById(state.projects, p) });
    },
    removeProject: (id) => without("projects", id),

    listSshHosts: () => state.sshHosts.map(copy),
    getSshHost: (id) => find(state.sshHosts, id),
    upsertSshHost: (host) => {
      const h = validate(SshHostSchema, host, "ssh host");
      if (h.source !== "kokpit") throw new EngineError("INVALID", `only Kokpit hosts are stored, not ${h.source}`);
      commit({ ...state, sshHosts: upsertById(state.sshHosts, h) });
    },
    removeSshHost: (id) => without("sshHosts", id),

    listTools: () => state.tools.map(copy),
    getTool: (id) => find(state.tools, id),
    upsertTool: (tool) => {
      const t = validate(ToolSchema, tool, "tool");
      commit({ ...state, tools: upsertById(state.tools, t) });
    },
    removeTool: (id) => without("tools", id),

    listCards: (projectId) =>
      state.cards.filter((c) => projectId === undefined || c.projectId === projectId).map(copy),
    getCard: (id) => find(state.cards, id),
    addCard: (card) => {
      const c = validate(CardSchema, card, "card");
      if (state.cards.some((x) => x.id === c.id)) throw new EngineError("INVALID", `card ${c.id} already exists`);
      commit({ ...state, cards: [...state.cards, c] });
    },
    removeCard: (id) => without("cards", id),

    listTerminals: (filter = {}) =>
      state.terminals
        .filter(
          (t) =>
            (filter.cardId === undefined || t.cardId === filter.cardId) &&
            (filter.projectId === undefined || t.projectId === filter.projectId),
        )
        .map(copy),
    getTerminal: (id) => find(state.terminals, id),
    upsertTerminal: (terminal) => {
      const t = validate(TerminalInfoSchema, terminal, "terminal");
      commit({ ...state, terminals: upsertById(state.terminals, t) });
    },
    removeTerminal: (id) => without("terminals", id),

    getSettings: () => copy(state.settings),
    updateSettings: (patch) => {
      const next = validate(StoredSettingsSchema, { ...state.settings, ...patch }, "settings");
      commit({ ...state, settings: next });
    },

    isSeeded: (key) => state.seeded.includes(key),
    markSeeded: (key) => {
      if (state.seeded.includes(key)) return;
      commit({ ...state, seeded: [...state.seeded, key] });
    },

    // ---- todos ----
    listTodos: () => state.todos.map(copy),
    replaceTodos: (todos) => {
      commit({ ...state, todos: validate(TodoListSchema, todos, "todos") });
    },
    getNotes: () => copy(state.notes),
    setNote: (date, text) => {
      validate(NoteDate, date, "note date");
      const { [date]: _old, ...rest } = state.notes;
      const notes = text === "" ? rest : validate(NotesSchema, { ...rest, [date]: text }, "note");
      commit({ ...state, notes });
    },

    // ---- tarayıcı (İş B) ----
    getBrowserExtensions: (projectId) => [...(state.browserExtensions[projectId] ?? [])],
    setBrowserExtensions: (projectId, dirs) => {
      const { [projectId]: _old, ...rest } = state.browserExtensions;
      const next = dirs.length === 0 ? rest : { ...rest, [projectId]: validate(ExtensionDirsSchema, [...dirs], "extension folders") };
      commit({ ...state, browserExtensions: next });
    },

    // ---- Adım 9 İş A ----
    getBrowserPort: (projectId) => state.browserPorts[projectId],
    listBrowserPorts: () => ({ ...state.browserPorts }),
    setBrowserPort: (projectId, port) => {
      const { [projectId]: _old, ...rest } = state.browserPorts;
      const next = port === undefined ? rest : { ...rest, [projectId]: validate(BrowserPortSchema, port, "browser port") };
      commit({ ...state, browserPorts: next });
    },
    getManagedClaudeSettings: (projectId) => {
      const r = state.claudeBrowserSettings[projectId];
      return r && copy(r);
    },
    listManagedClaudeSettings: () => copy(state.claudeBrowserSettings),
    setManagedClaudeSettings: (projectId, record) => {
      const { [projectId]: _old, ...rest } = state.claudeBrowserSettings;
      const next =
        record === undefined ? rest : { ...rest, [projectId]: validate(ManagedClaudeSettingsSchema, record, "claude settings record") };
      commit({ ...state, claudeBrowserSettings: next });
    },

    // ---- tarayıcı yakınlaştırması ----
    getBrowserZoom: (projectId) => (Object.hasOwn(state.browserZooms, projectId) ? state.browserZooms[projectId] : undefined),
    setBrowserZoom: (projectId, zoom) => {
      const { [projectId]: _old, ...rest } = state.browserZooms;
      const next = zoom === undefined ? rest : { ...rest, [projectId]: zoom === null ? null : validate(BrowserZoomSchema, zoom, "browser zoom") };
      commit({ ...state, browserZooms: next });
    },

    // ---- girişler ----
    listLogins: (projectId) => state.logins.filter((l) => projectId === undefined || l.projectId === projectId).map(copy),
    getLogin: (id) => find(state.logins, id),
    upsertLogin: (login) => {
      const valid = validate(SavedLoginSchema, login, "login");
      commit({ ...state, logins: validate(LoginListSchema, upsertById(state.logins, valid), "logins") });
    },
    removeLogin: (id) => {
      if (state.logins.some((l) => l.id === id)) commit({ ...state, logins: state.logins.filter((l) => l.id !== id) });
    },
    listLoginOrphans: () => state.loginOrphans.map(copy),
    setLoginOrphans: (orphans) => {
      commit({ ...state, loginOrphans: validate(LoginOrphansSchema, orphans, "login orphans") });
    },
    isLoginRiskAccepted: (projectId) => state.loginRiskAccepted.includes(projectId),
    setLoginRiskAccepted: (projectId, accepted) => {
      const rest = state.loginRiskAccepted.filter((id) => id !== projectId);
      const next = accepted ? [...rest, projectId] : rest;
      if (next.length === state.loginRiskAccepted.length && accepted === state.loginRiskAccepted.includes(projectId)) return;
      commit({ ...state, loginRiskAccepted: validate(LoginRiskSchema, next, "login risk") });
    },

  };
}

/** Optional fields are written only when they hold something, so files of users without them keep their shape. */
function withoutEmptyTodos(state: State): Partial<State> {
  const { todos, notes, browserExtensions, browserPorts, claudeBrowserSettings, browserZooms, logins, loginOrphans, loginRiskAccepted, ...rest } = state;
  return {
    ...rest,
    ...(todos.length > 0 ? { todos } : {}),
    ...(Object.keys(notes).length > 0 ? { notes } : {}),
    ...(Object.keys(browserExtensions).length > 0 ? { browserExtensions } : {}),
    ...(Object.keys(browserPorts).length > 0 ? { browserPorts } : {}),
    ...(Object.keys(claudeBrowserSettings).length > 0 ? { claudeBrowserSettings } : {}),
    ...(Object.keys(browserZooms).length > 0 ? { browserZooms } : {}),
    ...(logins.length > 0 ? { logins } : {}),
    ...(loginOrphans.length > 0 ? { loginOrphans } : {}),
    ...(loginRiskAccepted.length > 0 ? { loginRiskAccepted } : {}),
  };
}

/** StateStore without persistence (tests, tooling). Same validation and copy semantics as the file store. */
export function createMemoryStore(): EngineStore {
  return createStore(emptyState(), () => {});
}

/** StateStore backed by one JSON file, rewritten atomically on every mutation. Migrates a v1 file on open. */
export function createFileStore(stateFile: string, logger: Logger): EngineStore {
  const persist = (next: State) =>
    writeAtomic(stateFile, JSON.stringify({ version: STATE_VERSION, ...withoutEmptyTodos(next) }, null, 2) + "\n");
  const { state, migrated } = load(stateFile, logger);
  if (migrated) {
    persist(state);
    logger.info("state file migrated to v2", { file: stateFile });
  }
  return createStore(state, persist);
}
