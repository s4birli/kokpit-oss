// Yollar — önizleme: a local web page (and the files next to it) served over HTTP so a project's Chrome can show
// it. "open ~/Documents/rapor/index.html" at the end of a Claude Code session is such a page: an HTML file with
// its CSS, scripts and pictures beside it, usually outside the project folder.
//
// Never `file:` — agents share the project's Chrome, a `file:` page reaches far on the disk and its relative
// assets and security rules are poor. Instead the page gets an address on the engine's own listener (loopback +
// Tailscale only, like the media route): `/files/preview/<token>/<entry file>`.
//
// - The token is bound to the entry file's DIRECTORY (real path): `./style.css`, `img/a.png` and sub-folders load,
//   nothing above it. Each token has its own path prefix, so two previews are two sites path-wise. They share an
//   origin (host:port) with each other and with the media route; a page cannot read another preview because it
//   cannot guess its token, nothing is ever listed, the engine uses no cookies, and the page's CSP only lets it
//   fetch below its own prefix.
// - Which directories: inside the engine user's HOME, the project's / card's folder, or a configured root. Never
//   HOME itself, never a configured top-level folder of HOME (Library…), never through a dot-directory or to a
//   dot-file (`.ssh`, `.claude`, `.config`, `.git`, `.env`). A file directly in a wide folder (Documents, Desktop,
//   Downloads…) is served ALONE: its siblings are other people's files, not its assets.
// - Every request resolves its path anew (all symlinks followed) and must stay inside the root; only regular files
//   of the configured web types, under the size cap; no directory listing (a folder answers its index file or 404).
// - GET / HEAD, one byte range; `nosniff`, `no-store`, `no-referrer`, no CORS header, a CSP made per token.
// - The token belongs to the PROJECT, not to an app connection (the consumer is the project's Chrome): it ends when
//   it has not been used for `tokenTtlMs`, when it is revoked, when the project goes, and with the engine.
// - Tokens are never logged; the log names only the directory's base name.
import { randomBytes } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import type http from "node:http";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { z } from "zod";
import { createRateLimiter, FILES_PREVIEW_HTTP_PREFIX, parseFilesPreviewPath, type FilePreviewUrl } from "@kokpit/shared";
import { engineError, type Logger } from "./contracts.ts";
import { st as sharedText } from "@kokpit/shared/i18n";
import { parseRange } from "./files-media.ts";
import { isStrictlyInside, isWithin, PathSegment } from "./fs-safety.ts";

const posInt = z.number().int().positive();
const absDir = z
  .string()
  .min(2)
  .max(4096)
  .refine((p) => p.startsWith("/") && p.replace(/\/+$/, "") !== "", "kök dizin olmayan mutlak bir yol olmalı");
/** In the policy template: the address prefix of the preview the response belongs to. */
export const CSP_SELF = "{self}";

export const PreviewConfigSchema = z
  .object({
    /** A preview stops working this long after it was opened or last used. */
    tokenTtlMs: posInt,
    tokenBytes: z.number().int().min(24).max(96),
    /** Outstanding previews in total; the oldest is dropped beyond this. */
    maxTokens: posInt,
    /** Outstanding previews of one project; its oldest is dropped beyond this. */
    maxTokensPerProject: posInt,
    /** Largest file that is served. */
    maxBytes: posInt,
    /** Response bodies sent at the same time; further requests answer 503. */
    maxStreams: posInt,
    retryAfterS: posInt,
    chunkBytes: z.number().int().min(1024).max(4194304),
    /** Longest request path below the token (still encoded). */
    maxUrlPathChars: z.number().int().min(64).max(16384),
    /** Previews one project may open: `max` per `windowMs`. */
    rate: z.object({ max: posInt, windowMs: posInt }).strict(),
    /** Directories besides HOME and the project's own folder whose content may be previewed. Empty = none. */
    extraRoots: z.array(absDir).max(32),
    /** Top-level folders of HOME nothing is previewed from. */
    deniedHomeDirs: z.array(PathSegment).max(64),
    /** Top-level folders of HOME from which a file DIRECTLY inside is served alone (no siblings, no sub-folders). */
    singleFileHomeDirs: z.array(PathSegment).max(64),
    /** What a folder address (`sub/`) answers with, first match; none = 404. Never a listing. */
    indexNames: z.array(PathSegment).max(8),
    /** Sent with every file; `{self}` is the preview's own address prefix. */
    contentSecurityPolicy: z.string().min(1).max(4000),
    /** Lower-case extension (no dot) → Content-Type. Extensions not listed are not served. */
    types: z.record(z.string().regex(/^[a-z0-9]{1,10}$/), z.string().regex(/^[a-z]+\/[a-z0-9][a-z0-9.+-]*(?:; charset=utf-8)?$/)),
  })
  .strict();
export type PreviewConfig = z.infer<typeof PreviewConfigSchema>;

export function checkPreviewConfig(cfg: PreviewConfig): void {
  // A page that may post forms anywhere, or a policy that names no source for requests, is not a preview policy.
  for (const directive of ["connect-src", "form-action", "object-src", "base-uri"]) {
    if (!new RegExp(`(^|;)\\s*${directive}\\s`).test(cfg.contentSecurityPolicy)) {
      throw new Error(`invalid files config: preview.contentSecurityPolicy must contain ${directive}`);
    }
  }
}

export interface PreviewService {
  /** The Content-Type a file name would be served with; undefined when its type is not served. */
  typeOf(name: string): string | undefined;
  /**
   * Whether `file` (any path to an existing file) may be previewed, without opening anything: throws the EngineError
   * `issue` would throw. `roots`: the project's / card's folders.
   */
  check(file: string, roots: readonly string[]): { single: boolean };
  /** A preview address for `file`. Throws EngineError (NOT_FOUND, INVALID) with a message for the user. */
  issue(projectId: string, file: string, roots: readonly string[]): FilePreviewUrl;
  /** Ends the preview an address belongs to; unknown ones are ignored. */
  revoke(urlPath: string): void;
  revokeProject(projectId: string): void;
  /** Handles `${FILES_PREVIEW_HTTP_PREFIX}…` requests; false for any other path. */
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  stats(): { tokens: number; activeStreams: number };
  stop(): void;
}

export interface PreviewServiceDeps {
  config: PreviewConfig;
  /** The engine user's home directory. */
  homeDir: string;
  logger: Logger;
  now?: () => number;
}

interface Grant {
  projectId: string;
  /** Real path of the served directory. */
  root: string;
  /** Path of the entry file below the root (one segment). */
  entry: string;
  /** Only `entry` is served. */
  single: boolean;
  expiresAt: number;
}

const MESSAGES = {
  missing: "engine.filesPreview.missing",
  notFile: "engine.filesPreview.notFile",
  unsupported: "engine.filesPreview.unsupported",
  outside: "engine.filesPreview.outside",
  hidden: "engine.filesPreview.hidden",
  home: "engine.filesPreview.home",
  denied: "engine.filesPreview.denied",
  tooLarge: "engine.filesPreview.tooLarge",
  rate: "engine.filesPreview.rate",
  gone: "engine.filesPreview.gone",
  notFound: "engine.filesPreview.notFound",
  busy: "engine.filesPreview.busy",
} as const;

const isDotName = (name: string): boolean => name.startsWith(".");
/** macOS volumes are usually case-insensitive: folder names from the config are compared folded. */
const fold = (s: string): string => s.normalize("NFC").toLowerCase();
/** A `Host` header that can be put into a policy as it is. */
const SAFE_HOST = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

function realDir(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

export function createPreviewService(deps: PreviewServiceDeps): PreviewService {
  const { config: cfg, logger } = deps;
  const now = deps.now ?? Date.now;
  /** Insertion order = issue order, so the first key is the oldest. */
  const grants = new Map<string, Grant>();
  const streams = new Set<{ destroy(): void }>();
  const limiters = new Map<string, { allow(): boolean }>();
  const denied = new Set(cfg.deniedHomeDirs.map(fold));
  const singles = new Set(cfg.singleFileHomeDirs.map(fold));

  const typeOf = (name: string): string | undefined => {
    const ext = extname(name).slice(1).toLowerCase();
    return ext !== "" && Object.hasOwn(cfg.types, ext) ? cfg.types[ext] : undefined;
  };

  const staticHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
  } as const;

  /** The policy of one preview: its own prefix is the only place it may fetch from. */
  function policy(req: http.IncomingMessage, token: string): string {
    const host = req.headers.host;
    const self = typeof host === "string" && SAFE_HOST.test(host) ? `http://${host}${FILES_PREVIEW_HTTP_PREFIX}${token}/` : "'none'";
    return cfg.contentSecurityPolicy.replaceAll(CSP_SELF, self);
  }

  function refuse(res: http.ServerResponse, status: number, message: string, extra: http.OutgoingHttpHeaders = {}): void {
    const body = Buffer.from(`${message}\n`, "utf8");
    res.writeHead(status, {
      ...staticHeaders,
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "text/plain; charset=utf-8",
      "content-length": body.length,
      ...extra,
    });
    res.end(res.req.method === "HEAD" ? undefined : body);
  }

  /**
   * The directory a file would be served from, and whether the file is served alone. `real` is the file's real path.
   * Throws the refusal.
   */
  function rootFor(real: string, roots: readonly string[]): { root: string; single: boolean } {
    const root = dirname(real);
    const home = realDir(deps.homeDir);
    const own = [...roots, ...cfg.extraRoots].map(realDir).filter((r): r is string => r !== undefined && r !== sep);
    // The most specific folder the user named (a project, a card, a configured root) decides; else HOME.
    const named = own.filter((r) => isWithin(r, root)).sort((a, b) => b.length - a.length)[0];
    const inHome = home !== undefined && home !== sep && isWithin(home, root);
    if (named === undefined && !inHome) throw engineError("INVALID", MESSAGES.outside);
    if (home !== undefined && root === home) throw engineError("INVALID", MESSAGES.home);
    const base = named !== undefined && (!inHome || named.length >= home!.length) ? named : home!;
    if (relative(base, real).split(sep).some(isDotName)) throw engineError("INVALID", MESSAGES.hidden);
    let single = false;
    if (inHome) {
      const top = relative(home!, root).split(sep)[0] ?? "";
      // A project's own folder is the user's choice even below such a folder; everything else there is refused.
      if (denied.has(fold(top)) && (named === undefined || !isStrictlyInside(join(home!, top), named))) {
        throw engineError("INVALID", MESSAGES.denied);
      }
      single = singles.has(fold(top)) && root === join(home!, top);
    }
    return { root, single };
  }

  /** `file` as a servable regular file: its real path, or the refusal. */
  function entryOf(file: string): string {
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      throw engineError("NOT_FOUND", MESSAGES.missing);
    }
    let st;
    try {
      st = statSync(real);
    } catch {
      throw engineError("NOT_FOUND", MESSAGES.missing);
    }
    if (!st.isFile()) throw engineError("INVALID", MESSAGES.notFile);
    // The name asked for decides too: a link called `a.html` to `b.sh` is not a page.
    if (typeOf(real) === undefined || typeOf(file) !== typeOf(real)) throw engineError("INVALID", MESSAGES.unsupported);
    if (st.size > cfg.maxBytes) throw engineError("INVALID", MESSAGES.tooLarge);
    return real;
  }

  function prune(): void {
    const t = now();
    for (const [token, g] of grants) if (g.expiresAt <= t) grants.delete(token);
  }

  /**
   * The request path below a token as path segments below the root; null when it is not a clean path (encoded
   * slashes, `..`, dot names, control characters, backslashes).
   */
  function segmentsOf(rest: string): string[] | null {
    if (rest.length > cfg.maxUrlPathChars) return null;
    const out: string[] = [];
    for (const raw of rest.split("/")) {
      if (raw === "") continue;
      let name: string;
      try {
        name = decodeURIComponent(raw);
      } catch {
        return null;
      }
      if (name === "" || isDotName(name) || /[/\\\u0000-\u001f\u007f]/.test(name)) return null;
      out.push(name);
    }
    return out;
  }

  type Served = { fd: number; size: number; mime: string } | { redirect: string } | "missing" | "too-large";

  /** Opens what a request path means inside a grant's root, with every check; the caller closes the descriptor. */
  function open(grant: Grant, segments: string[], trailingSlash: boolean): Served {
    let root: string;
    let real: string;
    try {
      root = realpathSync(grant.root);
      real = realpathSync(join(root, ...segments));
    } catch {
      return "missing";
    }
    // The root moved or became a link: the address no longer means that directory.
    if (root !== grant.root || !isWithin(root, real)) return "missing";
    let st;
    try {
      st = statSync(real);
    } catch {
      return "missing";
    }
    if (st.isDirectory()) {
      if (grant.single) return "missing";
      const index = cfg.indexNames.find((name) => {
        try {
          return statSync(join(real, name)).isFile();
        } catch {
          return false;
        }
      });
      if (index === undefined) return "missing";
      // Relative addresses in the index resolve against the folder only when its address ends with a slash.
      if (!trailingSlash) return { redirect: `${segments.map(encodeURIComponent).join("/")}/` };
      return open(grant, [...segments, index], false);
    }
    const rel = relative(root, real);
    // A link inside the root may point elsewhere inside it — never into a dot folder, never to a dot file.
    if (rel === "" || rel.split(sep).some(isDotName)) return "missing";
    if (grant.single && rel !== grant.entry) return "missing";
    const mime = typeOf(real);
    const asked = segments.at(-1);
    if (!st.isFile() || mime === undefined || asked === undefined || typeOf(asked) !== mime) return "missing";
    if (st.size > cfg.maxBytes) return "too-large";
    let fd: number;
    try {
      // `real` has no symlinks; O_NOFOLLOW refuses one swapped in since, O_NONBLOCK a FIFO swapped in since.
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return "missing";
    }
    let keep = false;
    try {
      const opened = fstatSync(fd);
      // A folder above the file swapped for a link meanwhile: the path must still be this very file, in the root.
      const again = realpathSync(real);
      const onDisk = statSync(again);
      if (again !== real || realpathSync(grant.root) !== grant.root) return "missing";
      if (!opened.isFile() || opened.ino !== onDisk.ino || opened.dev !== onDisk.dev || opened.ino !== st.ino || opened.size > cfg.maxBytes) return "missing";
      keep = true;
      return { fd, size: opened.size, mime };
    } catch {
      return "missing";
    } finally {
      if (!keep) closeSync(fd);
    }
  }

  return {
    typeOf,

    check(file, roots) {
      const { single } = rootFor(entryOf(file), roots);
      return { single };
    },

    issue(projectId, file, roots) {
      const real = entryOf(file);
      const { root, single } = rootFor(real, roots);
      let limiter = limiters.get(projectId);
      if (!limiter) limiters.set(projectId, (limiter = createRateLimiter({ ...cfg.rate, now })));
      if (!limiter.allow()) throw engineError("INVALID", MESSAGES.rate);

      prune();
      const entry = basename(real);
      const expiresAt = now() + cfg.tokenTtlMs;
      // The same directory of the same project is the same site: links between its pages keep working.
      for (const [token, g] of grants) {
        if (g.projectId !== projectId || g.root !== root || g.single !== single || (single && g.entry !== entry)) continue;
        g.expiresAt = expiresAt;
        return { path: `${FILES_PREVIEW_HTTP_PREFIX}${token}/${encodeURIComponent(entry)}`, single, expiresAt: new Date(expiresAt).toISOString() };
      }
      const mine = [...grants].filter(([, g]) => g.projectId === projectId);
      for (const [token] of mine.slice(0, Math.max(0, mine.length - cfg.maxTokensPerProject + 1))) grants.delete(token);
      while (grants.size >= cfg.maxTokens) grants.delete(grants.keys().next().value!);

      const token = randomBytes(cfg.tokenBytes).toString("base64url");
      grants.set(token, { projectId, root, entry, single, expiresAt });
      logger.info("preview opened", { projectId, root: basename(root), single });
      return { path: `${FILES_PREVIEW_HTTP_PREFIX}${token}/${encodeURIComponent(entry)}`, single, expiresAt: new Date(expiresAt).toISOString() };
    },

    revoke(urlPath) {
      const parsed = parseFilesPreviewPath(urlPath);
      if (parsed) grants.delete(parsed.token);
    },

    revokeProject(projectId) {
      for (const [token, g] of grants) if (g.projectId === projectId) grants.delete(token);
      limiters.delete(projectId);
    },

    handleHttp(req, res) {
      const raw = req.url ?? "";
      const query = raw.indexOf("?");
      const pathname = query < 0 ? raw : raw.slice(0, query);
      if (!pathname.startsWith(FILES_PREVIEW_HTTP_PREFIX)) return false;
      if (req.method !== "GET" && req.method !== "HEAD") {
        refuse(res, 405, sharedText(MESSAGES.notFound), { allow: "GET, HEAD" });
        return true;
      }
      const parsed = parseFilesPreviewPath(pathname);
      const grant = parsed ? grants.get(parsed.token) : undefined;
      if (!parsed || !grant || grant.expiresAt <= now()) {
        if (parsed && grant) grants.delete(parsed.token);
        logger.warn("preview url rejected", { reason: !parsed ? "malformed" : grant ? "expired" : "unknown" });
        refuse(res, 404, sharedText(MESSAGES.gone));
        return true;
      }
      const prefix = `${FILES_PREVIEW_HTTP_PREFIX}${parsed.token}/`;
      // Without the slash after the token, relative addresses would resolve one level too high.
      if (parsed.rest === "") {
        res.writeHead(302, { ...staticHeaders, location: `${prefix}${encodeURIComponent(grant.entry)}`, "content-length": 0 });
        res.end();
        return true;
      }
      const segments = segmentsOf(parsed.rest);
      if (segments === null) {
        refuse(res, 404, sharedText(MESSAGES.notFound));
        return true;
      }
      // The site's own address shows the entry file, never a listing.
      const served = segments.length === 0 ? open(grant, [grant.entry], false) : open(grant, segments, parsed.rest.endsWith("/"));
      if (served === "missing" || served === "too-large") {
        refuse(res, 404, sharedText(MESSAGES.notFound));
        return true;
      }
      if ("redirect" in served) {
        res.writeHead(302, { ...staticHeaders, location: `${prefix}${served.redirect}`, "content-length": 0 });
        res.end();
        return true;
      }
      const { fd, size, mime } = served;
      const range = parseRange(req.headers.range, size);
      const headers: http.OutgoingHttpHeaders = { ...staticHeaders, "content-security-policy": policy(req, parsed.token), "content-type": mime, "accept-ranges": "bytes" };
      if (range === "unsatisfiable") {
        closeSync(fd);
        res.writeHead(416, { ...headers, "content-type": "text/plain; charset=utf-8", "content-range": `bytes */${size}`, "content-length": 0 });
        res.end();
        return true;
      }
      const start = range === "full" ? 0 : range.start;
      const end = range === "full" ? size - 1 : range.end;
      const length = end - start + 1;
      headers["content-length"] = length;
      if (range !== "full") headers["content-range"] = `bytes ${start}-${end}/${size}`;
      const status = range === "full" ? 200 : 206;
      grant.expiresAt = now() + cfg.tokenTtlMs;
      if (req.method === "HEAD" || length === 0) {
        closeSync(fd);
        res.writeHead(status, headers);
        res.end();
        return true;
      }
      if (streams.size >= cfg.maxStreams) {
        closeSync(fd);
        logger.warn("preview stream refused", { reason: "too many streams", limit: cfg.maxStreams });
        refuse(res, 503, sharedText(MESSAGES.busy), { "retry-after": String(cfg.retryAfterS) });
        return true;
      }
      // The stream owns the descriptor from here (autoClose).
      const stream = createReadStream("", { fd, start, end, highWaterMark: cfg.chunkBytes, autoClose: true });
      streams.add(stream);
      const done = (): void => {
        streams.delete(stream);
        stream.destroy();
      };
      stream.on("data", () => {
        // A long video counts as use while it plays.
        grant.expiresAt = now() + cfg.tokenTtlMs;
      });
      stream.on("error", () => {
        done();
        res.destroy();
      });
      stream.on("close", done);
      res.on("close", done);
      res.writeHead(status, headers);
      stream.pipe(res);
      return true;
    },

    stats: () => ({ tokens: grants.size, activeStreams: streams.size }),

    stop() {
      grants.clear();
      limiters.clear();
      for (const s of [...streams]) s.destroy();
      streams.clear();
    },
  };
}
