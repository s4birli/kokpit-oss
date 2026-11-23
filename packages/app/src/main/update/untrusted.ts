// Kendini güncelleme: the engine's answers are untrusted input — also on the authenticated socket. The key proves
// who is talking, not that what it says is well-formed: a buggy or taken-over engine must not be able to name a
// file outside the staging folder or point the download at another host. Everything the updater takes from an
// answer passes through here first; error messages name the field, never the offending value.
import { z } from "zod";
import {
  AppUpdateManifestSchema,
  BuildInfoSchema,
  BundleFormatError,
  isAppUpdateTokenPath,
  validateBundleEntries,
  type AppUpdateManifest,
  type BundleEntry,
  type EngineIdentity,
} from "@kokpit/shared";
import type { UpdateConfig } from "./config.ts";
import { entriesMatchManifest } from "./signature.ts";
import { bundleLimitsOf } from "./verify.ts";
import { t } from "../../i18n/index.ts";

export class UntrustedError extends Error {
  constructor(what: string) {
    super(t("update.untrusted.invalid", { what }));
    this.name = "UntrustedError";
  }
}

const CheckResultSchema = z.object({
  engine: z.object({ build: BuildInfoSchema, protocol: z.number().int().min(0).max(1_000_000) }),
  update: AppUpdateManifestSchema.nullable(),
});

const fieldOf = (err: z.ZodError): string => err.issues[0]?.path.map(String).join(".") || t("update.untrusted.format");

type Caps = Pick<UpdateConfig, "maxArchiveBytes" | "maxBundleFiles" | "maxBundleLinks" | "maxFileBytes" | "maxUnpackedBytes">;

/**
 * Validated entry lists by their signed hash: a list is checked once per build, not on every download attempt.
 * Two builds at most are ever in play (the staged one and the next).
 */
const validatedLists = new Map<string, BundleEntry[]>();
const VALIDATED_LISTS_KEPT = 2;

/** The answer to `app.update.check`: shape, build id and bundle name (plain names, never paths), hash, sizes within the caps. */
export function parseCheckResult(raw: unknown, cfg: Caps): { engine: EngineIdentity; update: AppUpdateManifest | null } {
  const r = CheckResultSchema.safeParse(raw);
  if (!r.success) throw new UntrustedError(fieldOf(r.error));
  const u = r.data.update;
  if (u && u.size > cfg.maxArchiveBytes) throw new UntrustedError("update.size");
  if (u && u.unpackedSize > cfg.maxUnpackedBytes) throw new UntrustedError("update.unpackedSize");
  if (u && u.entryCount > cfg.maxBundleFiles) throw new UntrustedError("update.entryCount");
  return r.data;
}

const DownloadResultSchema = z.object({
  path: z.string().max(300).refine(isAppUpdateTokenPath),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.unknown(),
});

/**
 * The answer to `app.update.download`: the expected route and nothing else, for exactly the manifest's blob, and
 * an entry list that is valid as a whole (app-bundle.ts) and adds up to what the manifest announced.
 */
export function parseDownloadResult(raw: unknown, manifest: Pick<AppUpdateManifest, "size" | "sha256" | "entryCount" | "unpackedSize" | "entriesSha256">, cfg: Caps): { path: string; entries: BundleEntry[] } {
  const r = DownloadResultSchema.safeParse(raw);
  if (!r.success) throw new UntrustedError(`download.${fieldOf(r.error)}`);
  if (r.data.size !== manifest.size || r.data.sha256 !== manifest.sha256) throw new UntrustedError(`download: ${t("update.untrusted.notManifest")}`);
  // The list must be the one the (verified) signature covers — checked before the list is looked at any further.
  if (!entriesMatchManifest(r.data.entries, manifest)) throw new UntrustedError(`download.entries: ${t("update.untrusted.notSigned")}`);
  let entries = validatedLists.get(manifest.entriesSha256);
  if (!entries) {
    try {
      entries = validateBundleEntries(r.data.entries, bundleLimitsOf(cfg));
    } catch (err) {
      if (err instanceof BundleFormatError) throw new UntrustedError(err.message);
      throw err;
    }
    validatedLists.set(manifest.entriesSha256, entries);
    while (validatedLists.size > VALIDATED_LISTS_KEPT) validatedLists.delete(validatedLists.keys().next().value!);
  }
  const unpacked = entries.reduce((sum, e) => sum + (e.type === "file" ? e.size : 0), 0);
  if (entries.length !== manifest.entryCount || unpacked !== manifest.unpackedSize) throw new UntrustedError(`download.entries: ${t("update.untrusted.notManifest")}`);
  return { path: r.data.path, entries };
}

/**
 * The archive's URL: `path` must be exactly `/app-updates/<token>` and the result must lie on `httpOrigin` — the
 * listener the WebSocket is connected to. Anything that would resolve elsewhere (`//host`, `@`, backslashes, an
 * absolute URL, encoded or dotted segments, a query) is refused before a request is made.
 */
export function archiveUrl(httpOrigin: string, path: string): string {
  if (typeof path !== "string" || !isAppUpdateTokenPath(path)) throw new UntrustedError("download.path");
  let base: URL;
  let url: URL;
  try {
    base = new URL(httpOrigin);
    url = new URL(path, base);
  } catch {
    throw new UntrustedError("download.path");
  }
  if (url.origin !== base.origin || url.pathname !== path || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new UntrustedError("download.path");
  }
  return url.href;
}
