// Kendini güncelleme: every tunable of the updater. Defaults ship in update.defaults.json; a file
// `<userData>/update/update-config.json` may override any of them on one machine (and is how tests shorten waits).
import { readFileSync } from "node:fs";
import { z } from "zod";
import defaults from "./update.defaults.json" with { type: "json" };

const posInt = z.number().int().positive();
const name = z.string().regex(/^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "expected a plain file name");
const absPath = z.string().regex(/^\/[^\0]*$/, "expected an absolute path");

export const UpdateConfigSchema = z
  .object({
    /** Info.plist key `scripts/dist.ts` writes the build id into. */
    buildIdPlistKey: z.string().min(1),
    /** Info.plist key `scripts/dist.ts` writes the publisher key's id into (the publish step checks it). */
    updateKeyIdPlistKey: z.string().min(1),
    bundleIdPlistKey: z.string().min(1),
    versionPlistKey: z.string().min(1),
    /** First check after the app started. */
    startupCheckDelayMs: z.number().int().min(0),
    /** A check runs this often (and whenever the window's connection to the engine comes up). */
    checkIntervalMs: posInt,
    /** A ready update is applied by itself once no window of the app has had focus for this long. */
    idleApplyMs: posInt,
    /** How often that is looked at. */
    idlePollMs: posInt,
    /** The new build must report "window ready" within this long after the swap, or the old one comes back. */
    healthTimeoutMs: posInt,
    /** The helper waits this long for the old app to exit before it gives up (nothing is changed then). */
    exitWaitMs: posInt,
    handshakeTimeoutMs: posInt,
    requestTimeoutMs: posInt,
    /** A download with no byte for this long is cut and resumed. */
    downloadIdleTimeoutMs: posInt,
    /** Connections one download may take (each resumes where the last stopped). */
    downloadAttempts: posInt,
    /** A manifest whose signed build time is later than its own (signed) createdAt + this is refused. */
    maxStampAfterCreatedMs: posInt,
    /** …and one whose build time is later than this Mac's clock + this (generous: clocks drift, never by a day). */
    maxStampAheadOfClockMs: posInt,
    /** Largest blob (the compressed download). */
    maxArchiveBytes: posInt,
    /** Caps of a bundle's entry list: entries, one file's size, all files together. A list over them is refused whole. */
    maxBundleFiles: posInt,
    /** Symbolic links in a bundle (a real one has about a dozen; at most @kokpit/shared MAX_LINKS). */
    maxBundleLinks: posInt,
    maxFileBytes: posInt,
    maxUnpackedBytes: posInt,
    /** Free space needed on the app's volume, as a multiple of (blob + unpacked bundle). */
    freeSpaceFactor: posInt,
    /** A build whose swap was given up this many times is marked bad. */
    maxApplyAttempts: posInt,
    /** A build that failed verification this many times is marked bad (it is downloaded anew each time). */
    maxVerifyFailures: posInt,
    stateDirName: name,
    stateFileName: name,
    overridesFileName: name,
    /** Folder next to the app bundle (same volume) for the download, the unpacked build and the backup. */
    stagingDirName: name,
    backupDirName: name,
    /** Per app profile (userData): `<staging>/<profiles>/<key>/{<builds>,<downloads>}`. */
    profilesDirName: name,
    buildsDirName: name,
    downloadsDirName: name,
    /** A bundle path containing this runs from Gatekeeper's randomized read-only copy. */
    translocationMarker: z.string().min(1),
    quarantineAttr: z.string().min(1),
    /** Environment variables the relaunched app gets from the old one. */
    relaunchEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(20),
    toolTimeoutMs: posInt,
    /** PATH of the swap helper (mv, rm, sleep, date). */
    helperPath: z.string().min(1),
    tools: z.object({ codesign: absPath, plutil: absPath, xattr: absPath, open: absPath, ps: absPath, sh: absPath }).strict(),
  })
  .strict();
export type UpdateConfig = z.infer<typeof UpdateConfigSchema>;

const OverridesSchema = UpdateConfigSchema.omit({ tools: true }).partial().extend({ tools: UpdateConfigSchema.shape.tools.partial().optional() }).strict();

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = UpdateConfigSchema.parse(defaults);

/** Defaults merged with the overrides file; a missing or invalid file changes nothing (the reason is returned). */
export function loadUpdateConfig(overridesPath: string, base: UpdateConfig = DEFAULT_UPDATE_CONFIG): { config: UpdateConfig; problem?: string } {
  let raw: string;
  try {
    raw = readFileSync(overridesPath, "utf8");
  } catch {
    return { config: base };
  }
  try {
    const o = OverridesSchema.parse(JSON.parse(raw));
    return { config: UpdateConfigSchema.parse({ ...base, ...o, tools: { ...base.tools, ...o.tools } }) };
  } catch (err) {
    return { config: base, problem: err instanceof Error ? err.message : String(err) };
  }
}
