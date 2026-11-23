// Shared building blocks for engine features that read from a project folder (Harita, Dosyalar):
// path containment on real (symlink-resolved) paths, single-segment names, and per-feature defaults files.
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { z } from "zod";

/**
 * Modes of everything the engine writes that only the engine's user may read: key and token files, generated
 * configs with a credential, private state — and the directories that hold them. One definition for all modules.
 */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

/** One path segment: no separators, not "." or "..". */
export const PathSegment = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !s.includes("/") && !s.includes("\\") && s !== "." && s !== "..", "tek klasör adı olmalı");

/** True when `real` lies strictly below `realDir`. Both must already be real paths (realpathSync). */
export function isStrictlyInside(realDir: string, real: string): boolean {
  const base = realDir.endsWith(sep) ? realDir : realDir + sep;
  return real.startsWith(base) && real.length > base.length;
}

/** `realDir` itself or anything below it. */
export function isWithin(realDir: string, real: string): boolean {
  return real === realDir || isStrictlyInside(realDir, real);
}

/**
 * Reads a JSON defaults file shipped with the engine, applies `overrides` key by key and validates the result.
 * Throws `invalid <label> config: <field>: <reason>` (or `cannot read <label> defaults …`).
 */
export function loadDefaultsFile<S extends z.ZodType<object>>(
  schema: S,
  overrides: object,
  path: string,
  label: string,
): z.infer<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${label} defaults ${path}: ${(err as Error).message}`);
  }
  const r = schema.safeParse({ ...(raw as object), ...overrides });
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`invalid ${label} config: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
  }
  return r.data;
}
