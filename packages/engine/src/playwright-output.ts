// Adım 9 İş T: where a project's Playwright MCP writes its files (`<base>/<projectId>/`, outside the repo) and the
// sweep that deletes what is older than the retention limit. The sweep works strictly inside the base directory:
// it never follows a symbolic link (a link is unlinked like a file, never traversed), checks every directory it
// enters against the base's real path, ignores errors per entry and looks at a bounded number of entries per run.
import { lstat, opendir, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Logger } from "./contracts.ts";
import { isStrictlyInside, isWithin } from "./fs-safety.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Longest file name the file systems we run on accept (bytes). */
const MAX_SEGMENT_BYTES = 255;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ONLY_DOTS = /^\.+$/;

/** The config keys that decide the base directory (see browser-config.ts). */
export interface PlaywrightOutputLocation {
  playwrightMcpOutputDirName: string;
  playwrightMcpOutputParentDir?: string | undefined;
}

/**
 * The directory all projects' Playwright MCP output lives in: `<parent>/<name>`, where the parent is the configured
 * one or else the engine user's per-user temp dir. The swept directory therefore always carries Kokpit's own name,
 * whatever parent a config file names.
 */
export function playwrightOutputBaseDir(location: PlaywrightOutputLocation, tmpDir: string): string {
  return join(location.playwrightMcpOutputParentDir ?? tmpDir, location.playwrightMcpOutputDirName);
}

/** True when `id` can be used as one directory name: no separators, no traversal, no control characters. */
function isSafeSegment(id: string): boolean {
  return (
    id.length > 0 &&
    Buffer.byteLength(id) <= MAX_SEGMENT_BYTES &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !CONTROL_CHARS.test(id) &&
    !ONLY_DOTS.test(id) &&
    id === id.trim()
  );
}

/**
 * The Playwright MCP output directory of one project: `<baseDir>/<projectId>`. Throws when the id is not one safe
 * path segment (it could otherwise point outside the base) or the base is not absolute. Creates nothing.
 */
export function playwrightOutputDirFor(baseDir: string, projectId: string): string {
  if (!isAbsolute(baseDir)) throw new Error(`playwright output base must be an absolute path: ${JSON.stringify(baseDir)}`);
  if (!isSafeSegment(projectId)) throw new Error(`project id is not a safe directory name: ${JSON.stringify(projectId)}`);
  const base = resolve(baseDir);
  const dir = base + sep + projectId;
  if (!isStrictlyInside(base, dir)) throw new Error(`project id is not a safe directory name: ${JSON.stringify(projectId)}`);
  return dir;
}

export interface SweepOptions {
  baseDir: string;
  /** Files whose mtime is more than this before `now` are deleted. */
  retentionMs: number;
  /** Most directory entries one sweep looks at; the rest waits for the next sweep. */
  maxEntries: number;
  /** Current time, epoch ms. */
  now: number;
}

export interface SweepResult {
  /** Files and symbolic links removed. */
  deletedFiles: number;
  /** Emptied subdirectories removed. */
  deletedDirs: number;
  /** Entries that could not be read or removed (each one skipped). */
  errors: number;
  /** Directory entries looked at. */
  scanned: number;
  /** True when `maxEntries` was reached before everything was seen. */
  truncated: boolean;
  /** Set when nothing was swept: no base yet, or a base that is not a plain absolute directory. */
  skipped?: "missing" | "not-a-directory" | "not-absolute";
}

const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

/**
 * One sweep of the base directory. Deletes files (and symbolic links, by their own mtime) older than the limit, then
 * subdirectories that became empty or are empty and old. Never removes the base itself, never throws for an entry.
 *
 * Bound: a tree with more than `maxEntries` entries is finished over several sweeps; entries are taken in directory
 * order, so more than `maxEntries` recent entries ahead of an old one delay that one until they age out.
 */
export async function sweepPlaywrightOutput(opts: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { deletedFiles: 0, deletedDirs: 0, errors: 0, scanned: 0, truncated: false };
  if (!isAbsolute(opts.baseDir)) return { ...result, skipped: "not-absolute" };
  let baseReal: string;
  try {
    // lstat: a base that is itself a symbolic link is refused, wherever it points.
    if (!(await lstat(opts.baseDir)).isDirectory()) return { ...result, skipped: "not-a-directory" };
    baseReal = await realpath(opts.baseDir);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return { ...result, skipped: "missing" };
    return { ...result, errors: 1, skipped: "not-a-directory" };
  }
  const cutoff = opts.now - opts.retentionMs;
  let budget = Math.max(0, Math.floor(opts.maxEntries));

  /** Sweeps one real directory inside the base; returns whether anything in it was removed. */
  async function walk(dir: string): Promise<boolean> {
    let names: string[];
    try {
      // The path was built from the base's real path and names read from disk: if it no longer resolves to itself,
      // something was swapped for a link meanwhile — leave it.
      if ((await realpath(dir)) !== dir || !isWithin(baseReal, dir)) return false;
      names = await readNames(dir);
    } catch {
      result.errors++;
      return false;
    }
    let removed = false;
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = await lstat(path);
        if (st.isDirectory()) {
          const emptied = await walk(path);
          if ((emptied || st.mtimeMs < cutoff) && (await removeIfEmpty(path))) removed = true;
        } else if (st.mtimeMs < cutoff) {
          // A regular file, a symbolic link (never followed) or any other non-directory.
          await unlink(path);
          result.deletedFiles++;
          removed = true;
        }
      } catch (e) {
        if (errorCode(e) !== "ENOENT") result.errors++;
      }
    }
    return removed;
  }

  async function readNames(dir: string): Promise<string[]> {
    const names: string[] = [];
    if (budget <= 0) {
      result.truncated = true;
      return names;
    }
    const handle = await opendir(dir);
    // Names are collected first: deleting while a directory is being read can skip entries.
    for await (const entry of handle) {
      if (budget <= 0) {
        result.truncated = true;
        break;
      }
      budget--;
      result.scanned++;
      names.push(entry.name);
    }
    return names;
  }

  async function removeIfEmpty(dir: string): Promise<boolean> {
    try {
      await rmdir(dir);
      result.deletedDirs++;
      return true;
    } catch (e) {
      const code = errorCode(e);
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") result.errors++;
      return false;
    }
  }

  await walk(baseReal);
  return result;
}

export interface PlaywrightOutputSweeperOptions {
  baseDir: string;
  /** `browser.playwrightMcpOutputRetentionDays`. */
  retentionDays: number;
  /** `browser.playwrightMcpOutputSweepIntervalMs`. */
  intervalMs: number;
  /** `browser.playwrightMcpOutputSweepMaxEntries`. */
  maxEntries: number;
  logger: Logger;
  /** Injected for tests; default is the system clock and timers. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

export interface PlaywrightOutputSweeper {
  /** Sweeps once now (in the background) and then on every interval. Calling it again changes nothing. */
  start(): void;
  /** Resolves when no sweep is running. */
  whenIdle(): Promise<void>;
  /** Stops the timer; later ticks do nothing. */
  dispose(): void;
}

/** Runs `sweepPlaywrightOutput` at engine start and periodically; logs counts only (never a file name). */
export function createPlaywrightOutputSweeper(opts: PlaywrightOutputSweeperOptions): PlaywrightOutputSweeper {
  const now = opts.now ?? Date.now;
  const startTimer =
    opts.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref(); // never keeps the engine alive
      return t;
    });
  const stopTimer = opts.clearInterval ?? ((t: unknown) => clearInterval(t as NodeJS.Timeout));
  const { logger } = opts;
  let timer: unknown;
  let started = false;
  let disposed = false;
  let running: Promise<void> | null = null;

  async function sweepOnce(): Promise<void> {
    try {
      const r = await sweepPlaywrightOutput({
        baseDir: opts.baseDir,
        retentionMs: opts.retentionDays * MS_PER_DAY,
        maxEntries: opts.maxEntries,
        now: now(),
      });
      const counts = { deletedFiles: r.deletedFiles, deletedDirs: r.deletedDirs, errors: r.errors, scanned: r.scanned, truncated: r.truncated };
      if (r.skipped === "not-a-directory" || r.skipped === "not-absolute") {
        logger.warn("playwright çıktı klasörü düz bir klasör değil; temizlik yapılmadı", { baseDir: opts.baseDir, reason: r.skipped });
        return;
      }
      logger.info("playwright çıktıları temizlendi", { ...counts, retentionDays: opts.retentionDays });
      if (r.truncated) logger.warn("playwright çıktı temizliği sınırda durdu; kalanı sonraki turda", { maxEntries: opts.maxEntries });
    } catch (e) {
      logger.warn("playwright çıktı temizliği başarısız", { error: errorCode(e) ?? (e instanceof Error ? e.name : "unknown") });
    }
  }

  function tick(): void {
    if (disposed || running) return;
    running = sweepOnce().finally(() => {
      running = null;
    });
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      tick();
      timer = startTimer(tick, opts.intervalMs);
    },
    whenIdle: async () => {
      while (running) await running;
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) stopTimer(timer);
      timer = undefined;
    },
  };
}
