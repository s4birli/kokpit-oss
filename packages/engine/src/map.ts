// İş C — Harita: the project's graphify map (`<project>/graphify-out/**/graph.html`, newest).
//
// The map is served over HTTP on the engine's own listener, never over the WebSocket: real graphify
// output is larger than MAX_MESSAGE_BYTES, and an iframe needs a URL. Access is by a one-time,
// short-lived random token that `map.token` (an authenticated WebSocket request) issues. The token
// is bound to one already-resolved file; the HTTP path never carries a file name, so there is no
// path to traverse. Symlinks are never followed, and containment is checked again at serve time.
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type http from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isMapTokenPath, MAP_HTTP_PREFIX, projectGitPath, type MapInfo, type Project } from "@kokpit/shared";
import { engineError, type Logger } from "./contracts.ts";
import { isStrictlyInside, loadDefaultsFile, PathSegment } from "./fs-safety.ts";

export const MAP_DEFAULTS_PATH = fileURLToPath(new URL("../map.defaults.json", import.meta.url));

const Segment = PathSegment;
const posInt = z.number().int().positive();

export const MapConfigSchema = z
  .object({
    /** Folder under the project root that holds graphify output. */
    dirName: Segment,
    /** File-name pattern (`*`, `?`) of a map file. */
    fileGlob: Segment,
    /** How many folder levels below `dirName` are searched (0 = only `dirName` itself). */
    maxDepth: z.number().int().min(0).max(20),
    /** Directory entries looked at before giving up (bounds the walk). */
    maxEntries: posInt,
    /** Largest map file that is served. */
    maxBytes: posInt,
    tokenTtlMs: posInt,
    /** Outstanding tokens kept; the oldest is dropped beyond this. */
    maxTokens: posInt,
    tokenBytes: z.number().int().min(16).max(96),
    /** Typed into a project terminal by "Haritayı güncelle". */
    updateCommand: z.string().trim().min(1).max(1000),
    /** Sent with the map; must sandbox it (opaque origin) even if opened outside the app's iframe. */
    contentSecurityPolicy: z.string().min(1).max(4000),
  })
  .strict();
export type MapConfig = z.infer<typeof MapConfigSchema>;

/** The `map` key of engine.json: any subset of the defaults. */
export const MapConfigOverrideSchema = MapConfigSchema.partial().strict();
export type MapConfigOverride = z.infer<typeof MapConfigOverrideSchema>;

export function loadMapConfig(overrides: MapConfigOverride, path: string = MAP_DEFAULTS_PATH): MapConfig {
  const cfg = loadDefaultsFile(MapConfigSchema, overrides, path, "map");
  if (!/(^|;)\s*sandbox(\s|;|$)/.test(cfg.contentSecurityPolicy)) {
    throw new Error("invalid map config: contentSecurityPolicy must contain a sandbox directive");
  }
  return cfg;
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

export interface FoundMap {
  /** Absolute path (no symlinks below the project root). */
  file: string;
  /** Relative to the project root. */
  relative: string;
  mtimeMs: number;
  size: number;
}

/** `<root>/<dirName>` when it is a real directory (not a symlink), else null. */
function mapDir(projectRoot: string, cfg: MapConfig): string | null {
  const dir = join(projectRoot, cfg.dirName);
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? dir : null;
  } catch {
    return null;
  }
}

/** Newest file matching `fileGlob` under `<projectRoot>/<dirName>`, without following symlinks. */
export function findNewestMap(projectRoot: string, cfg: MapConfig): FoundMap | null {
  const top = mapDir(projectRoot, cfg);
  if (!top) return null;
  const match = globToRegExp(cfg.fileGlob);
  let budget = cfg.maxEntries;
  let best: FoundMap | null = null;
  const queue: { dir: string; depth: number }[] = [{ dir: top, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (--budget < 0) return null;
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < cfg.maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile() || !match.test(e.name)) continue;
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      const rel = relative(projectRoot, full);
      if (!best || st.mtimeMs > best.mtimeMs || (st.mtimeMs === best.mtimeMs && rel > best.relative)) {
        best = { file: full, relative: rel, mtimeMs: st.mtimeMs, size: st.size };
      }
    }
  }
  return best;
}

export interface MapService {
  info(project: Project): MapInfo;
  /** Throws EngineError: INVALID for ssh projects, NOT_FOUND without a map, INVALID when too large. */
  issueToken(project: Project): { path: string; expiresAt: string };
  /** Handles `${MAP_HTTP_PREFIX}…` requests; false for any other path (caller handles it). */
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export interface MapServiceDeps {
  config: MapConfig;
  logger: Logger;
  now?: () => number;
}

interface Grant {
  projectRoot: string;
  file: string;
  expiresAt: number;
}

export function createMapService(deps: MapServiceDeps): MapService {
  const { config: cfg, logger } = deps;
  const now = deps.now ?? Date.now;
  /** Insertion order = issue order, so the first key is the oldest. */
  const grants = new Map<string, Grant>();

  function rootOf(project: Project): string | null {
    return project.location.kind === "ssh" ? null : projectGitPath(project);
  }

  /** Real path of `file` when it is a regular file inside the project's (real, non-symlink) map dir. */
  function contained(projectRoot: string, file: string): string | null {
    const dir = mapDir(projectRoot, cfg);
    if (!dir) return null;
    try {
      const realDir = realpathSync(dir);
      const realFile = realpathSync(file);
      if (!isStrictlyInside(realDir, realFile)) return null;
      if (lstatSync(file).isSymbolicLink() || !statSync(realFile).isFile()) return null;
      return realFile;
    } catch {
      return null;
    }
  }

  function prune(): void {
    const t = now();
    for (const [token, g] of grants) if (g.expiresAt <= t) grants.delete(token);
  }

  function notFound(res: http.ServerResponse): void {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("not found");
  }

  return {
    info(project) {
      const root = rootOf(project);
      if (!root) return { available: false };
      const found = findNewestMap(root, cfg);
      if (!found) return { available: false, updateCommand: cfg.updateCommand };
      return {
        available: true,
        file: found.relative,
        generatedAt: new Date(found.mtimeMs).toISOString(),
        updateCommand: cfg.updateCommand,
      };
    },

    issueToken(project) {
      const root = rootOf(project);
      if (!root) throw engineError("INVALID", "engine.map.sshNoMap");
      const found = findNewestMap(root, cfg);
      if (!found || !contained(root, found.file)) throw engineError("NOT_FOUND", "engine.map.noMap");
      if (found.size > cfg.maxBytes) throw engineError("INVALID", "engine.map.tooLarge");
      prune();
      while (grants.size >= cfg.maxTokens) grants.delete(grants.keys().next().value!);
      const token = randomBytes(cfg.tokenBytes).toString("base64url");
      const expiresAt = now() + cfg.tokenTtlMs;
      grants.set(token, { projectRoot: root, file: found.file, expiresAt });
      return { path: `${MAP_HTTP_PREFIX}${token}`, expiresAt: new Date(expiresAt).toISOString() };
    },

    handleHttp(req, res) {
      const raw = req.url ?? "";
      const pathname = raw.split("?")[0] ?? "";
      if (!pathname.startsWith(MAP_HTTP_PREFIX)) return false;
      if (req.method !== "GET" || !isMapTokenPath(pathname)) {
        notFound(res);
        return true;
      }
      const token = pathname.slice(MAP_HTTP_PREFIX.length);
      const grant = grants.get(token);
      grants.delete(token);
      if (!grant || grant.expiresAt < now()) {
        logger.warn("map token rejected", { reason: grant ? "expired" : "unknown" });
        notFound(res);
        return true;
      }
      const real = contained(grant.projectRoot, grant.file);
      let body: Buffer | null = null;
      if (real) {
        try {
          if (statSync(real).size <= cfg.maxBytes) body = readFileSync(real);
        } catch {
          body = null;
        }
      }
      if (!body) {
        logger.warn("map file no longer servable", { file: grant.file });
        notFound(res);
        return true;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": cfg.contentSecurityPolicy,
      });
      res.end(body);
      return true;
    },
  };
}
