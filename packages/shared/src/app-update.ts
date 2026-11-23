// Kendini güncelleme: build identity of the app and the engine, the protocol compatibility number, and the
// requests with which the app learns about — and fetches — the app build the engine publishes.
//
// Trust: the manifest (build id + SHA-256 of the blob) and the entry list travel only over the authenticated
// WebSocket, so only an engine that holds the shared key can announce an update. The blob itself (app-bundle.ts)
// comes over plain HTTP from the same listener for a short-lived token and is worthless unless its hash matches
// the manifest and every file in it matches the entry list.
//
// Identity on the wire: `hello.ok` (sent only after the mutual handshake, auth.ts) carries the engine's build and
// protocol number; the app tells the engine its own build with `app.update.check`. An engine from before the
// handshake closes the connection at once (the app says "Motor eski sürüm"), so no update request ever reaches it.
import { z } from "zod";
import { BUNDLE_FORMAT, isBundleName, type BundleEntry } from "./app-bundle.ts";
import { zm } from "./zod-message.ts";

/**
 * Raised when a change makes older peers unusable (a request removed or its meaning changed). Adding requests does
 * not need a bump: an unknown request is answered with `UNKNOWN_METHOD`, never with a closed connection.
 */
export const PROTOCOL_VERSION = 2;

const BUILD_ID_MAX_CHARS = 120;
/** `<version>+<UTC yyyymmddHHMMSS>.<commit>[.dirty]` — also a safe folder name (no slash, no leading dot). */
const BUILD_ID_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const BUILD_STAMP_RE = /\+(\d{14})\./;

/**
 * A build id becomes a folder and file name on both sides, so it is a plain name by construction: no slash, no
 * backslash, no whitespace or control character, no leading dot, and no `..` anywhere.
 */
/** Names of the updater's own folders: never a build id, whatever the case. */
const RESERVED_BUILD_IDS = new Set(["backup", "builds", "downloads", "profiles", "current", "staging", "incoming"]);

export const BuildIdSchema = z
  .string()
  .min(1)
  .max(BUILD_ID_MAX_CHARS)
  .regex(BUILD_ID_RE, zm("validation.appUpdate.buildId"))
  .refine((id) => !id.includes(".."), zm("validation.appUpdate.buildId"))
  .refine((id) => !RESERVED_BUILD_IDS.has(id.toLowerCase()), zm("validation.appUpdate.reservedBuildId"));

/**
 * The id of a PUBLISHED build: always the shape the build makes (`<version>+<yyyymmddHHMMSS>.<commit>…`). It is a
 * folder name on both sides, so a plain word (`backup`, `builds`) can never be one, and every published build has
 * a build time to compare (downgrades).
 */
export const PublishedBuildIdSchema = BuildIdSchema.refine((id) => /^[0-9A-Za-z][0-9A-Za-z.-]*\+\d{14}\.[0-9A-Za-z][0-9A-Za-z.-]*$/.test(id), zm("validation.appUpdate.publishedBuildId"));

/** A version as package.json has it (`1.2.3`, `1.2.3-beta.1`); shown to the user, so no markup or path either. */
const VersionSchema = z.string().min(1).max(60).regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/, zm("validation.appUpdate.version"));

export const BuildInfoSchema = z.object({
  /** Unique per build; equal ids mean the same build. */
  buildId: BuildIdSchema,
  /** `version` of the package.json the build was made from. */
  version: VersionSchema,
  /** Short git commit, with `.dirty` when the tree had uncommitted changes; "unknown" outside a git checkout. */
  commit: z.string().min(1).max(60),
  /** ISO time of the build. */
  builtAt: z.string().min(1).max(40),
});
export type BuildInfo = z.infer<typeof BuildInfoSchema>;

/** The id a build made at `builtAt` from `version` at `commit` gets. */
export function makeBuildId(version: string, commit: string, builtAt: Date): string {
  const stamp = builtAt.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${version}+${stamp}.${commit}`;
}

/** The build time inside a build id (UTC yyyymmddHHMMSS), or undefined for an id of another shape. */
export function buildStamp(buildId: string): string | undefined {
  return BUILD_STAMP_RE.exec(buildId)?.[1];
}

/** A build stamp (`yyyymmddHHMMSS`, UTC) as epoch milliseconds; undefined for anything else. */
export function stampTime(stamp: string | undefined): number | undefined {
  const m = stamp === undefined ? null : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(t) ? t : undefined;
}

/** True when `engineBuildId` is at least as new as `minBuildId` (by build time). Unknown shapes never satisfy it. */
export function satisfiesMinBuild(engineBuildId: string, minBuildId: string): boolean {
  const have = buildStamp(engineBuildId);
  const need = buildStamp(minBuildId);
  return have !== undefined && need !== undefined && have >= need;
}

export const AppUpdateManifestSchema = z.object({
  buildId: PublishedBuildIdSchema,
  version: VersionSchema,
  /** The payload's format (app-bundle.ts). An app that does not know the number leaves the build alone. */
  format: z.literal(BUNDLE_FORMAT),
  /** Folder name of the bundle (`Kokpit.app`). */
  bundleName: z.string().refine(isBundleName, zm("validation.appUpdate.bundleName")),
  /** SHA-256 of the blob as it is sent (compressed), lower-case hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Size of the blob as it is sent, in bytes. */
  size: z.number().int().positive(),
  /** Sum of the file sizes once unpacked, and the number of entries: what the app checks room and caps against. */
  unpackedSize: z.number().int().min(0),
  entryCount: z.number().int().positive(),
  /** The engine withholds the build while its own build is older than this. */
  minEngineBuild: BuildIdSchema.optional(),
  createdAt: z.string().min(1).max(40),
  /** SHA-256 (hex) of the entry list as signed (app-update-sign.ts canonicalEntries). */
  entriesSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** First 16 hex digits of SHA-256 of the publisher's public key. */
  signingKeyId: z.string().regex(/^[0-9a-f]{16}$/),
  /** Ed25519 signature (base64, 64 bytes) by the publisher key over signedPayload(manifest). */
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export type AppUpdateManifest = z.infer<typeof AppUpdateManifestSchema>;

/** HTTP path prefix under which the engine sends the blob of a published build for a token. */
export const APP_UPDATE_HTTP_PREFIX = "/app-updates/";
const APP_UPDATE_TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;

/** True for `/app-updates/<token>` with a well-formed token (no slashes, dots, escapes or query). */
export function isAppUpdateTokenPath(pathname: string): boolean {
  return pathname.startsWith(APP_UPDATE_HTTP_PREFIX) && APP_UPDATE_TOKEN_RE.test(pathname.slice(APP_UPDATE_HTTP_PREFIX.length));
}

export const APP_UPDATE_OUTCOMES = ["updated", "rolledBack", "failed"] as const;
export type AppUpdateOutcome = (typeof APP_UPDATE_OUTCOMES)[number];

const ClientId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, zm("validation.appUpdate.clientId"));

export const AppUpdateRequestParams = {
  /**
   * "This is the build I am; what should I be?" Answered with the engine's identity and the published build, if
   * any. The app decides whether that is an update (a different build id that it has not marked as bad).
   */
  "app.update.check": z.object({ clientId: ClientId, app: BuildInfoSchema, protocol: z.number().int().min(0).max(1_000_000) }).strict(),
  /** A short-lived URL for the archive of the published build `buildId`. It belongs to the asking connection. */
  "app.update.download": z.object({ buildId: PublishedBuildIdSchema }).strict(),
  /** What became of an update on this client (for the engine's log and `app.update.clients`). */
  "app.update.report": z
    .object({ clientId: ClientId, buildId: BuildIdSchema, outcome: z.enum(APP_UPDATE_OUTCOMES), detail: z.string().max(500).optional() })
    .strict(),
  /** The published build and the app builds seen since the engine started (deploy helper: "wait for clients"). */
  "app.update.clients": z.object({}).strict(),
} as const;

export interface EngineIdentity {
  build: BuildInfo;
  protocol: number;
}

export interface AppUpdateDownload {
  /** `${APP_UPDATE_HTTP_PREFIX}<token>` on the engine's own listener (same host and port as the WebSocket). */
  path: string;
  size: number;
  sha256: string;
  expiresAt: string;
  /** The bundle's entry list (app-bundle.ts). The app validates it itself before it writes anything. */
  entries: BundleEntry[];
}

export interface AppUpdateClient {
  clientId: string;
  buildId: string;
  version: string;
  seenAt: string;
  /** Last `app.update.report` of this client, if any. */
  outcome?: AppUpdateOutcome;
  outcomeBuildId?: string;
}

export interface AppUpdateResultMap {
  "app.update.check": { engine: EngineIdentity; update: AppUpdateManifest | null };
  "app.update.download": AppUpdateDownload;
  "app.update.report": Record<string, never>;
  "app.update.clients": { current: AppUpdateManifest | null; clients: AppUpdateClient[] };
}

export type Compat =
  /** Same protocol number. */
  | "ok"
  /** The engine is behind the app (or predates build identities): the engine machine needs a deploy. */
  | "engine-older"
  /** The app is behind the engine: it needs the published build. */
  | "app-older";

/** `engineProtocol` undefined = the engine's `hello.ok` carried none. */
export function decideCompat(appProtocol: number, engineProtocol: number | undefined): Compat {
  if (engineProtocol === undefined || engineProtocol < appProtocol) return "engine-older";
  return engineProtocol > appProtocol ? "app-older" : "ok";
}

export type UpdateDecision =
  | { kind: "none" }
  /** A published build this app should become. */
  | { kind: "update"; manifest: AppUpdateManifest }
  /** The published build failed on this client before; it is not tried again. */
  | { kind: "bad"; manifest: AppUpdateManifest };

/**
 * The engine's published build is the target, whichever direction that is (publishing an older build is how a
 * release is taken back). No update when nothing is published or the app already is that build.
 */
export function decideUpdate(appBuildId: string, manifest: AppUpdateManifest | null, badBuildIds: readonly string[]): UpdateDecision {
  if (manifest === null || manifest.buildId === appBuildId) return { kind: "none" };
  return badBuildIds.includes(manifest.buildId) ? { kind: "bad", manifest } : { kind: "update", manifest };
}
