// Claude kullanımı — how much each Claude subscription (account = config dir, İş H) is being used.
//
// Two views per account:
//   transcripts  ALWAYS. Counted from the account's own session transcripts
//                `<configDir>/projects/**/<session>.jsonl`: per assistant message the four token counts, the model
//                id, the timestamp and the folder the session ran in. Nothing else is taken from a line — never the
//                message text — and nothing but those files is opened. These are Kokpit's own counts for this Mac,
//                NOT Claude's quota percentage.
//   plan         ONLY when Claude Code itself reported it without Kokpit touching credentials: the status line
//                snapshot (`<configDir>/<plan.snapshotFileName>`, written by wrappers/claude-kullanim-durum-satiri.mjs
//                from the JSON Claude Code hands every status line command), or a probe the user asked for (one tiny
//                `claude -p` request whose stream-json output carries a `rate_limit_event`).
//
// Never read here: `.credentials.json`, the Keychain, tokens, auth headers; no HTTP request is made.
//
// Observed transcript shape (Claude Code 2.1.x, 2026-11): one JSONL line per CONTENT BLOCK of an assistant message,
// each repeating the message's `usage` (identical in 2.1.x; older versions wrote growing output counts) with the
// same `message.id` and top-level `requestId`. Resumed/forked sessions copy earlier lines into a new file. Hence
// messages are deduplicated per account by message id + request id, keeping the largest figures.
//
// Cost: folders hold thousands of large files. A pass lstat()s the tree, opens only files modified inside the long
// window, continues each from the byte offset it reached last time (persisted under the engine's data dir), reads in
// chunks and yields to the event loop whenever `tickBudgetMs` of work has been done.
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  Card,
  ClaudePlanSource,
  ClaudePlanWindow,
  ClaudeUsageAccount,
  ClaudeUsageModel,
  ClaudeUsageProject,
  ClaudeUsageResult,
  ClaudeUsageTotals,
  ClaudeUsageWindow,
  Project,
} from "@kokpit/shared";
import { st as sharedText, type Params, type SharedKey } from "@kokpit/shared/i18n";
import { buildTargets, matchTarget, normalizePath, type Target } from "./bg-agents.ts";
import { CLAUDE_CONFIG_ENV, type AccountDir } from "./claude-accounts.ts";
import { engineError, type Logger } from "./contracts.ts";
import { isWithin, loadDefaultsFile, PathSegment, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./fs-safety.ts";
import { execCapped, type RunResult } from "./exec-runner.ts";

export const CLAUDE_USAGE_DEFAULTS_PATH = fileURLToPath(new URL("../claude-usage.defaults.json", import.meta.url));

// ---------- config ----------

const MAX_BYTES = 2 ** 40;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_S = 1000;
const TOKENS_PER_PRICE_UNIT = 1_000_000;
const count = (min: number, max: number) => z.number().int().min(min).max(max);
const price = z.number().min(0).max(1_000_000);

export const ClaudeUsageConfigSchema = z
  .object({
    /** Folder of session transcripts inside a config dir. */
    projectsDirName: PathSegment,
    transcriptExt: z.string().regex(/^\.[A-Za-z0-9]{1,16}$/),
    /** Folder levels below the projects folder that are entered. */
    maxDepth: count(1, 64),
    /** Transcript files looked at per account and pass; beyond it the result is `partial`. */
    maxFiles: count(1, 10_000_000),
    /** A longer line is skipped without being buffered. */
    maxLineBytes: count(1024, 2 ** 30),
    readChunkBytes: count(256, 2 ** 28),
    /** Bytes read per account and pass; the next pass continues where this one stopped. */
    maxPassBytes: count(1, MAX_BYTES),
    /** Work done before the reader yields to the event loop. */
    tickBudgetMs: count(1, 1000),
    /** A `claudeUsage.get` older than this starts a new pass; also how often a visible view asks again. */
    refreshIntervalMs: count(1000, MS_PER_DAY),
    sessionWindowHours: count(1, 168),
    /** Also how far back messages are kept at all. */
    longWindowDays: count(1, 90),
    /** Messages kept per account; beyond it the result is `partial`. */
    maxMessages: count(1, 50_000_000),
    topProjects: count(1, 100),
    /** Folder under the engine's data dir for the reader's cursor cache. */
    cacheDirName: PathSegment,
    /** Messages per cache line (the cache is written and read in slices). */
    cacheChunkEvents: count(1, 1_000_000),
    maxCacheBytes: count(1024, MAX_BYTES),
    /** Stripped from a model id before its family is taken. */
    modelPrefix: z.string().max(50),
    /** Model ids that are not API responses (Claude Code's own placeholder messages). */
    ignoreModels: z.array(z.string().min(1).max(200)).max(50),
    /** A session folder containing one of these is shown under the folder before it (agent worktrees → their repo). */
    worktreeMarkers: z.array(z.string().min(1).max(200)).max(20),
    plan: z
      .object({
        /** File the status line helper writes inside the config dir. */
        snapshotFileName: PathSegment,
        maxSnapshotBytes: count(64, 2 ** 24),
      })
      .strict(),
    probe: z
      .object({
        enabled: z.boolean(),
        /** Empty working folder of the probe, inside the cache folder. */
        dirName: PathSegment,
        /** Arguments of the one non-interactive `claude` request. */
        args: z.array(z.string().max(1000)).min(1).max(50),
        timeoutMs: count(1, MS_PER_HOUR),
        maxOutputBytes: count(1024, 2 ** 30),
        /** Per account. */
        minIntervalMs: count(0, MS_PER_DAY),
        /** `utilization` (a 0–1 fraction in Claude Code 2.1.x) times this = percent. */
        utilizationScale: z.number().min(0.0001).max(1_000_000),
      })
      .strict(),
    prices: z
      .object({
        /** Date the table was valid; null = no table (no cost estimate). */
        asOf: z.string().min(1).max(40).nullable(),
        /** USD per million tokens, by model family. */
        perMillionUsd: z.record(z.string().min(1).max(100), z.object({ input: price, output: price, cacheWrite: price, cacheRead: price }).strict()),
      })
      .strict()
      .superRefine((p, ctx) => {
        if (p.asOf === null && Object.keys(p.perMillionUsd).length > 0) {
          ctx.addIssue({ code: "custom", path: ["asOf"], message: "a price table needs its date (asOf)" });
        }
      }),
  })
  .strict();
export type ClaudeUsageConfig = z.infer<typeof ClaudeUsageConfigSchema>;

/** The `claudeUsage` key of engine.json: any subset of the defaults (nested blocks are replaced whole). */
export const ClaudeUsageConfigOverrideSchema = ClaudeUsageConfigSchema.partial().strict();
export type ClaudeUsageConfigOverride = z.infer<typeof ClaudeUsageConfigOverrideSchema>;

export function loadClaudeUsageConfig(overrides: ClaudeUsageConfigOverride, path: string = CLAUDE_USAGE_DEFAULTS_PATH): ClaudeUsageConfig {
  return loadDefaultsFile(ClaudeUsageConfigSchema, overrides, path, "claudeUsage");
}

// ---------- pure helpers ----------

/** "claude-opus-5-5" → "opus", "claude-3-5-sonnet-20241022" → "sonnet": the first segment that starts with a letter. */
export function modelFamily(model: string, prefix: string): string {
  const rest = prefix !== "" && model.startsWith(prefix) ? model.slice(prefix.length) : model;
  for (const seg of rest.split(/[^A-Za-z0-9]+/)) {
    if (/^[A-Za-z]/.test(seg)) return seg.toLowerCase();
  }
  return rest === "" ? model : rest;
}

/** The last folder name of `cwd` (cut before a worktree marker); undefined when there is none. Never a path. */
export function folderName(cwd: string, markers: readonly string[]): string | undefined {
  let path = cwd;
  for (const m of markers) {
    const i = path.indexOf(m);
    if (i > 0) path = path.slice(0, i);
  }
  const name = basename(path);
  return name === "" || name === "/" ? undefined : name;
}

/** What is taken from one transcript line. */
export interface UsageLine {
  id: string;
  requestId?: string;
  /** Epoch ms. */
  t: number;
  model: string;
  /** "" when the line has none. */
  cwd: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const MAX_ID_CHARS = 200;
const MAX_CWD_CHARS = 4096;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const shortString = (v: unknown, max: number): string | undefined => (typeof v === "string" && v !== "" && v.length <= max ? v : undefined);

function tokenCount(v: unknown): number {
  if (typeof v !== "number" || !(v > 0)) return 0; // NaN, negatives, non-numbers
  return v >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Math.floor(v);
}

/**
 * The usage of an assistant line, or undefined for any other line (other types, malformed JSON, placeholder models,
 * no id, no time). Only the fields of `UsageLine` are copied out; the parsed line is dropped.
 */
export function extractUsage(line: string, ignoreModels: readonly string[]): UsageLine | undefined {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(o) || o.type !== "assistant" || !isRecord(o.message)) return undefined;
  const usage = o.message.usage;
  if (!isRecord(usage)) return undefined;
  const model = shortString(o.message.model, MAX_ID_CHARS);
  if (model === undefined || ignoreModels.includes(model)) return undefined;
  const id = shortString(o.message.id, MAX_ID_CHARS) ?? shortString(o.uuid, MAX_ID_CHARS);
  if (id === undefined) return undefined;
  const t = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(t)) return undefined;
  const requestId = shortString(o.requestId, MAX_ID_CHARS);
  const cwd = typeof o.cwd === "string" && o.cwd.startsWith("/") && o.cwd.length <= MAX_CWD_CHARS ? o.cwd : "";
  return {
    id,
    ...(requestId !== undefined ? { requestId } : {}),
    t,
    model,
    cwd,
    input: tokenCount(usage.input_tokens),
    output: tokenCount(usage.output_tokens),
    cacheWrite: tokenCount(usage.cache_creation_input_tokens),
    cacheRead: tokenCount(usage.cache_read_input_tokens),
  };
}

/** A quota window before it is stamped with source and capture time. Times in epoch ms. */
export interface RawPlanWindow {
  usedPercent: number;
  resetsAt: number;
}
export interface RawPlan {
  fiveHour?: RawPlanWindow;
  sevenDay?: RawPlanWindow;
}

const PLAN_KEYS = [
  ["five_hour", "fiveHour"],
  ["seven_day", "sevenDay"],
] as const;
const PROBE_EVENT = "rate_limit_event";
const MAX_PERCENT = 1000;

function rawWindow(percent: unknown, resetsAtSeconds: unknown): RawPlanWindow | undefined {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > MAX_PERCENT) return undefined;
  if (typeof resetsAtSeconds !== "number" || !Number.isFinite(resetsAtSeconds) || resetsAtSeconds <= 0) return undefined;
  const resetsAt = resetsAtSeconds * MS_PER_S;
  if (Number.isNaN(new Date(resetsAt).getTime())) return undefined;
  return { usedPercent: percent, resetsAt };
}

/**
 * The quota windows in `claude -p --output-format stream-json` output: lines `{"type":"rate_limit_event",
 * "rate_limit_info":{"unifiedWindows":{"seven_day":{"utilization":0.59,"resetsAt":<epoch s>}, …}}}` (observed with
 * Claude Code 2.1.327). Every other line — the answer text included — is ignored.
 */
export function parseProbeOutput(stdout: string, utilizationScale: number): RawPlan {
  const plan: RawPlan = {};
  for (const line of stdout.split("\n")) {
    if (!line.includes(PROBE_EVENT)) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(o) || o.type !== PROBE_EVENT || !isRecord(o.rate_limit_info)) continue;
    const windows = o.rate_limit_info.unifiedWindows;
    if (!isRecord(windows)) continue;
    for (const [wire, key] of PLAN_KEYS) {
      const w = windows[wire];
      if (!isRecord(w) || typeof w.utilization !== "number") continue;
      const parsed = rawWindow(w.utilization * utilizationScale, w.resetsAt);
      if (parsed) plan[key] = parsed;
    }
  }
  return plan;
}

/** The status line snapshot (see wrappers/claude-kullanim-durum-satiri.mjs): Claude Code's own field names. */
function parseSnapshot(text: string, now: number): { capturedAt: number; plan: RawPlan } | undefined {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(o) || typeof o.capturedAt !== "number" || !Number.isFinite(o.capturedAt) || o.capturedAt <= 0 || o.capturedAt > now) return undefined;
  if (!isRecord(o.rate_limits)) return undefined;
  const plan: RawPlan = {};
  for (const [wire, key] of PLAN_KEYS) {
    const w = o.rate_limits[wire];
    if (!isRecord(w)) continue;
    const parsed = rawWindow(w.used_percentage, w.resets_at);
    if (parsed) plan[key] = parsed;
  }
  return { capturedAt: o.capturedAt, plan };
}

// ---------- state ----------

/** [time, model index, cwd index, input, output, cache write, cache read] */
type Ev = [number, number, number, number, number, number, number];
const T = 0;
const M = 1;
const C = 2;
const IN = 3;
const OUT = 4;
const CW = 5;
const CR = 6;

interface FileRec {
  /** Size and mtime when last read to `offset`; unchanged = not opened. */
  size: number;
  mtimeMs: number;
  ino: number;
  /** Start of the first line not yet counted. */
  offset: number;
}

interface StampedWindow extends RawPlanWindow {
  capturedAt: number;
  source: ClaudePlanSource;
}
type StampedPlan = { fiveHour?: StampedWindow; sevenDay?: StampedWindow };

interface AccountState {
  configDir: string;
  /** The cache was looked for. */
  loaded: boolean;
  files: Map<string, FileRec>;
  events: Map<string, Ev>;
  models: string[];
  modelIndex: Map<string, number>;
  cwds: string[];
  cwdIndex: Map<string, number>;
  updatedAt?: number;
  /** Lines skipped for their length since the last rebuild. */
  skippedLines: number;
  /** `maxMessages` was reached since the last rebuild. */
  capped: boolean;
  /** The last pass stopped early (maxPassBytes, maxFiles). */
  incomplete: boolean;
  error?: string;
  statusline: StampedPlan;
  probe: StampedPlan;
  probeAt?: number;
  dirty: boolean;
  /** Serializes cache reads and writes. */
  io: Promise<void>;
}

function newState(configDir: string): AccountState {
  return {
    configDir,
    loaded: false,
    files: new Map(),
    events: new Map(),
    models: [],
    modelIndex: new Map(),
    cwds: [],
    cwdIndex: new Map(),
    skippedLines: 0,
    capped: false,
    incomplete: false,
    statusline: {},
    probe: {},
    dirty: false,
    io: Promise.resolve(),
  };
}

function resetCounts(st: AccountState): void {
  st.files.clear();
  st.events.clear();
  st.models = [];
  st.modelIndex.clear();
  st.cwds = [];
  st.cwdIndex.clear();
  st.skippedLines = 0;
  st.capped = false;
  st.dirty = true;
}

function intern(list: string[], index: Map<string, number>, value: string): number {
  let i = index.get(value);
  if (i === undefined) {
    i = list.length;
    list.push(value);
    index.set(value, i);
  }
  return i;
}

/** Message id + request id, hashed: the cache holds no ids. */
const KEY_CHARS = 16;
function messageKey(id: string, requestId: string | undefined): string {
  return createHash("sha1").update(id).update("\n").update(requestId ?? "").digest("base64url").slice(0, KEY_CHARS);
}

// ---------- pacing ----------

interface Pacer {
  /** Yields to the event loop when the budget is used up. */
  pace(): Promise<void>;
  /** After waiting on I/O: a new slice starts. */
  touch(): void;
}

function createPacer(budgetMs: number): Pacer {
  let start = performance.now();
  return {
    async pace() {
      if (performance.now() - start < budgetMs) return;
      await new Promise<void>((r) => setImmediate(r));
      start = performance.now();
    },
    touch() {
      start = performance.now();
    },
  };
}

// ---------- service ----------

export type UsageRunner = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; maxOutputBytes: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<RunResult>;

export interface ClaudeUsageDeps {
  config: ClaudeUsageConfig;
  /** The engine's data dir; the cursor cache lives in `<dataDir>/<cacheDirName>`. */
  dataDir: string;
  logger: Logger;
  /** Every account (accounts sharing a folder share one reading). */
  accounts(): AccountDir[];
  projects(): Project[];
  cards(): Card[];
  /** `claude` CLI for the probe. */
  claudeBinary: string;
  run?: UsageRunner;
  now?: () => number;
  /** Local midnight before `now` (epoch ms). */
  startOfDay?: (now: number) => number;
  /** Owner transcripts must have; default: the engine's user. */
  uid?: number;
}

export interface ClaudeUsageStats {
  bytesRead: number;
  filesRead: number;
  passes: number;
  rebuilds: number;
}

export interface ClaudeUsageService {
  /** What is known now. Starts a pass in the background when asked to or when the last one is older than the interval. */
  get(p: { accountId?: string | undefined; refresh?: boolean | undefined }): ClaudeUsageResult;
  /** Asks Claude Code itself (one small request). The account's view afterwards. */
  probe(accountId: string): Promise<ClaudeUsageResult>;
  /** Waits for a running pass, then runs one more to the end. */
  refresh(): Promise<void>;
  /** Resolves when no pass is running. */
  idle(): Promise<void>;
  /** Called after every pass and probe. */
  onChange(fn: () => void): () => void;
  stats(): ClaudeUsageStats;
  dispose(): Promise<void>;
}

const CACHE_VERSION = 1;
const CACHE_EXT = ".ndjson";
const CACHE_NAME_CHARS = 24;
const MARK_ASSISTANT = Buffer.from('"assistant"');
const MARK_USAGE = Buffer.from('"usage"');
const NEWLINE = 0x0a;
const PACE_EVERY_LINES = 64;
const MAX_NAME_CHARS = 255;

const localStartOfDay = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const errnoOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

export function createClaudeUsageService(deps: ClaudeUsageDeps): ClaudeUsageService {
  const cfg = deps.config;
  const { logger } = deps;
  const now = deps.now ?? Date.now;
  const startOfDay = deps.startOfDay ?? localStartOfDay;
  const uid = deps.uid ?? process.getuid?.();
  const run: UsageRunner = deps.run ?? ((file, args, opts) => execCapped(file, args, opts));
  const sessionMs = cfg.sessionWindowHours * MS_PER_HOUR;
  const longMs = cfg.longWindowDays * MS_PER_DAY;
  const cacheDir = join(deps.dataDir, cfg.cacheDirName);
  const hasPrices = cfg.prices.asOf !== null && Object.keys(cfg.prices.perMillionUsd).length > 0;

  const states = new Map<string, AccountState>();
  const listeners = new Set<() => void>();
  const stats: ClaudeUsageStats = { bytesRead: 0, filesRead: 0, passes: 0, rebuilds: 0 };
  let running: Promise<void> | null = null;
  let lastStart = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const stateFor = (configDir: string): AccountState => {
    let st = states.get(configDir);
    if (!st) states.set(configDir, (st = newState(configDir)));
    return st;
  };
  const cacheFile = (st: AccountState): string =>
    join(cacheDir, createHash("sha256").update(st.configDir).digest("hex").slice(0, CACHE_NAME_CHARS) + CACHE_EXT);
  const withIo = <R>(st: AccountState, fn: () => Promise<R>): Promise<R> => {
    const next = st.io.then(fn, fn);
    st.io = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const emit = (): void => {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // a listener's problem
      }
    }
  };

  // ----- cache -----

  async function loadCache(st: AccountState): Promise<void> {
    if (st.loaded) return;
    st.loaded = true;
    const pacer = createPacer(cfg.tickBudgetMs);
    try {
      const file = cacheFile(st);
      const info = await stat(file);
      if (!info.isFile() || info.size > cfg.maxCacheBytes) return;
      const lines = (await readFile(file, "utf8")).split("\n");
      pacer.touch();
      const head = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
      if (head.v !== CACHE_VERSION || head.configDir !== st.configDir || head.longWindowDays !== cfg.longWindowDays) return;
      if (!Array.isArray(head.models) || !Array.isArray(head.cwds)) return;
      const fresh = newState(st.configDir);
      for (const m of head.models) intern(fresh.models, fresh.modelIndex, String(m));
      for (const c of head.cwds) intern(fresh.cwds, fresh.cwdIndex, String(c));
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "") continue;
        const row = JSON.parse(lines[i]!) as { f?: unknown; e?: unknown };
        if (Array.isArray(row.f)) {
          for (const f of row.f as unknown[]) {
            if (!Array.isArray(f) || typeof f[0] !== "string" || !f.slice(1, 5).every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("bad file row");
            fresh.files.set(f[0], { size: f[1] as number, mtimeMs: f[2] as number, ino: f[3] as number, offset: f[4] as number });
          }
        } else if (Array.isArray(row.e)) {
          for (const e of row.e as unknown[]) {
            if (!Array.isArray(e) || e.length !== 8 || typeof e[0] !== "string" || !e.slice(1).every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("bad event row");
            if ((e[2] as number) >= fresh.models.length || (e[3] as number) >= fresh.cwds.length) throw new Error("bad index");
            fresh.events.set(e[0], e.slice(1) as Ev);
          }
        } else throw new Error("bad row");
        await pacer.pace();
      }
      st.files = fresh.files;
      st.events = fresh.events;
      st.models = fresh.models;
      st.modelIndex = fresh.modelIndex;
      st.cwds = fresh.cwds;
      st.cwdIndex = fresh.cwdIndex;
      st.skippedLines = typeof head.skippedLines === "number" ? head.skippedLines : 0;
      st.capped = head.capped === true;
      st.probe = stampedPlanFrom(head.probe);
    } catch (e) {
      if (errnoOf(e) !== "ENOENT") logger.warn("Claude kullanım önbelleği okunamadı; yeniden kurulacak", { reason: errnoOf(e) ?? "biçim" });
    }
  }

  function stampedPlanFrom(v: unknown): StampedPlan {
    const out: StampedPlan = {};
    if (!isRecord(v)) return out;
    for (const [, key] of PLAN_KEYS) {
      const w = v[key];
      if (!isRecord(w)) continue;
      const { usedPercent, resetsAt, capturedAt } = w;
      if (typeof usedPercent !== "number" || typeof resetsAt !== "number" || typeof capturedAt !== "number") continue;
      if (![usedPercent, resetsAt, capturedAt].every(Number.isFinite) || usedPercent < 0 || usedPercent > MAX_PERCENT) continue;
      out[key] = { usedPercent, resetsAt, capturedAt, source: "probe" };
    }
    return out;
  }

  async function saveCache(st: AccountState): Promise<void> {
    const pacer = createPacer(cfg.tickBudgetMs);
    const file = cacheFile(st);
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      await mkdir(cacheDir, { recursive: true, mode: PRIVATE_DIR_MODE });
      const fh = await open(tmp, "w", PRIVATE_FILE_MODE);
      try {
        const head = {
          v: CACHE_VERSION,
          configDir: st.configDir,
          longWindowDays: cfg.longWindowDays,
          models: st.models,
          cwds: st.cwds,
          skippedLines: st.skippedLines,
          capped: st.capped,
          probe: st.probe,
        };
        await fh.write(`${JSON.stringify(head)}\n`);
        await fh.write(`${JSON.stringify({ f: [...st.files].map(([rel, r]) => [rel, r.size, r.mtimeMs, r.ino, r.offset]) })}\n`);
        pacer.touch();
        let chunk: unknown[] = [];
        for (const [key, ev] of st.events) {
          chunk.push([key, ...ev]);
          if (chunk.length >= cfg.cacheChunkEvents) {
            await fh.write(`${JSON.stringify({ e: chunk })}\n`);
            chunk = [];
            pacer.touch();
            await pacer.pace();
          }
        }
        if (chunk.length > 0) await fh.write(`${JSON.stringify({ e: chunk })}\n`);
      } finally {
        await fh.close();
      }
      await rename(tmp, file);
      st.dirty = false;
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      logger.warn("Claude kullanım önbelleği yazılamadı", { reason: errnoOf(e) ?? "?" });
    }
  }

  // ----- reading -----

  interface PassCtx {
    cutoff: number;
    pacer: Pacer;
    budget: number;
    filesSeen: number;
    lines: number;
  }

  function countLine(st: AccountState, line: Buffer, ctx: PassCtx): void {
    if (line.indexOf(MARK_ASSISTANT) === -1 || line.indexOf(MARK_USAGE) === -1) return;
    const u = extractUsage(line.toString("utf8"), cfg.ignoreModels);
    if (!u || u.t < ctx.cutoff) return;
    const key = messageKey(u.id, u.requestId);
    const ev = st.events.get(key);
    if (ev) {
      if (u.t < ev[T]) ev[T] = u.t;
      if (u.input > ev[IN]) ev[IN] = u.input;
      if (u.output > ev[OUT]) ev[OUT] = u.output;
      if (u.cacheWrite > ev[CW]) ev[CW] = u.cacheWrite;
      if (u.cacheRead > ev[CR]) ev[CR] = u.cacheRead;
    } else {
      if (st.events.size >= cfg.maxMessages) {
        st.capped = true;
        return;
      }
      st.events.set(key, [u.t, intern(st.models, st.modelIndex, u.model), intern(st.cwds, st.cwdIndex, u.cwd), u.input, u.output, u.cacheWrite, u.cacheRead]);
    }
    st.dirty = true;
  }

  /** Reads `path` from `offset` to its end (or until the pass budget is gone) and records how far it got. */
  async function readTranscript(st: AccountState, path: string, rel: string, offset: number, ino: number, ctx: PassCtx): Promise<void> {
    let fh;
    try {
      fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return;
    }
    try {
      const info = await fh.stat();
      if (!info.isFile() || info.ino !== ino || (uid !== undefined && info.uid !== uid)) return;
      stats.filesRead += 1;
      const buf = Buffer.allocUnsafe(cfg.readChunkBytes);
      let pos = offset;
      let lineStart = offset;
      let carry: Buffer[] = [];
      let carryLen = 0;
      let skipping = false;
      let stopped = false;
      for (;;) {
        // Out of budget, or the engine is stopping: remember how far this got.
        if (ctx.budget <= 0 || disposed) {
          stopped = true;
          break;
        }
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        ctx.pacer.touch();
        if (bytesRead === 0) break;
        stats.bytesRead += bytesRead;
        ctx.budget -= bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(NEWLINE, start);
          if (nl === -1) break;
          if (skipping) {
            skipping = false;
          } else if (carryLen + (nl - start) > cfg.maxLineBytes) {
            st.skippedLines += 1;
          } else {
            countLine(st, carryLen > 0 ? Buffer.concat([...carry, chunk.subarray(start, nl)]) : chunk.subarray(start, nl), ctx);
          }
          carry = [];
          carryLen = 0;
          start = nl + 1;
          lineStart = pos + start;
          if (++ctx.lines % PACE_EVERY_LINES === 0) await ctx.pacer.pace();
        }
        if (!skipping && start < bytesRead) {
          if (carryLen + (bytesRead - start) > cfg.maxLineBytes) {
            // Too long already: forget what was buffered and skip to the line's end.
            skipping = true;
            st.skippedLines += 1;
            carry = [];
            carryLen = 0;
          } else {
            carry.push(Buffer.from(chunk.subarray(start)));
            carryLen += bytesRead - start;
          }
        }
        pos += bytesRead;
        await ctx.pacer.pace();
      }
      // An unfinished oversized line was counted as skipped above but will be met again from `lineStart`.
      if (skipping) st.skippedLines -= 1;
      if (stopped) st.incomplete = true;
      st.files.set(rel, { size: stopped ? pos : info.size, mtimeMs: info.mtimeMs, ino: info.ino, offset: lineStart });
      st.dirty = true;
    } catch {
      // unreadable now: tried again on the next pass
    } finally {
      await fh.close().catch(() => {});
      ctx.pacer.touch();
    }
  }

  /** One walk over the account's transcripts. "rebuild": something already counted changed underneath. */
  async function scan(st: AccountState, ctx: PassCtx): Promise<"ok" | "rebuild"> {
    const root = join(st.configDir, cfg.projectsDirName);
    let realRoot: string;
    try {
      const realConfig = await realpath(st.configDir);
      realRoot = await realpath(root);
      if (!isWithin(realConfig, realRoot)) {
        st.error = sharedText("engine.claudeUsage.sessionsLinked");
        return st.files.size > 0 || st.events.size > 0 ? "rebuild" : "ok";
      }
      if (!(await lstat(realRoot)).isDirectory()) return "ok";
    } catch (e) {
      if (errnoOf(e) !== "ENOENT") st.error = sharedText("engine.claudeUsage.sessionsUnreadable");
      // No folder (yet): whatever was counted from it is gone.
      return st.files.size > 0 ? "rebuild" : "ok";
    }
    ctx.pacer.touch();

    const seen = new Set<string>();
    let complete = true;
    const walk = async (dir: string, rel: string, depth: number): Promise<"ok" | "rebuild"> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        complete = false;
        return "ok";
      }
      ctx.pacer.touch();
      for (const e of entries) {
        if (disposed) {
          complete = false;
          return "ok";
        }
        if (e.isSymbolicLink()) continue;
        const path = join(dir, e.name);
        const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (depth < cfg.maxDepth && (await walk(path, childRel, depth + 1)) === "rebuild") return "rebuild";
          continue;
        }
        if (!e.isFile() || !e.name.endsWith(cfg.transcriptExt)) continue;
        if (++ctx.filesSeen > cfg.maxFiles) {
          complete = false;
          st.incomplete = true;
          return "ok";
        }
        let info;
        try {
          info = await lstat(path);
        } catch {
          continue;
        }
        ctx.pacer.touch();
        if (!info.isFile() || (uid !== undefined && info.uid !== uid)) continue;
        seen.add(childRel);
        const rec = st.files.get(childRel);
        if (!rec) {
          if (info.mtimeMs >= ctx.cutoff) await readTranscript(st, path, childRel, 0, info.ino, ctx);
        } else if (info.ino !== rec.ino || info.size < rec.offset) {
          if (rec.mtimeMs >= ctx.cutoff || info.mtimeMs >= ctx.cutoff) return "rebuild";
          st.files.delete(childRel);
          st.dirty = true;
        } else if (info.size !== rec.size || info.mtimeMs !== rec.mtimeMs) {
          await readTranscript(st, path, childRel, rec.offset, info.ino, ctx);
        }
        await ctx.pacer.pace();
      }
      return "ok";
    };
    if ((await walk(realRoot, "", 1)) === "rebuild") return "rebuild";
    if (!complete) return "ok";
    for (const [rel, rec] of st.files) {
      if (seen.has(rel)) continue;
      if (rec.mtimeMs >= ctx.cutoff) return "rebuild";
      st.files.delete(rel);
      st.dirty = true;
    }
    return "ok";
  }

  async function readSnapshot(st: AccountState, at: number): Promise<void> {
    st.statusline = {};
    const file = join(st.configDir, cfg.plan.snapshotFileName);
    let fh;
    try {
      fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return; // absent, or a symlink
    }
    try {
      const info = await fh.stat();
      if (!info.isFile() || info.size > cfg.plan.maxSnapshotBytes || (uid !== undefined && info.uid !== uid)) return;
      const buf = Buffer.alloc(info.size);
      const { bytesRead } = await fh.read(buf, 0, info.size, 0);
      const snap = parseSnapshot(buf.subarray(0, bytesRead).toString("utf8"), at);
      if (!snap) return;
      for (const [, key] of PLAN_KEYS) {
        const w = snap.plan[key];
        if (w) st.statusline[key] = { ...w, capturedAt: snap.capturedAt, source: "statusline" };
      }
    } catch {
      // unreadable: no plan figures from this source
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async function passAccount(st: AccountState, at: number): Promise<void> {
    await withIo(st, () => loadCache(st));
    const ctx: PassCtx = { cutoff: at - longMs, pacer: createPacer(cfg.tickBudgetMs), budget: cfg.maxPassBytes, filesSeen: 0, lines: 0 };
    delete st.error;
    st.incomplete = false;
    if ((await scan(st, ctx)) === "rebuild") {
      stats.rebuilds += 1;
      resetCounts(st);
      ctx.filesSeen = 0;
      st.incomplete = false;
      const error = st.error;
      delete st.error;
      if (error === undefined) await scan(st, ctx);
      else st.error = error;
    }
    let pruned = 0;
    for (const [key, ev] of st.events) {
      if (ev[T] < ctx.cutoff) {
        st.events.delete(key);
        pruned += 1;
      }
      if (++ctx.lines % PACE_EVERY_LINES === 0) await ctx.pacer.pace();
    }
    if (pruned > 0) st.dirty = true;
    await readSnapshot(st, at);
    st.updatedAt = at;
    if (st.dirty) await withIo(st, () => saveCache(st));
  }

  function distinctDirs(): AccountDir[] {
    const seen = new Set<string>();
    return deps.accounts().filter((a) => !seen.has(a.configDir) && seen.add(a.configDir));
  }

  function startPass(): Promise<void> {
    const at = now();
    lastStart = at;
    stats.passes += 1;
    const started = performance.now();
    const before = stats.bytesRead;
    const pass = (async () => {
      for (const dir of distinctDirs()) {
        if (disposed) return;
        try {
          await passAccount(stateFor(dir.configDir), at);
        } catch (e) {
          stateFor(dir.configDir).error = sharedText("engine.claudeUsage.sessionsUnreadable");
          logger.warn("Claude kullanımı okunamadı", { accountId: dir.accountId, reason: errnoOf(e) ?? "?" });
        }
      }
      logger.debug?.("Claude kullanımı okundu", { ms: Math.round(performance.now() - started), bytes: stats.bytesRead - before });
    })().finally(() => {
      if (running === pass) running = null;
      if (!disposed) emit();
    });
    running = pass;
    return pass;
  }

  // ----- aggregation -----

  interface Bucket extends ClaudeUsageTotals {
    total: number;
  }
  const emptyBucket = (): Bucket => ({ messages: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 });
  function add(b: Bucket, ev: Ev): void {
    b.messages += 1;
    b.input += ev[IN];
    b.output += ev[OUT];
    b.cacheWrite += ev[CW];
    b.cacheRead += ev[CR];
    b.total += ev[IN] + ev[OUT] + ev[CW] + ev[CR];
  }
  const totalsOf = ({ messages, input, output, cacheWrite, cacheRead }: Bucket): ClaudeUsageTotals => ({ messages, input, output, cacheWrite, cacheRead });
  const bySize = (a: Bucket, b: Bucket): number => b.total - a.total || b.messages - a.messages;

  interface WindowAcc {
    from: number;
    totals: Bucket;
    models: Map<string, Bucket>;
    projects: Map<string, Bucket & { projectId?: string; name: string }>;
  }

  interface Place {
    key: string;
    projectId?: string;
    name: string;
  }

  function placeResolver(): (cwd: string) => Place {
    const projects = deps.projects();
    const names = new Map(projects.map((p) => [p.id, p.name]));
    // Folders as stored and as they really are (a session's cwd may be either spelling).
    const targets: Target[] = [...buildTargets(projects, deps.cards(), (p) => p), ...buildTargets(projects, deps.cards(), (p) => normalizePath(p, realpathSync.native))];
    const clean = (s: string): string => s.replace(/[/\\]/g, "-").slice(0, MAX_NAME_CHARS) || sharedText("engine.claudeUsage.unknownFolder");
    return (cwd) => {
      const match = cwd === "" ? undefined : matchTarget(cwd, targets);
      const projectName = match ? names.get(match.projectId) : undefined;
      if (match && projectName !== undefined) return { key: `p:${match.projectId}`, projectId: match.projectId, name: clean(projectName) };
      const name = clean(folderName(cwd, cfg.worktreeMarkers) ?? sharedText("engine.claudeUsage.unknownFolder"));
      return { key: `n:${name}`, name };
    };
  }

  function costOf(models: Map<string, Bucket>): number | undefined {
    if (!hasPrices) return undefined;
    let usd = 0;
    for (const [family, b] of models) {
      const p = cfg.prices.perMillionUsd[family];
      if (!p) return undefined;
      usd += (b.input * p.input + b.output * p.output + b.cacheWrite * p.cacheWrite + b.cacheRead * p.cacheRead) / TOKENS_PER_PRICE_UNIT;
    }
    return usd;
  }

  function windowsOf(st: AccountState, at: number, placeOf: (cwd: string) => Place): ClaudeUsageAccount["windows"] {
    const acc = (from: number): WindowAcc => ({ from, totals: emptyBucket(), models: new Map(), projects: new Map() });
    const session = acc(at - sessionMs);
    const today = acc(startOfDay(at));
    const week = acc(at - longMs);
    const all = [session, today, week];
    const families = st.models.map((m) => modelFamily(m, cfg.modelPrefix));
    const places: (Place | undefined)[] = [];
    for (const ev of st.events.values()) {
      const t = ev[T];
      if (t > at) continue;
      for (const w of all) {
        if (t < w.from) continue;
        add(w.totals, ev);
        const family = families[ev[M]] ?? "?";
        let m = w.models.get(family);
        if (!m) w.models.set(family, (m = emptyBucket()));
        add(m, ev);
        const place = (places[ev[C]] ??= placeOf(st.cwds[ev[C]] ?? ""));
        let p = w.projects.get(place.key);
        if (!p) w.projects.set(place.key, (p = { ...emptyBucket(), name: place.name, ...(place.projectId !== undefined ? { projectId: place.projectId } : {}) }));
        add(p, ev);
      }
    }
    const build = (w: WindowAcc): ClaudeUsageWindow => {
      const cost = costOf(w.models);
      return {
        totals: totalsOf(w.totals),
        byModel: [...w.models].sort((a, b) => bySize(a[1], b[1])).map(([family, b]): ClaudeUsageModel => ({ family, ...totalsOf(b) })),
        topProjects: [...w.projects.values()]
          .sort(bySize)
          .slice(0, cfg.topProjects)
          .map((p): ClaudeUsageProject => ({ ...(p.projectId !== undefined ? { projectId: p.projectId } : {}), name: p.name, ...totalsOf(p) })),
        ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
      };
    };
    return { session: build(session), today: build(today), week: build(week) };
  }

  function planOf(st: AccountState, at: number): ClaudeUsageAccount["plan"] {
    const out: NonNullable<ClaudeUsageAccount["plan"]> = {};
    for (const [, key] of PLAN_KEYS) {
      const candidates = [st.statusline[key], st.probe[key]].filter((w): w is StampedWindow => w !== undefined && w.resetsAt > at && w.capturedAt <= at);
      const best = candidates.sort((a, b) => b.capturedAt - a.capturedAt)[0];
      if (!best) continue;
      const w: ClaudePlanWindow = {
        usedPercent: best.usedPercent,
        resetsAt: new Date(best.resetsAt).toISOString(),
        capturedAt: new Date(best.capturedAt).toISOString(),
        source: best.source,
      };
      out[key] = w;
    }
    return out.fiveHour || out.sevenDay ? out : undefined;
  }

  function view(a: AccountDir, at: number, placeOf: (cwd: string) => Place): ClaudeUsageAccount {
    const st = stateFor(a.configDir);
    const plan = planOf(st, at);
    return {
      accountId: a.accountId,
      name: a.name,
      ...(a.isDefault ? { isDefault: true } : {}),
      windows: windowsOf(st, at, placeOf),
      ...(plan ? { plan } : {}),
      ...(st.updatedAt !== undefined ? { updatedAt: new Date(st.updatedAt).toISOString() } : {}),
      indexing: running !== null,
      ...(st.skippedLines > 0 || st.capped || st.incomplete ? { partial: true } : {}),
      ...(st.error !== undefined ? { error: st.error } : {}),
    };
  }

  function requireAccount(accountId: string): AccountDir {
    const a = deps.accounts().find((x) => x.accountId === accountId);
    if (!a) throw engineError("NOT_FOUND", "engine.claudeAccounts.notFound", { id: accountId });
    return a;
  }

  function result(accounts: AccountDir[], at: number): ClaudeUsageResult {
    const placeOf = placeResolver();
    return {
      accounts: accounts.map((a) => view(a, at, placeOf)),
      sessionWindowHours: cfg.sessionWindowHours,
      longWindowDays: cfg.longWindowDays,
      refreshIntervalMs: cfg.refreshIntervalMs,
      ...(hasPrices && cfg.prices.asOf !== null ? { pricesAsOf: cfg.prices.asOf } : {}),
      probeAvailable: cfg.probe.enabled,
    };
  }

  return {
    get(p) {
      const accounts = p.accountId !== undefined ? [requireAccount(p.accountId)] : deps.accounts();
      const at = now();
      if (!disposed && running === null && (p.refresh === true || at - lastStart >= cfg.refreshIntervalMs)) void startPass();
      return result(accounts, at);
    },

    async probe(accountId) {
      if (!cfg.probe.enabled) throw engineError("INVALID", "engine.claudeUsage.probeDisabled");
      const account = requireAccount(accountId);
      const st = stateFor(account.configDir);
      const at = now();
      if (st.probeAt !== undefined && at - st.probeAt < cfg.probe.minIntervalMs) {
        const wait = Math.ceil((cfg.probe.minIntervalMs - (at - st.probeAt)) / MS_PER_S);
        throw engineError("INVALID", "engine.claudeUsage.probeTooSoon", { count: wait });
      }
      st.probeAt = at;
      const cwd = join(cacheDir, cfg.probe.dirName);
      await mkdir(cwd, { recursive: true, mode: PRIVATE_DIR_MODE });
      // The engine's env without an inherited CLAUDE_CONFIG_DIR, plus the account's when it is not the default (İş H).
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env[CLAUDE_CONFIG_ENV];
      if (!account.isDefault) env[CLAUDE_CONFIG_ENV] = account.configDir;
      const r = await run(deps.claudeBinary, [...cfg.probe.args], { timeoutMs: cfg.probe.timeoutMs, maxOutputBytes: cfg.probe.maxOutputBytes, env, cwd });
      const fail = (key: SharedKey, params?: Params) => engineError("CLAUDE_FAILED", key, params);
      if (r.error === "ENOENT") throw fail("engine.claudeUsage.notFound", { binary: deps.claudeBinary });
      if (r.error === "TIMEOUT") throw fail("engine.bgAgents.timeout", { seconds: Math.round(cfg.probe.timeoutMs / MS_PER_S) });
      if (r.error === "TOO_BIG") throw fail("engine.bgAgents.tooBig");
      // Only rate-limit events are read from the output; it is never logged or echoed.
      const plan = parseProbeOutput(r.stdout, cfg.probe.utilizationScale);
      if (!plan.fiveHour && !plan.sevenDay) {
        logger.warn("Claude kota bilgisi vermedi", { accountId, code: r.code, error: r.error });
        throw fail("engine.claudeUsage.noQuota");
      }
      await withIo(st, () => loadCache(st));
      for (const [, key] of PLAN_KEYS) {
        const w = plan[key];
        if (w) st.probe[key] = { ...w, capturedAt: at, source: "probe" };
      }
      await withIo(st, () => saveCache(st));
      logger.info("Claude kotası soruldu", { accountId, windows: Object.keys(plan) });
      if (!disposed) emit();
      return result([account], now());
    },

    async refresh() {
      while (running) await running;
      if (disposed) return;
      await startPass();
    },

    async idle() {
      while (running) await running;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    stats: () => ({ ...stats }),

    async dispose() {
      disposed = true;
      listeners.clear();
      while (running) await running;
      await Promise.all([...states.values()].map((s) => s.io));
    },
  };
}
