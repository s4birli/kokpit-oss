// Yollar — a path a program printed in a terminal ("open ~/Documents/rapor/index.html", "src/a.ts"), resolved on
// THIS machine, where the file is: `~` and `$HOME` are the engine user's home; a relative path is tried against the
// terminal's current directory, then against the card's / project's folder. Nothing here is asked on hover: the app
// calls only when the user acts on the link.
//
// The terminal's current directory: asked from the operating system on demand — `lsof -a -p <shell pid> -d cwd -Fn`
// for the PTY's shell — and remembered for `cwdCacheMs`. (OSC 7 is not used: the stock macOS zsh only sends it in
// Apple's Terminal.) When it cannot be read, the folder the terminal was started in is used.
import { execFile } from "node:child_process";
import { realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { isWebPagePath, PATH_LIMITS, trimTrailing, type FileLocation, type FileMediaKind } from "@kokpit/shared";
import { EngineError, engineError, type Logger } from "./contracts.ts";
import { isWithin } from "./fs-safety.ts";

export const PathsConfigSchema = z
  .object({
    /** `lsof`: reads the current directory of a terminal's shell. */
    lsofPath: z.string().min(1).refine(isAbsolute, "mutlak bir yol olmalı"),
    cwdTimeoutMs: z.number().int().positive(),
    /** A terminal's current directory is asked again only after this long. */
    cwdCacheMs: z.number().int().min(0),
    /** Words after an unquoted path that may still belong to it (`/Volumes/Main Disk/a.html`). 0 = never. */
    maxTailWords: z.number().int().min(0).max(64),
  })
  .strict();
export type PathsConfig = z.infer<typeof PathsConfigSchema>;

export interface CwdLookup {
  /** The current directory of process `pid`; undefined when it cannot be read (gone, not ours, lsof missing). */
  cwdOf(pid: number): Promise<string | undefined>;
}

type Exec = (file: string, args: string[], opts: { timeout: number }) => Promise<string>;

const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, encoding: "utf8", maxBuffer: 65536 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** `lsof -Fn` output → the `n` field: the directory's path. */
export function parseLsofCwd(out: string): string | undefined {
  for (const line of out.split("\n")) {
    if (line.startsWith("n") && line.length > 1 && line[1] === "/") return line.slice(1);
  }
  return undefined;
}

export function createCwdLookup(deps: { config: PathsConfig; logger: Logger; exec?: Exec; now?: () => number }): CwdLookup {
  const { config: cfg } = deps;
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const cache = new Map<number, { at: number; cwd: Promise<string | undefined> }>();
  return {
    cwdOf(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(undefined);
      const t = now();
      for (const [key, entry] of cache) if (t - entry.at >= cfg.cwdCacheMs) cache.delete(key);
      const hit = cache.get(pid);
      if (hit) return hit.cwd;
      const cwd = exec(cfg.lsofPath, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: cfg.cwdTimeoutMs }).then(parseLsofCwd, (err: unknown) => {
        deps.logger.warn("terminal cwd lookup failed", { err: err instanceof Error ? err.message.split("\n")[0] : String(err) });
        return undefined;
      });
      cache.set(pid, { at: t, cwd });
      return cwd;
    },
  };
}

/** `path` with what may still belong to it from `tail`, longest first, then `path` itself. */
function withTail(path: string, tail: string | undefined, maxWords: number): string[] {
  const out: string[] = [];
  if (tail !== undefined && maxWords > 0) {
    const ends = [...tail.matchAll(/\S+/g)].slice(0, maxWords).map((m) => m.index + m[0].length);
    for (const end of ends.reverse()) {
      const longer = trimTrailing(path + tail.slice(0, end));
      if (longer.length > path.length && longer.length <= PATH_LIMITS.maxPathChars && !out.includes(longer)) out.push(longer);
    }
  }
  out.push(path);
  return out;
}

/**
 * The absolute paths a path as written may mean, most likely first. `dirs`: where a relative path is looked for.
 * Empty for something that is no path (NUL, empty).
 */
export function pathCandidates(ref: { path: string; tail?: string | undefined }, ctx: { home: string; dirs: readonly string[]; maxTailWords: number }): string[] {
  if (ref.path === "" || ref.path.includes("\0") || (ref.tail ?? "").includes("\0")) return [];
  const out: string[] = [];
  for (const written of withTail(ref.path, ref.tail, ctx.maxTailWords)) {
    const home = /^(?:~|\$HOME)(?=\/|$)/.exec(written);
    const bases = home ? [join(ctx.home, written.slice(home[0].length))] : isAbsolute(written) ? [written] : ctx.dirs.map((dir) => join(dir, written));
    for (const base of bases) {
      const abs = normalize(base);
      if (isAbsolute(abs) && !out.includes(abs)) out.push(abs);
    }
  }
  return out;
}

export interface PathOwner {
  /** Folder Dosyalar shows for this terminal / card / project; null when there is none on this machine. */
  root: string | null;
  /** Folders the user named: the card's worktree and the project's folder. */
  roots: readonly string[];
  /** The terminal's current directory, when known. */
  cwd?: string | undefined;
  cardId?: string | undefined;
}

export interface PathLocatorDeps {
  config: PathsConfig;
  homeDir?: string;
  /** FileService.resolve: throws when Dosyalar would not show the path. */
  resolveInRoot(root: string, path: string): { rootReal: string; real: string };
  /** MediaService.kindOf. */
  mediaKindOf(name: string): FileMediaKind | undefined;
  preview: {
    typeOf(name: string): string | undefined;
    check(file: string, roots: readonly string[]): { single: boolean };
  };
}

export interface PathLocator {
  /** What `ref` points at. Throws EngineError NOT_FOUND when nothing is there. */
  locate(owner: PathOwner, ref: { path: string; tail?: string | undefined }): FileLocation;
}

const MISSING = "engine.filesPreview.missing";
const NOT_OPENABLE = "engine.localPaths.notOpenable";

export function createPathLocator(deps: PathLocatorDeps): PathLocator {
  const home = deps.homeDir ?? homedir();
  return {
    locate(owner, ref) {
      const dirs = [owner.cwd, owner.root].filter((d): d is string => typeof d === "string" && d !== "");
      let real: string | undefined;
      let st: Stats | undefined;
      for (const candidate of pathCandidates(ref, { home, dirs, maxTailWords: deps.config.maxTailWords })) {
        try {
          real = realpathSync(candidate);
          st = statSync(real);
          break;
        } catch {
          real = st = undefined;
        }
      }
      if (real === undefined || st === undefined) throw engineError("NOT_FOUND", MISSING);
      // Devices, FIFOs and sockets are never read, shown or served.
      if (!st.isFile() && !st.isDirectory()) throw engineError("INVALID", NOT_OPENABLE);
      const media = st.isFile() ? deps.mediaKindOf(real) : undefined;
      const kind: FileLocation["kind"] = st.isDirectory() ? "dir" : isWebPagePath(real) ? "page" : media !== undefined ? "media" : "file";

      let rootPath: string | undefined;
      if (owner.root !== null) {
        try {
          const rootReal = realpathSync(owner.root);
          if (isWithin(rootReal, real)) {
            const rel = relative(rootReal, real).split(sep).join("/");
            // The same rules as the panel itself (hidden names, links leaving the folder).
            if (deps.resolveInRoot(owner.root, rel).real === real) rootPath = rel;
          }
        } catch {
          rootPath = undefined;
        }
      }

      let browser = false;
      let browserRefusal: string | undefined;
      if (st.isFile() && deps.preview.typeOf(real) !== undefined) {
        try {
          deps.preview.check(real, owner.roots);
          browser = true;
        } catch (err) {
          if (!(err instanceof EngineError)) throw err;
          browserRefusal = err.message;
        }
      }
      return {
        path: real,
        kind,
        ...(kind === "media" && media !== undefined ? { media } : {}),
        ...(rootPath !== undefined ? { rootPath, ...(owner.cardId !== undefined ? { cardId: owner.cardId } : {}) } : {}),
        browser,
        ...(browserRefusal !== undefined ? { browserRefusal } : {}),
      };
    },
  };
}
