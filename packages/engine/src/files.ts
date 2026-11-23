// İş F — Dosyalar: read-only browsing of a project (or card worktree) folder.
//
// Every access resolves the requested path to its real path (all symlinks followed) and refuses it unless
// that real path is the root's real path or below it. So a symlink inside the project may point elsewhere
// inside the project, never outside. The request path is taken literally: no URL decoding, no `..`, no
// absolute paths, no backslashes or NUL. Hidden names (`.git` by default) are refused wherever they appear,
// in the request or in the resolved path, and never listed. Listing and reading are capped by config.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MAX_MESSAGE_BYTES, type FileEntry, type FileReadResult } from "@kokpit/shared";
import { engineError } from "./contracts.ts";
import { checkMediaConfig, MediaConfigSchema, mediaTypeOf } from "./files-media.ts";
import { checkPreviewConfig, PreviewConfigSchema } from "./files-preview.ts";
import { PathsConfigSchema } from "./local-paths.ts";
import { OpenConfigSchema } from "./terminal-open.ts";
import { isWithin, PathSegment } from "./fs-safety.ts";

export const FILES_DEFAULTS_PATH = fileURLToPath(new URL("../files.defaults.json", import.meta.url));

/** Room left in a frame for the envelope around the payload. */
const FRAME_OVERHEAD = 4096;
/** Worst-case JSON growth of one input byte (a control character becomes `\u00XX`). */
const JSON_ESCAPE_FACTOR = 6;
/** Largest entry JSON: a 255-byte name, fully escaped, plus the other fields. */
const MAX_ENTRY_CHARS = 255 * JSON_ESCAPE_FACTOR + 128;

/** Upper bounds that keep every answer inside one protocol frame. */
export const FILES_MAX_READ_BYTES = Math.floor((MAX_MESSAGE_BYTES - FRAME_OVERHEAD) / JSON_ESCAPE_FACTOR);
export const FILES_MAX_ENTRIES = Math.floor((MAX_MESSAGE_BYTES - FRAME_OVERHEAD) / MAX_ENTRY_CHARS);

export const FilesConfigSchema = z
  .object({
    /** Names never listed nor reachable, at any depth (e.g. ".git"). */
    hiddenNames: z.array(PathSegment).max(100),
    /** Entries returned for one folder; the rest is reported as `truncated`. */
    maxEntries: z.number().int().min(1).max(FILES_MAX_ENTRIES),
    /** Bytes of a file returned for preview. */
    maxReadBytes: z.number().int().min(1).max(FILES_MAX_READ_BYTES),
    /** Streaming of video, audio, images and PDFs for in-app viewing (files-media.ts). */
    media: MediaConfigSchema,
    /** Yollar: a local web page and the files next to it, served for a project's browser (files-preview.ts). */
    preview: PreviewConfigSchema,
    /** Yollar: resolving a path a terminal printed (local-paths.ts). */
    paths: PathsConfigSchema,
    /** Yollar: `open` run in a Kokpit terminal shows pages in the project's browser (terminal-open.ts). */
    open: OpenConfigSchema,
  })
  .strict();
export type FilesConfig = z.infer<typeof FilesConfigSchema>;

/** Sections merged one level down: an override names only the keys it changes. */
const SECTIONS = ["media", "preview", "paths", "open"] as const;

/** The `files` key of engine.json: any subset of the defaults. */
export const FilesConfigOverrideSchema = FilesConfigSchema.omit({ media: true, preview: true, paths: true, open: true })
  .partial()
  .extend({
    media: MediaConfigSchema.partial().strict().optional(),
    preview: PreviewConfigSchema.partial().strict().optional(),
    paths: PathsConfigSchema.partial().strict().optional(),
    open: OpenConfigSchema.partial().strict().optional(),
  })
  .strict();
export type FilesConfigOverride = z.infer<typeof FilesConfigOverrideSchema>;

/**
 * Defaults file + overrides, key by key; `media`, `preview`, `paths` and `open` are merged one level down (a `types`
 * table is replaced as a whole).
 */
export function loadFilesConfig(overrides: FilesConfigOverride, path: string = FILES_DEFAULTS_PATH): FilesConfig {
  let raw: Partial<Record<(typeof SECTIONS)[number], object>>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as typeof raw;
  } catch (err) {
    throw new Error(`cannot read files defaults ${path}: ${(err as Error).message}`);
  }
  const sections = Object.fromEntries(SECTIONS.map((name) => [name, { ...raw[name], ...overrides[name] }]));
  const r = FilesConfigSchema.safeParse({ ...raw, ...overrides, ...sections });
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`invalid files config: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
  }
  checkMediaConfig(r.data.media);
  checkPreviewConfig(r.data.preview);
  return r.data;
}

export interface FileService {
  /** Throws EngineError: INVALID (leaves the root, not a folder), NOT_FOUND (missing or hidden). */
  list(root: string, path: string): { entries: FileEntry[]; truncated: boolean };
  /** Throws EngineError: INVALID (leaves the root, not a file), NOT_FOUND (missing or hidden). */
  read(root: string, path: string): FileReadResult;
  /**
   * A request path as its real path inside the root (all symlinks followed), with the same refusals as `list` and
   * `read`. For features that hand the file on (media streaming).
   */
  resolve(root: string, path: string): { rootReal: string; real: string };
}

const OUTSIDE = "engine.files.outside";
const BAD_PATH = "engine.files.badPath";
const MISSING = "engine.files.missing";
const ROOT_MISSING = "engine.files.rootMissing";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function createFileService(deps: { config: FilesConfig }): FileService {
  const cfg = deps.config;
  // macOS volumes are usually case- and normalisation-insensitive: compare folded names.
  const fold = (s: string): string => s.normalize("NFC").toLowerCase();
  const hiddenSet = new Set(cfg.hiddenNames.map(fold));
  const hidden = { has: (s: string): boolean => hiddenSet.has(fold(s)) };

  /** Request path → segments below the root. Literal: nothing is decoded. */
  function segments(path: string): string[] {
    if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
      throw engineError("INVALID", path.startsWith("/") ? OUTSIDE : BAD_PATH);
    }
    const parts = path.split("/").filter((s) => s !== "" && s !== ".");
    if (parts.includes("..")) throw engineError("INVALID", OUTSIDE);
    if (parts.some((s) => hidden.has(s))) throw engineError("NOT_FOUND", MISSING);
    return parts;
  }

  function realRoot(root: string): string {
    try {
      const real = realpathSync(root);
      if (statSync(real).isDirectory()) return real;
    } catch {
      /* below */
    }
    throw engineError("NOT_FOUND", ROOT_MISSING);
  }

  /** True when `real` (inside the root) passes through a hidden name. */
  function hiddenBelow(rootReal: string, real: string): boolean {
    const rel = relative(rootReal, real);
    return rel !== "" && rel.split(sep).some((s) => hidden.has(s));
  }

  /** Resolves a request path to a real path inside the root. */
  function resolve(root: string, path: string): { rootReal: string; real: string } {
    const parts = segments(path);
    const rootReal = realRoot(root);
    let real: string;
    try {
      real = realpathSync(join(rootReal, ...parts));
    } catch {
      throw engineError("NOT_FOUND", MISSING);
    }
    if (!isWithin(rootReal, real)) throw engineError("INVALID", OUTSIDE);
    // A link into a hidden folder looks missing.
    if (hiddenBelow(rootReal, real)) throw engineError("NOT_FOUND", MISSING);
    return { rootReal, real };
  }

  /** What a symlink entry points to, when that is a dir/file inside the root (and not hidden). */
  function linkTarget(rootReal: string, full: string): "dir" | "file" | undefined {
    try {
      const real = realpathSync(full);
      if (!isWithin(rootReal, real) || hiddenBelow(rootReal, real)) return undefined;
      const st = statSync(real);
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    resolve,

    list(root, path) {
      const { rootReal, real: dir } = resolve(root, path);
      if (!statSync(dir).isDirectory()) throw engineError("INVALID", "engine.files.notAFolder");
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        throw engineError("NOT_FOUND", MISSING);
      }
      const all: FileEntry[] = [];
      for (const d of dirents) {
        if (hidden.has(d.name)) continue;
        if (d.isSymbolicLink()) {
          const target = linkTarget(rootReal, join(dir, d.name));
          all.push({ name: d.name, kind: "symlink", ...(target ? { target } : {}) });
        } else if (d.isDirectory()) {
          all.push({ name: d.name, kind: "dir" });
        } else if (d.isFile()) {
          all.push({ name: d.name, kind: "file" });
        }
      }
      const isDirLike = (e: FileEntry) => e.kind === "dir" || e.target === "dir";
      all.sort(
        (a, b) =>
          Number(isDirLike(b)) - Number(isDirLike(a)) ||
          collator.compare(a.name, b.name) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
      const entries = all.slice(0, cfg.maxEntries).map((e) => {
        if (e.kind !== "file") return e;
        try {
          return { ...e, size: lstatSync(join(dir, e.name)).size };
        } catch {
          return e;
        }
      });
      return { entries, truncated: all.length > entries.length };
    },

    read(root, path) {
      const file = resolve(root, path).real;
      let fd: number;
      try {
        // The real path has no symlinks; O_NOFOLLOW refuses one swapped in since.
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        throw engineError("NOT_FOUND", MISSING);
      }
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw engineError("INVALID", "engine.filesPreview.notFile");
        const size = st.size;
        const buf = Buffer.alloc(Math.min(size, cfg.maxReadBytes));
        let got = 0;
        while (got < buf.length) {
          const n = readSync(fd, buf, got, buf.length - got, got);
          if (n === 0) break;
          got += n;
        }
        const head = buf.subarray(0, got);
        const truncated = size > got;
        const text = decodeText(head, truncated);
        // By name only (the requested one and the one it resolves to); files.mediaUrl checks the content.
        const type = mediaTypeOf(cfg.media, file);
        const media = type && mediaTypeOf(cfg.media, path) === type ? { media: type.kind } : {};
        return text === null ? { binary: true, size, truncated: false, ...media } : { text, size, truncated, ...media };
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** UTF-8 text without NUL bytes, else null. A cut file may end inside a character: that tail is dropped. */
export function decodeText(bytes: Buffer, cut: boolean): string | null {
  if (bytes.includes(0)) return null;
  try {
    // `stream` keeps an incomplete trailing sequence instead of failing on it.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cut });
  } catch {
    return null;
  }
}
