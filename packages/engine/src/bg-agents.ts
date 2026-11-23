// İş A (Adım 7) — arka plan ajanları. Reads Claude Code's background sessions (`claude agents --json --all`)
// on the engine's machine, only while at least one client is connected, maps each session to the project / card
// whose folder holds its `cwd` (realpath-normalized, longest prefix, cards before projects) and runs
// `claude logs|stop <id>` for the UI. `claude attach <id>` runs in a normal terminal (see handlers/bgagents.ts).
// Every call goes through execFile (no shell), time- and size-limited.
//
// Observed CLI behaviour (claude agents --json --all, 2026-11):
// - A JSON array of { id, cwd, kind: "background", startedAt: <ms epoch>, sessionId, name, state, pid?, status? }.
// - `state` is "done" | "blocked" | "working"; live processes also carry `status` "idle" | "busy".
//   The brief also names "idle" / "busy" as states; both spellings are mapped.
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { st, type Params, type SharedKey } from "@kokpit/shared/i18n";
import { z } from "zod";
import {
  BG_AGENT_ID_RE,
  projectGitPath,
  type BgAgentSession,
  type BgAgentState,
  type BgAgentWaitingReason,
  type Card,
  type Project,
} from "@kokpit/shared";
import { scanOutput } from "./activity.ts";
import { CLAUDE_CONFIG_ENV, type AccountDir } from "./claude-accounts.ts";
import { EngineError, engineError, type Logger } from "./contracts.ts";
import { execCapped, type ProcessRunner, type RunResult } from "./exec-runner.ts";
import { quoteShellArg } from "./launch.ts";

// ---------- parsing ----------

/** One CLI session, normalized; extra fields dropped. */
export interface RawAgent {
  id: string;
  name: string;
  cwd: string;
  state: string;
  kind?: string;
  status?: string;
  /** ISO time. */
  startedAt?: string;
}

const MAX_ID_LEN = 200;
const MAX_NAME_LEN = 500;
const MAX_PATH_LEN = 4096;

const optStr = (max: number) => z.string().max(max).optional().catch(undefined);

const RawEntry = z.object({
  id: z.string().min(1).max(MAX_ID_LEN).regex(BG_AGENT_ID_RE),
  cwd: z.string().min(1).max(MAX_PATH_LEN).refine((p) => p.startsWith("/")),
  state: z.string().min(1).max(MAX_ID_LEN),
  name: optStr(MAX_NAME_LEN),
  kind: optStr(MAX_ID_LEN),
  status: optStr(MAX_ID_LEN),
  startedAt: z.union([z.number(), z.string()]).optional().catch(undefined),
});


function isoTime(v: number | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Parses `claude agents --json` output; bad entries are skipped, a bad document throws CLAUDE_FAILED. */
export function parseAgents(text: string): RawAgent[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw engineError("CLAUDE_FAILED", "engine.bgAgents.unexpected");
  }
  if (!Array.isArray(data)) throw engineError("CLAUDE_FAILED", "engine.bgAgents.unexpected");
  const out: RawAgent[] = [];
  for (const item of data) {
    const r = RawEntry.safeParse(item);
    if (!r.success) continue;
    const e = r.data;
    const startedAt = isoTime(e.startedAt);
    out.push({
      id: e.id,
      name: e.name?.trim() || e.id,
      cwd: e.cwd,
      state: e.state,
      ...(e.kind !== undefined ? { kind: e.kind } : {}),
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    });
  }
  return out;
}

// ---------- mapping ----------

export interface Target {
  /** Normalized folder. */
  path: string;
  projectId: string;
  cardId?: string;
}

export interface Match {
  projectId: string;
  cardId?: string;
}

const isUnder = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/** Card worktrees first, then project folders; within each, the longest folder holding `path` wins. */
export function matchTarget(path: string, targets: readonly Target[]): Match | undefined {
  for (const cards of [true, false]) {
    let best: Target | undefined;
    for (const t of targets) {
      if ((t.cardId !== undefined) !== cards || !isUnder(path, t.path)) continue;
      if (!best || t.path.length > best.path.length) best = t;
    }
    if (best) return { projectId: best.projectId, ...(best.cardId !== undefined ? { cardId: best.cardId } : {}) };
  }
  return undefined;
}

/** realpath; for a missing path, the realpath of its nearest existing parent plus the rest. */
export function normalizePath(p: string, realpath: (p: string) => string = realpathSync.native): string {
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return rest.length === 0 ? realpath(head) : join(realpath(head), ...rest.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      rest.push(head.slice(parent === "/" ? 1 : parent.length + 1));
      head = parent;
    }
  }
}

/** Folders of local/github projects and of cards (ssh projects have no folder here). */
export function buildTargets(projects: readonly Project[], cards: readonly Card[], normalize: (p: string) => string): Target[] {
  const targets: Target[] = [];
  for (const p of projects) {
    const path = projectGitPath(p);
    if (path) targets.push({ path: normalize(path), projectId: p.id });
  }
  for (const c of cards) targets.push({ path: normalize(c.worktreePath), projectId: c.projectId, cardId: c.id });
  return targets;
}

function mapState(a: RawAgent): { state: BgAgentState; waitingReason?: BgAgentWaitingReason } {
  switch (a.state) {
    case "blocked":
      return { state: "waiting", waitingReason: "approval" };
    case "idle":
      return { state: "waiting", waitingReason: "input" };
    case "done":
      return { state: "done" };
    case "working":
      // A live session whose turn ended (`status: "idle"`) waits for the user; the CLI shows it as "awaiting input".
      return a.status === "idle" ? { state: "waiting", waitingReason: "input" } : { state: "running" };
    default: // busy, anything new
      return { state: "running" };
  }
}

/** Wire session for one CLI entry; undefined for interactive sessions (those already run in a terminal). */
export function mapSession(a: RawAgent, targets: readonly Target[], normalize: (p: string) => string = (p) => p): BgAgentSession | undefined {
  if (a.kind !== undefined && a.kind !== "background") return undefined;
  const match = matchTarget(normalize(a.cwd), targets);
  return {
    id: a.id,
    name: a.name,
    ...mapState(a),
    ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
    cwd: a.cwd,
    ...(match ?? {}),
  };
}

// ---------- service ----------

export interface BgAgentsOptions {
  /** `claude` executable (PATH name or absolute path). */
  claudeBinary: string;
  /** Poll interval while clients are connected; 0 disables the feature (no CLI calls, empty list). */
  pollMs: number;
  /**
   * Performans: while the list stays the same the wait between polls doubles up to this (a change or a new client
   * makes it `pollMs` again). Absent or ≤ pollMs = always `pollMs`.
   */
  idlePollMaxMs?: number;
  timeoutMs: number;
  /** Cap on stdout/stderr bytes of one call. */
  maxOutputBytes: number;
  /** Max characters of `logs` text returned (the newest are kept). */
  logsMaxChars: number;
  logger: Logger;
  projects: { list(): Project[] };
  cards: { list(): Card[] };
  /** Project for sessions that match none (the built-in "Mac mini" project). */
  builtinProjectId?: string;
  run?: ProcessRunner;
  realpath?: (p: string) => string;
  /**
   * İş H: Claude account config dirs; `claude agents` runs once per dir (the default one without CLAUDE_CONFIG_DIR)
   * and each session is tagged with its account. Absent or empty = one call without the variable.
   */
  accounts?: () => AccountDir[];
}

export interface BgAgentsSnapshot {
  sessions: BgAgentSession[];
  error?: string;
}

export interface BgAgentsService {
  /** Number of authenticated clients; polling runs while it is above zero. */
  setClientCount(n: number): void;
  /** The current list; runs a first read when there is none yet. */
  list(): Promise<BgAgentsSnapshot>;
  /** Where `claude attach <id>` opens and the command typed into that terminal. */
  attachTarget(id: string): Promise<Match & { command: string; accountId?: string }>;
  logs(id: string): Promise<{ text: string; truncated: boolean }>;
  stop(id: string): Promise<void>;
  /** Called when the list (or its error) changes. */
  onChange(cb: () => void): () => void;
  /** Project/card holding `cwd` (tests). */
  match(cwd: string): Match | undefined;
  dispose(): void;
}

const MS_PER_S = 1000;
const STDERR_EXCERPT_MAX = 300;

function excerpt(stderr: string): string {
  const last = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return last.length <= STDERR_EXCERPT_MAX ? last : `${last.slice(0, STDERR_EXCERPT_MAX)}…`;
}

function checkId(id: string): string {
  if (typeof id !== "string" || id.length > MAX_ID_LEN || !BG_AGENT_ID_RE.test(id)) {
    throw engineError("INVALID", "engine.bgAgents.badSessionId");
  }
  return id;
}

export function createBgAgentsService(opts: BgAgentsOptions): BgAgentsService {
  const run = opts.run ?? execCapped;
  const normalize = (p: string): string => normalizePath(p, opts.realpath);
  const enabled = opts.pollMs > 0;
  let snapshot: BgAgentsSnapshot | undefined;
  let lastKey: string | undefined;
  let inFlight: Promise<BgAgentsSnapshot> | undefined;
  let timer: NodeJS.Timeout | undefined;
  /** Odd while polling runs; every start/stop moves it on, so a poll that was in flight schedules nothing stale. */
  let generation = 0;
  let delay = opts.pollMs;
  const maxDelay = Math.max(opts.pollMs, opts.idlePollMaxMs ?? opts.pollMs);
  let clients = 0;
  let disposed = false;
  const listeners = new Set<() => void>();

  function failure(r: RunResult): EngineError {
    const fail = (key: SharedKey, params?: Params) => engineError("CLAUDE_FAILED", key, params);
    const line = excerpt(r.stderr);
    if (r.error === "ENOENT") return fail("engine.bgAgents.notFound", { binary: opts.claudeBinary });
    if (r.error === "TIMEOUT") return fail("engine.bgAgents.timeout", { seconds: Math.round(opts.timeoutMs / MS_PER_S) });
    if (r.error === "TOO_BIG") return fail("engine.bgAgents.tooBig");
    if (r.error === "SPAWN") return line ? fail("engine.bgAgents.spawnFailedDetail", { detail: line }) : fail("engine.bgAgents.spawnFailed");
    return line ? fail("engine.bgAgents.failedDetail", { detail: line }) : fail("engine.bgAgents.failedCode", { code: r.code ?? "?" });
  }

  /** İş H: the engine's env without an inherited CLAUDE_CONFIG_DIR, plus the account's when it is not the default. */
  function accountEnv(dir: AccountDir | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[CLAUDE_CONFIG_ENV];
    if (dir && !dir.isDefault) env[CLAUDE_CONFIG_ENV] = dir.configDir;
    return env;
  }

  /** The dirs to read; one default entry when accounts are not in use. */
  function dirs(): (AccountDir | undefined)[] {
    const list = opts.accounts?.() ?? [];
    return list.length > 0 ? list : [undefined];
  }

  /** The account a listed session came from (undefined = default / unknown). */
  function dirOf(id: string): AccountDir | undefined {
    const accountId = snapshot?.sessions.find((s) => s.id === id)?.accountId;
    return accountId === undefined ? undefined : opts.accounts?.().find((d) => d.accountId === accountId);
  }

  async function claude(args: string[], dir?: AccountDir): Promise<string> {
    const r = await run(opts.claudeBinary, args, {
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      env: accountEnv(dir),
    });
    if (r.error === undefined && r.code === 0) return r.stdout;
    const err = failure(r);
    opts.logger.warn("claude failed", { command: args[0], code: r.code, error: r.error, stderr: excerpt(r.stderr) });
    throw err;
  }

  function publish(next: BgAgentsSnapshot): void {
    snapshot = next;
    const key = JSON.stringify(next);
    if (key === lastKey) return;
    lastKey = key;
    if (disposed) return;
    try {
      for (const l of [...listeners]) l();
    } catch (err) {
      opts.logger.warn("bgAgents change listener threw", { error: String(err) });
    }
  }

  /** One account dir: its sessions (tagged), or the error and the last good ones from that dir. */
  async function readDir(dir: AccountDir | undefined): Promise<{ sessions: BgAgentSession[]; error?: string }> {
    const tag = dir ? { accountId: dir.accountId } : {};
    try {
      const raw = parseAgents(await claude(["agents", "--json", "--all"], dir));
      const targets = buildTargets(opts.projects.list(), opts.cards.list(), normalize);
      return { sessions: raw.flatMap((a) => mapSession(a, targets, normalize) ?? []).map((s) => ({ ...s, ...tag })) };
    } catch (err) {
      const message = err instanceof EngineError ? err.message : st("engine.bgAgents.unreadable");
      if (!(err instanceof EngineError)) opts.logger.error("bgAgents poll failed", { error: String(err) });
      const previous = (snapshot?.sessions ?? []).filter((s) => s.accountId === dir?.accountId);
      return { sessions: previous, error: dir && dirs().length > 1 ? `${dir.name}: ${message}` : message };
    }
  }

  async function read(): Promise<BgAgentsSnapshot> {
    const results = await Promise.all(dirs().map(readDir));
    const seen = new Set<string>();
    const sessions: BgAgentSession[] = [];
    for (const s of results.flatMap((r) => r.sessions)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      sessions.push(s);
    }
    const errors = results.flatMap((r) => (r.error === undefined ? [] : [r.error]));
    publish({ sessions, ...(errors.length > 0 ? { error: errors.join(" · ") } : {}) });
    return snapshot!;
  }

  function poll(): Promise<BgAgentsSnapshot> {
    if (!enabled) return Promise.resolve({ sessions: [] });
    inFlight ??= read().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  /**
   * One poll, then the next one scheduled: `pollMs` after a change, otherwise twice the previous wait up to
   * `idlePollMaxMs` (every call is a `claude` process per account; an unchanged list needs no fast polling).
   */
  async function tick(gen: number, first = false): Promise<void> {
    timer = undefined;
    const before = lastKey;
    await (inFlight ?? poll()).catch(() => {});
    if (gen !== generation || disposed) return;
    delay = first || lastKey !== before ? opts.pollMs : Math.min(delay * 2, maxDelay);
    timer = setTimeout(() => void tick(gen), delay);
    timer.unref?.();
  }

  /** `fresh`: a new client — polling that slowed down polls now and fast again. */
  function startTimer(fresh: boolean): void {
    if (!enabled || disposed) return;
    const running = generation % 2 === 1;
    if (running && !(fresh && delay > opts.pollMs)) return;
    if (timer !== undefined) clearTimeout(timer);
    generation += running ? 2 : 1;
    void tick(generation, true);
  }

  function stopTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (generation % 2 === 1) generation++;
  }

  return {
    setClientCount(n) {
      const more = Math.max(0, n) > clients;
      clients = Math.max(0, n);
      if (clients > 0) startTimer(more);
      else stopTimer();
    },

    async list() {
      if (!enabled) return { sessions: [] };
      return snapshot ?? (await poll());
    },

    async attachTarget(id) {
      checkId(id);
      const find = (s: BgAgentsSnapshot) => s.sessions.find((x) => x.id === id);
      let session = snapshot ? find(snapshot) : undefined;
      if (!session) session = find(await poll());
      if (!session) throw engineError("NOT_FOUND", "engine.bgAgents.agentNotFound");
      const command = `${quoteShellArg(opts.claudeBinary)} attach ${id}`;
      const account = session.accountId !== undefined ? { accountId: session.accountId } : {};
      if (session.projectId !== undefined) {
        return { projectId: session.projectId, ...(session.cardId !== undefined ? { cardId: session.cardId } : {}), command, ...account };
      }
      if (opts.builtinProjectId === undefined) throw engineError("NOT_FOUND", "engine.bgAgents.projectNotFound");
      return { projectId: opts.builtinProjectId, command, ...account };
    },

    async logs(id) {
      const stdout = await claude(["logs", checkId(id)], dirOf(id));
      const { text } = scanOutput(stdout.replace(/\r\n/g, "\n"));
      if (text.length <= opts.logsMaxChars) return { text, truncated: false };
      return { text: text.slice(text.length - opts.logsMaxChars), truncated: true };
    },

    async stop(id) {
      await claude(["stop", checkId(id)], dirOf(id));
      opts.logger.info("background agent stopped", { id });
      await poll();
    },

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    match(cwd) {
      return matchTarget(normalize(cwd), buildTargets(opts.projects.list(), opts.cards.list(), normalize));
    },

    dispose() {
      disposed = true;
      listeners.clear();
      stopTimer();
    },
  };
}
