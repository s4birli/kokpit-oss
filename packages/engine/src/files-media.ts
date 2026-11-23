// Dosyalar — medya: one file of a project streamed over HTTP (with Range) for in-app viewing.
//
// Video, audio, images and PDFs do not fit in WebSocket frames and a player needs a URL it can seek in. As for
// the Harita page, the URL lives on the engine's own listener (loopback + Tailscale only) and is reached with an
// unguessable token that an authenticated WebSocket request (`files.mediaUrl`) issues. Tighter than the map:
//
// - The token is bound to ONE already-resolved file (real path inside the project root, same rules as files.read).
//   The HTTP path carries no file name, so there is nothing to traverse; containment, "still a regular file" and
//   the content signature are checked again on every request.
// - The token belongs to the connection that asked for it: it is revoked when that connection drops, when the app
//   says the preview closed (`files.mediaRevoke`), and when it has not been used for `tokenTtlMs`.
// - Only GET and HEAD. One byte range per request (multi-range is refused); nothing is read beyond that range.
// - Content-Type comes from the configured allowlist (extension + magic bytes), never from the file. Types outside
//   the list get no URL at all. Every answer carries `nosniff`, `no-store`, a sandboxing CSP and no CORS header.
// - At most `maxStreams` bodies are sent at once.
// - Tokens are never logged.
import { randomBytes } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import type http from "node:http";
import { basename, extname } from "node:path";
import { z } from "zod";
import { FILE_MEDIA_KINDS, FILES_MEDIA_HTTP_PREFIX, isFilesMediaTokenPath, type FileMediaKind, type FileMediaUrl } from "@kokpit/shared";
import { engineError, type Logger } from "./contracts.ts";
import { isWithin } from "./fs-safety.ts";

const posInt = z.number().int().positive();

/** Content types that may be served: passive media only. Nothing a browser would run as a document or script. */
const PASSIVE_MIME = /^(?:(?:video|audio|image)\/[a-z0-9][a-z0-9.+-]*|application\/pdf)$/;

/** One byte pattern of a file signature: at a fixed offset, or anywhere in the sniffed head. */
const SignaturePartSchema = z
  .object({
    /** Offset of the pattern; absent = anywhere in the first `sniffBytes`. */
    at: z.number().int().min(0).max(4096).optional(),
    /** The pattern as text (ASCII)… */
    text: z.string().min(1).max(64).optional(),
    /** …or as hex bytes. */
    hex: z
      .string()
      .regex(/^(?:[0-9a-f]{2}){1,64}$/i)
      .optional(),
  })
  .strict()
  .refine((p) => (p.text === undefined) !== (p.hex === undefined), "text ya da hex'ten biri olmalı");

export const MediaTypeSchema = z
  .object({
    kind: z.enum(FILE_MEDIA_KINDS),
    mime: z.string().regex(PASSIVE_MIME, "yalnız video/*, audio/*, image/* ya da application/pdf"),
    /** The file matches when ALL parts of ANY one alternative match its first bytes. */
    signatures: z.array(z.array(SignaturePartSchema).min(1).max(8)).min(1).max(16),
  })
  .strict();
export type MediaType = z.infer<typeof MediaTypeSchema>;

export const MediaConfigSchema = z
  .object({
    /** A URL stops working this long after it was issued or last used. */
    tokenTtlMs: posInt,
    tokenBytes: z.number().int().min(24).max(96),
    /** Outstanding URLs in total; the oldest is dropped beyond this. */
    maxTokens: posInt,
    /** Outstanding URLs of one connection; its oldest is dropped beyond this. */
    maxTokensPerConnection: posInt,
    /** Largest file that is streamed. */
    maxBytes: posInt,
    /** Response bodies sent at the same time; further requests answer 503. */
    maxStreams: posInt,
    /** `Retry-After` of that 503 (seconds). */
    retryAfterS: posInt,
    /** Bytes read from the start of a file to check its signature. */
    sniffBytes: z.number().int().min(16).max(65536),
    /** Read size while streaming. */
    chunkBytes: z.number().int().min(1024).max(4194304),
    /** Sent with every file; must sandbox it should it ever be opened as a document. */
    contentSecurityPolicy: z.string().min(1).max(2000),
    /** Lower-case extension (no dot) → what it is served as. Extensions not listed get no URL. */
    types: z.record(z.string().regex(/^[a-z0-9]{1,10}$/), MediaTypeSchema),
  })
  .strict();
export type MediaConfig = z.infer<typeof MediaConfigSchema>;

export function checkMediaConfig(cfg: MediaConfig): void {
  if (!/(^|;)\s*sandbox(\s|;|$)/.test(cfg.contentSecurityPolicy)) {
    throw new Error("invalid files config: media.contentSecurityPolicy must contain a sandbox directive");
  }
}

/** The media type of a file name, by extension (case-insensitive). */
export function mediaTypeOf(cfg: MediaConfig, name: string): MediaType | undefined {
  const ext = extname(name).slice(1).toLowerCase();
  return ext === "" || !Object.hasOwn(cfg.types, ext) ? undefined : cfg.types[ext];
}

function partMatches(head: Buffer, part: MediaType["signatures"][number][number]): boolean {
  const pattern = part.hex !== undefined ? Buffer.from(part.hex, "hex") : Buffer.from(part.text ?? "", "latin1");
  if (part.at === undefined) return head.includes(pattern);
  return head.length >= part.at + pattern.length && head.subarray(part.at, part.at + pattern.length).equals(pattern);
}

/** True when the first bytes of a file carry one of the type's signatures. */
export function matchesSignature(type: MediaType, head: Buffer): boolean {
  return type.signatures.some((alternative) => alternative.every((part) => partMatches(head, part)));
}

/**
 * `inline`, with the file's own name (RFC 5987) — so a viewer that shows or saves a name uses that, not the last
 * segment of the URL, which is the token.
 */
export function inlineDisposition(file: string): string {
  const name = encodeURIComponent(basename(file)).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename*=UTF-8''${name}`;
}

export type ByteRange = { start: number; end: number };

/**
 * One `Range` header against a file of `size` bytes. "full" = no usable range (absent, or another unit): the whole
 * file. "unsatisfiable" = a bytes range that cannot be served: several ranges, reversed or malformed bounds, a start
 * at or past the end, an empty suffix.
 */
export function parseRange(header: string | undefined, size: number): "full" | "unsatisfiable" | ByteRange {
  if (header === undefined) return "full";
  const m = /^\s*bytes\s*=(.*)$/i.exec(header);
  if (!m) return "full";
  const spec = m[1]!.trim();
  const one = /^(\d{0,19})-(\d{0,19})$/.exec(spec);
  if (!one || (one[1] === "" && one[2] === "")) return "unsatisfiable";
  if (one[1] === "") {
    const n = Number(one[2]);
    if (!Number.isSafeInteger(n) || n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(one[1]);
  const end = one[2] === "" ? size - 1 : Math.min(Number(one[2]), size - 1);
  if (!Number.isSafeInteger(start) || Number.isNaN(end) || start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export interface MediaService {
  /** The kind a file name would be shown as, by extension only. */
  kindOf(name: string): FileMediaKind | undefined;
  /**
   * A URL path for one file. `owner` is the asking connection. Throws EngineError: whatever `resolve` throws
   * (leaves the root, missing, hidden), INVALID for a type outside the allowlist, content that does not match its
   * extension, a non-file or a file over the size cap.
   */
  issue(owner: object, root: string, path: string): FileMediaUrl;
  /** Ends one URL of `owner`; someone else's or an unknown one is left alone. */
  revoke(owner: object, urlPath: string): void;
  /** Ends every URL of `owner` (its connection closed). */
  revokeOwner(owner: object): void;
  /** Handles `${FILES_MEDIA_HTTP_PREFIX}…` requests; false for any other path (caller handles it). */
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  stats(): { tokens: number; activeStreams: number; bytesRead: number };
  /** Ends every URL and every running stream. */
  stop(): void;
}

export interface MediaServiceDeps {
  config: MediaConfig;
  /** FileService.resolve: request path → real path inside the root, or EngineError. */
  resolve(root: string, path: string): { rootReal: string; real: string };
  logger: Logger;
  now?: () => number;
}

interface Grant {
  owner: object;
  root: string;
  real: string;
  type: MediaType;
  expiresAt: number;
}

const UNSUPPORTED = "engine.filesMedia.unsupported";
const MISMATCH = "engine.filesMedia.mismatch";
const TOO_LARGE = "engine.filesMedia.tooLarge";
const NOT_A_FILE = "engine.filesMedia.notAFile";
const MISSING = "engine.files.missing";

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const { config: cfg, logger } = deps;
  const now = deps.now ?? Date.now;
  /** Insertion order = issue order, so the first key is the oldest. */
  const grants = new Map<string, Grant>();
  const streams = new Set<{ destroy(): void }>();
  let bytesRead = 0;

  const baseHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": cfg.contentSecurityPolicy,
  } as const;

  function prune(): void {
    const t = now();
    for (const [token, g] of grants) if (g.expiresAt <= t) grants.delete(token);
  }

  function refuse(res: http.ServerResponse, status: number, extra: http.OutgoingHttpHeaders = {}): void {
    res.writeHead(status, { ...baseHeaders, "content-type": "text/plain; charset=utf-8", "content-length": 0, ...extra });
    res.end();
  }

  /** Reads up to `sniffBytes` from the start of an open file. */
  function head(fd: number, size: number): Buffer {
    const buf = Buffer.alloc(Math.min(size, cfg.sniffBytes));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    bytesRead += got;
    return buf.subarray(0, got);
  }

  /**
   * Opens `real` when it is (still) a regular file at that exact real path, inside the root, within the size cap and
   * carrying its type's signature. The caller closes the descriptor.
   */
  function open(root: string, real: string, type: MediaType): { fd: number; size: number } | "missing" | "not-file" | "too-large" | "mismatch" {
    let fd: number;
    try {
      // `real` has no symlinks; O_NOFOLLOW refuses one swapped in for the file since.
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return "missing";
    }
    let keep = false;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return "not-file";
      // A folder above the file replaced by a link, or the project root moved: the path no longer means this file.
      let rootReal: string;
      let again: string;
      try {
        rootReal = realpathSync(root);
        again = realpathSync(real);
      } catch {
        return "missing";
      }
      const onDisk = statSync(again);
      if (again !== real || !isWithin(rootReal, again) || onDisk.ino !== st.ino || onDisk.dev !== st.dev) return "missing";
      if (st.size > cfg.maxBytes) return "too-large";
      if (!matchesSignature(type, head(fd, st.size))) return "mismatch";
      keep = true;
      return { fd, size: st.size };
    } finally {
      if (!keep) closeSync(fd);
    }
  }

  return {
    kindOf: (name) => mediaTypeOf(cfg, name)?.kind,

    issue(owner, root, path) {
      const { real } = deps.resolve(root, path);
      const type = mediaTypeOf(cfg, real);
      // The requested name decides too: a link called `a.mp4` to `b.html` is not a video.
      if (!type || mediaTypeOf(cfg, path) !== type) throw engineError("INVALID", UNSUPPORTED);
      const opened = open(root, real, type);
      if (opened === "missing") throw engineError("NOT_FOUND", MISSING);
      if (opened === "not-file") throw engineError("INVALID", NOT_A_FILE);
      if (opened === "too-large") throw engineError("INVALID", TOO_LARGE);
      if (opened === "mismatch") throw engineError("INVALID", MISMATCH);
      closeSync(opened.fd);

      prune();
      const mine = [...grants].filter(([, g]) => g.owner === owner);
      for (const [token] of mine.slice(0, Math.max(0, mine.length - cfg.maxTokensPerConnection + 1))) grants.delete(token);
      while (grants.size >= cfg.maxTokens) grants.delete(grants.keys().next().value!);

      const token = randomBytes(cfg.tokenBytes).toString("base64url");
      const expiresAt = now() + cfg.tokenTtlMs;
      grants.set(token, { owner, root, real, type, expiresAt });
      return {
        path: `${FILES_MEDIA_HTTP_PREFIX}${token}`,
        kind: type.kind,
        mime: type.mime,
        size: opened.size,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    revoke(owner, urlPath) {
      if (!isFilesMediaTokenPath(urlPath)) return;
      const token = urlPath.slice(FILES_MEDIA_HTTP_PREFIX.length);
      if (grants.get(token)?.owner === owner) grants.delete(token);
    },

    revokeOwner(owner) {
      for (const [token, g] of grants) if (g.owner === owner) grants.delete(token);
    },

    handleHttp(req, res) {
      const raw = req.url ?? "";
      const pathname = raw.split("?")[0] ?? "";
      if (!pathname.startsWith(FILES_MEDIA_HTTP_PREFIX)) return false;
      if (req.method !== "GET" && req.method !== "HEAD") {
        refuse(res, 405, { allow: "GET, HEAD" });
        return true;
      }
      // No query, no sub-path, nothing encoded: the whole URL is the prefix and a token.
      if (!isFilesMediaTokenPath(raw)) {
        refuse(res, 404);
        return true;
      }
      const token = raw.slice(FILES_MEDIA_HTTP_PREFIX.length);
      const grant = grants.get(token);
      if (!grant || grant.expiresAt <= now()) {
        if (grant) grants.delete(token);
        logger.warn("media url rejected", { reason: grant ? "expired" : "unknown" });
        refuse(res, 404);
        return true;
      }
      const opened = open(grant.root, grant.real, grant.type);
      if (typeof opened === "string") {
        // Not the file the URL was issued for any more: the URL is done.
        grants.delete(token);
        logger.warn("media file no longer servable", { reason: opened });
        refuse(res, 404);
        return true;
      }
      const { fd, size } = opened;
      const range = parseRange(req.headers.range, size);
      if (range === "unsatisfiable") {
        closeSync(fd);
        refuse(res, 416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
        return true;
      }
      const start = range === "full" ? 0 : range.start;
      const end = range === "full" ? size - 1 : range.end;
      const length = end - start + 1;
      const headers: http.OutgoingHttpHeaders = {
        ...baseHeaders,
        "content-type": grant.type.mime,
        "content-disposition": inlineDisposition(grant.real),
        "accept-ranges": "bytes",
        "content-length": length,
        ...(range === "full" ? {} : { "content-range": `bytes ${start}-${end}/${size}` }),
      };
      const status = range === "full" ? 200 : 206;
      if (req.method === "HEAD" || length === 0) {
        closeSync(fd);
        grant.expiresAt = now() + cfg.tokenTtlMs;
        res.writeHead(status, headers);
        res.end();
        return true;
      }
      if (streams.size >= cfg.maxStreams) {
        closeSync(fd);
        logger.warn("media stream refused", { reason: "too many streams", limit: cfg.maxStreams });
        refuse(res, 503, { "retry-after": String(cfg.retryAfterS) });
        return true;
      }
      grant.expiresAt = now() + cfg.tokenTtlMs;
      // The stream owns the descriptor from here (autoClose).
      const stream = createReadStream("", { fd, start, end, highWaterMark: cfg.chunkBytes, autoClose: true });
      streams.add(stream);
      const done = (): void => {
        streams.delete(stream);
        stream.destroy();
      };
      stream.on("data", (chunk) => {
        bytesRead += chunk.length;
        // Playing counts as use: a long video outlives the idle deadline while it is being watched.
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

    stats: () => ({ tokens: grants.size, activeStreams: streams.size, bytesRead }),

    stop() {
      grants.clear();
      for (const s of [...streams]) s.destroy();
      streams.clear();
    },
  };
}
