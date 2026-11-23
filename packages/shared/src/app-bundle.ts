// Kendini güncelleme: the format an app build travels in from the engine to the apps — Kokpit's own, because both
// ends are ours and the app must be the ONLY parser of what it installs.
//
//   entries   a JSON list, one record per directory, file and symbolic link of the .app bundle, parents first:
//               { path, type: "dir" }
//               { path, type: "file", mode: 0o644 | 0o755, size, sha256 }
//               { path, type: "symlink", target }
//   blob      the contents of the `file` records, concatenated in list order, gzip-compressed as one stream
//
// The entry list travels over the authenticated WebSocket; the blob over HTTP, checked against the SHA-256 in the
// manifest and then, file by file, against the list. There is no archive format and no second parser: the app
// creates exactly the directories, files and links the validated list names, and nothing else.
//
// Why not a zip: a zip checked by one parser and unpacked by another (ditto) can mean two things — extra fields
// that rename entries, names that only differ in case or Unicode form on a Mac's disk, sizes that lie. Here names
// are plain ASCII from a short alphabet, compared case-insensitively, and every byte written is counted and hashed.
import { z } from "zod";
import { st } from "./i18n/catalog.ts";

export const BUNDLE_FORMAT = 1;

/** One path component: letters, digits, space and `._+@()-`. No slash, no backslash, nothing outside ASCII. */
const COMPONENT_RE = /^[A-Za-z0-9 ._+@()-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_PATH_CHARS = 1024;
/** A link may point at a link (frameworks do: `Resources → Versions/Current/Resources`, `Current → A`); this deep. */
const MAX_LINK_HOPS = 8;
/**
 * A link target is short and simple in a real bundle (`Versions/Current/Resources`, `A`). Bounding it bounds the
 * work of checking a list: links × parts × hops, never more (a list cannot make the app spin).
 */
export const MAX_LINK_TARGET_CHARS = 256;
export const MAX_LINK_TARGET_PARTS = 16;
/** Ceiling of symbolic links whatever a config says (BundleLimits.maxLinks may only lower it). */
export const MAX_LINKS = 1024;
export const BUNDLE_FILE_MODES = [0o644, 0o755] as const;

const PathSchema = z.string().min(1).max(MAX_PATH_CHARS);
export const BundleEntrySchema = z.discriminatedUnion("type", [
  z.object({ path: PathSchema, type: z.literal("dir") }).strict(),
  z
    .object({
      path: PathSchema,
      type: z.literal("file"),
      mode: z.union([z.literal(BUNDLE_FILE_MODES[0]), z.literal(BUNDLE_FILE_MODES[1])]),
      size: z.number().int().min(0),
      sha256: z.string().regex(SHA256_RE),
    })
    .strict(),
  z.object({ path: PathSchema, type: z.literal("symlink"), target: z.string().min(1).max(MAX_LINK_TARGET_CHARS) }).strict(),
]);
export type BundleEntry = z.infer<typeof BundleEntrySchema>;

export interface BundleLimits {
  maxEntries: number;
  /** Symbolic links in the bundle (a real Electron bundle has about a dozen). */
  maxLinks: number;
  /** Largest single file. */
  maxFileBytes: number;
  /** Largest sum of all file sizes. */
  maxTotalBytes: number;
}

/** i18n: the rules a bundle list can break, by their `validation.bundle.*` key. */
type BundleRule = "notList" | "empty" | "tooManyEntries" | "entryFormat" | "path" | "duplicatePath" | "parentFirst" | "tooManyLinks" | "linkTooComplex" | "fileTooLarge" | "totalTooLarge" | "linkOutside";

export class BundleFormatError extends Error {
  /** `index` of the offending record, when there is one. Messages never quote a record's content. */
  constructor(ruleKey: BundleRule, index?: number) {
    const rule = st(`validation.bundle.${ruleKey}`);
    super(index === undefined ? st("validation.bundle.invalid", { rule }) : st("validation.bundle.invalidAt", { rule, index }));
    this.name = "BundleFormatError";
  }
}

/** A bundle's folder name: one plain component ending in `.app`. */
export function isBundleName(name: string): boolean {
  return COMPONENT_RE.test(name) && name.endsWith(".app") && name !== ".app";
}

function components(path: string): string[] | undefined {
  const parts = path.split("/");
  return parts.every((p) => COMPONENT_RE.test(p) && p !== "." && p !== "..") ? parts : undefined;
}

/** Names that are one file on a Mac's (case-insensitive) disk are one name here. The alphabet is ASCII-only. */
const fold = (path: string): string => path.toLowerCase();

/**
 * Checks a whole entry list — before a single byte is written. Throws BundleFormatError unless:
 * - it is an array of at most `maxEntries` well-formed records (no unknown fields);
 * - every path is relative, `/`-separated, each component from the plain alphabet, none empty, `.` or `..`;
 * - no path occurs twice, also not when case is ignored;
 * - every record's parent is the bundle root or a directory listed BEFORE it (so nothing is ever created inside
 *   a link, or inside something that is not there yet);
 * - every link target is relative and, followed through the list itself (links to links included), ends at a
 *   listed file or directory without ever leaving the bundle;
 * - file sizes are within `maxFileBytes`, their sum within `maxTotalBytes`.
 * Returns the records, typed.
 */
export function validateBundleEntries(raw: unknown, limits: BundleLimits): BundleEntry[] {
  if (!Array.isArray(raw)) throw new BundleFormatError("notList");
  if (raw.length === 0) throw new BundleFormatError("empty");
  if (raw.length > limits.maxEntries) throw new BundleFormatError("tooManyEntries");
  const entries: BundleEntry[] = [];
  const byPath = new Map<string, BundleEntry>();
  let total = 0;
  let links = 0;
  const maxLinks = Math.min(limits.maxLinks ?? MAX_LINKS, MAX_LINKS);
  for (const [index, item] of raw.entries()) {
    const parsed = BundleEntrySchema.safeParse(item);
    if (!parsed.success) throw new BundleFormatError("entryFormat", index);
    const e = parsed.data;
    const parts = components(e.path);
    if (!parts) throw new BundleFormatError("path", index);
    const key = fold(e.path);
    if (byPath.has(key)) throw new BundleFormatError("duplicatePath", index);
    if (parts.length > 1) {
      const parent = byPath.get(fold(parts.slice(0, -1).join("/")));
      // The parent must be listed with exactly this spelling, and be a real directory.
      if (!parent || parent.type !== "dir" || parent.path !== parts.slice(0, -1).join("/")) throw new BundleFormatError("parentFirst", index);
    }
    if (e.type === "symlink") {
      if (++links > maxLinks) throw new BundleFormatError("tooManyLinks", index);
      if (e.target.split("/").length > MAX_LINK_TARGET_PARTS) throw new BundleFormatError("linkTooComplex", index);
    }
    if (e.type === "file") {
      if (e.size > limits.maxFileBytes) throw new BundleFormatError("fileTooLarge", index);
      total += e.size;
      if (total > limits.maxTotalBytes) throw new BundleFormatError("totalTooLarge", index);
    }
    byPath.set(key, e);
    entries.push(e);
  }

  /** Where each link ends (memo): a chain is followed once, however many links pass through it. */
  const linkEnds = new Map<string, string | undefined>();
  /** Follows `target` from the directory `from` through the list; the listed path it ends at, or undefined. */
  const resolve = (from: string[], target: string, hops: number): string | undefined => {
    if (hops > MAX_LINK_HOPS || target.startsWith("/")) return undefined;
    const at = [...from];
    const todo = target.split("/");
    for (let i = 0; i < todo.length; i++) {
      const part = todo[i]!;
      if (part === "..") {
        if (at.length === 0) return undefined; // above the bundle root
        at.pop();
        continue;
      }
      if (!COMPONENT_RE.test(part) || part === ".") return undefined;
      at.push(part);
      const here = byPath.get(fold(at.join("/")));
      if (!here || here.path !== at.join("/")) return undefined; // dangling, or another spelling
      if (here.type === "symlink") {
        const rest = todo.slice(i + 1).join("/");
        const key = here.path;
        let via: string | undefined;
        if (linkEnds.has(key) && hops === 0) via = linkEnds.get(key);
        else {
          via = resolve(at.slice(0, -1), here.target, hops + 1);
          if (hops === 0) linkEnds.set(key, via);
        }
        if (via === undefined) return undefined;
        return rest === "" ? via : resolve(via.split("/"), rest, hops + 1);
      }
      if (here.type === "file" && i < todo.length - 1) return undefined; // a file is not a folder
    }
    return at.length === 0 ? undefined : at.join("/");
  };
  for (const [index, e] of entries.entries()) {
    if (e.type !== "symlink") continue;
    if (resolve(e.path.split("/").slice(0, -1), e.target, 0) === undefined) throw new BundleFormatError("linkOutside", index);
  }
  return entries;
}

/** Sum of the file sizes of a validated list. */
export function bundleUnpackedSize(entries: readonly BundleEntry[]): number {
  let total = 0;
  for (const e of entries) if (e.type === "file") total += e.size;
  return total;
}
