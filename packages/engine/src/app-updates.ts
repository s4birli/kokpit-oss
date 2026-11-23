// Kendini güncelleme: the engine publishes ONE current build of the app and hands it to the apps that ask.
//
// On disk (`<dataDir>/app-updates` unless `appUpdates.dir` says otherwise):
//
//   <buildId>/bundle.bin.gz   the bundle's file contents, concatenated and gzip-compressed (the "blob")
//   <buildId>/entries.json    the bundle's entry list: every directory, file (mode, size, SHA-256) and link
//   <buildId>/manifest.json   { buildId, version, format, bundleName, sha256, size, unpackedSize, entryCount, … }
//   current.json              { buildId } — the build that is announced
//
// The format is Kokpit's own (@kokpit/shared app-bundle.ts), made here from the built `.app` folder: the app is
// the only parser of what it installs, so there is no archive format between the two.
//
// Publishing (scripts/publish-app.ts, at deploy time) packs the bundle into a hidden `.incoming-…` folder, renames
// the folder to `<buildId>` and only then replaces `current.json` (write + rename). A build that is half written
// is therefore never announced or served. The last `keep` builds stay for taking a release back (publish the older
// bundle again, or point `current.json` at it).
//
// Serving follows files-media.ts: the manifest and the entry list go out over the authenticated WebSocket
// (`app.update.check`, `app.update.download`), the blob over HTTP on the same listener for an unguessable token
// that belongs to the asking connection, with one byte range per request so an interrupted download resumes. The
// app checks the blob's SHA-256 from the manifest and every file against the list; the token only keeps strangers
// on the tailnet from fetching the blob.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type http from "node:http";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  APP_UPDATE_HTTP_PREFIX,
  AppUpdateManifestSchema,
  BUNDLE_FORMAT,
  BuildIdSchema,
  isAppUpdateTokenPath,
  isBundleName,
  validateBundleEntries,
  satisfiesMinBuild,
  type AppUpdateClient,
  type AppUpdateDownload,
  type AppUpdateManifest,
  type AppUpdateOutcome,
  type BuildInfo,
  type BundleEntry,
  type BundleLimits,
  buildStamp,
  stampTime,
} from "@kokpit/shared";
import { packBundle } from "@kokpit/shared/bundle-pack";
import { entriesSha256, signManifest, type SigningKey } from "@kokpit/shared/update-signing";
import { engineError, type Logger } from "./contracts.ts";
import { parseRange } from "./files-media.ts";
import { PRIVATE_FILE_MODE } from "./fs-safety.ts";

const posInt = z.number().int().positive();
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "expected a plain file name");

export const AppUpdatesConfigSchema = z
  .object({
    /** Where published builds live; absent = `<dataDir>/<dirName>`. */
    dir: z.string().min(1).refine(isAbsolute, "must be an absolute path").optional(),
    dirName: fileName,
    /** Published builds kept (the current one included); older ones are deleted on publish. */
    keep: posInt,
    /**
     * A build stamped later than now + this is not published: its stamp would raise every app's rollback floor
     * (the newest build ever installed) into the future for good.
     */
    maxFutureStampMs: posInt,
    blobFileName: fileName,
    entriesFileName: fileName,
    manifestFileName: fileName,
    currentFileName: fileName,
    /** Prefix of the hidden folder a build is written into before it is renamed to its build id. */
    incomingPrefix: z.string().regex(/^\.[A-Za-z0-9._-]{1,40}$/, "must start with a dot"),
    maxManifestBytes: posInt,
    /** Largest entry list (JSON characters): it travels in one WebSocket frame. */
    maxEntriesChars: posInt,
    /** Caps of a bundle; the apps have their own and refuse what exceeds them. */
    maxEntries: posInt,
    maxLinks: posInt,
    maxFileBytes: posInt,
    maxTotalBytes: posInt,
    /** A download URL stops working this long after it was issued or last used. */
    tokenTtlMs: posInt,
    tokenBytes: z.number().int().min(24).max(96),
    maxTokens: posInt,
    maxTokensPerConnection: posInt,
    /** Archive bodies sent at the same time; further requests answer 503. */
    maxStreams: posInt,
    retryAfterS: posInt,
    chunkBytes: z.number().int().min(1024).max(4194304),
    /** App installs remembered for `app.update.clients`. */
    maxClients: posInt,
    // ---- publish script ----
    plutilPath: z.string().min(1),
    /** Info.plist key the app's dist script writes the build id into. */
    buildIdPlistKey: z.string().min(1),
    versionPlistKey: z.string().min(1),
    /** Folder the publish script looks in when no bundle is named; relative to the engine package. */
    sourceDir: z.string().min(1),
    /** Which folders in `sourceDir` are app bundles (the newest one is published). */
    sourcePattern: z.string().min(1),
    /**
     * Folder of the publisher key pair (update-signing.ts), outside the repo; `~/` is the engine user's home. The
     * deploy step creates it once; the app's build embeds its public key.
     */
    signingKeyDir: z.string().min(1),
    /** Info.plist key the app's build writes the publisher key's id into (publish refuses a bundle without it). */
    updateKeyIdPlistKey: z.string().min(1),
  })
  .strict();
export type AppUpdatesConfig = z.infer<typeof AppUpdatesConfigSchema>;

/** The `appUpdates` key of engine.json: any subset of the defaults. */
export const AppUpdatesConfigOverrideSchema = AppUpdatesConfigSchema.partial().strict();
export type AppUpdatesConfigOverride = z.infer<typeof AppUpdatesConfigOverrideSchema>;

const DEFAULTS_PATH = fileURLToPath(new URL("../app-updates.defaults.json", import.meta.url));

export function loadAppUpdatesConfig(overrides: AppUpdatesConfigOverride = {}, path: string = DEFAULTS_PATH): AppUpdatesConfig {
  let raw: object;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as object;
  } catch (err) {
    throw new Error(`cannot read app-updates defaults ${path}: ${(err as Error).message}`);
  }
  const r = AppUpdatesConfigSchema.safeParse({ ...raw, ...overrides });
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`invalid appUpdates config: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
  }
  return r.data;
}

/** The folder published builds live in. */
export function appUpdatesDir(cfg: AppUpdatesConfig, dataDir: string): string {
  return cfg.dir ?? join(dataDir, cfg.dirName);
}

const CurrentSchema = z.object({ buildId: BuildIdSchema }).strict();

function readJson(path: string, maxBytes: number): unknown {
  const st = statSync(path);
  if (!st.isFile() || st.size > maxBytes) throw new Error("not a small regular file");
  return JSON.parse(readFileSync(path, "utf8"));
}

export const bundleLimits = (cfg: AppUpdatesConfig): BundleLimits => ({ maxEntries: cfg.maxEntries, maxLinks: cfg.maxLinks, maxFileBytes: cfg.maxFileBytes, maxTotalBytes: cfg.maxTotalBytes });

/** The manifest of one published build when its folder is complete (manifest valid, blob of that size, a list). */
export function readPublishedBuild(cfg: AppUpdatesConfig, dir: string, buildId: string): AppUpdateManifest | undefined {
  if (!BuildIdSchema.safeParse(buildId).success) return undefined;
  try {
    const manifest = AppUpdateManifestSchema.parse(readJson(join(dir, buildId, cfg.manifestFileName), cfg.maxManifestBytes));
    if (manifest.buildId !== buildId) return undefined;
    const st = statSync(join(dir, buildId, cfg.blobFileName));
    return st.isFile() && st.size === manifest.size && statSync(join(dir, buildId, cfg.entriesFileName)).isFile() ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/** The build `current.json` points at, when it is complete. */
export function readCurrentBuild(cfg: AppUpdatesConfig, dir: string): AppUpdateManifest | undefined {
  try {
    const current = CurrentSchema.parse(readJson(join(dir, cfg.currentFileName), cfg.maxManifestBytes));
    return readPublishedBuild(cfg, dir, current.buildId);
  } catch {
    return undefined;
  }
}

/** Complete published builds, newest first. */
export function listPublishedBuilds(cfg: AppUpdatesConfig, dir: string): AppUpdateManifest[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith("."))
    .map((n) => readPublishedBuild(cfg, dir, n))
    .filter((m): m is AppUpdateManifest => m !== undefined)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: PRIVATE_FILE_MODE });
  renameSync(tmp, path);
}

export interface PublishInput {
  /** The built `.app` folder to publish. */
  appPath: string;
  buildId: string;
  version: string;
  minEngineBuild?: string;
  now?: Date;
  /** The publisher key (update-signing.ts): every published build is signed with it. */
  signingKey: SigningKey;
}

/**
 * Packs the bundle (entry list + blob) and makes it the current build. Returns its manifest and the builds that
 * were deleted to stay within `keep`. Publishing the same build id again replaces that build.
 */
export async function publishAppBuild(cfg: AppUpdatesConfig, dir: string, input: PublishInput): Promise<{ manifest: AppUpdateManifest; pruned: string[] }> {
  const buildId = BuildIdSchema.parse(input.buildId);
  const stampAt = stampTime(buildStamp(buildId));
  const nowMs = (input.now ?? new Date()).getTime();
  if (stampAt === undefined) throw new Error(`${buildId}: the build id carries no build time`);
  if (stampAt > nowMs + cfg.maxFutureStampMs) {
    throw new Error(`${buildId}: build time is in the future (gelecek tarihli derleme) — check this Mac's clock; it would raise every app's rollback floor`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Left behind by a publish that was interrupted: never announced, safe to drop.
  for (const name of readdirSync(dir)) if (name.startsWith(cfg.incomingPrefix)) rmSync(join(dir, name), { recursive: true, force: true });

  const incoming = mkdtempSync(join(dir, cfg.incomingPrefix));
  try {
    const bundleName = basename(input.appPath);
    if (!isBundleName(bundleName)) throw new Error(`${input.appPath} is not an .app bundle with a plain name`);
    const packed = await packBundle(input.appPath, join(incoming, cfg.blobFileName), bundleLimits(cfg));
    const entriesJson = JSON.stringify(packed.entries);
    if (entriesJson.length > cfg.maxEntriesChars) throw new Error(`the bundle's entry list is too large to announce (${entriesJson.length} characters, limit ${cfg.maxEntriesChars})`);
    writeFileSync(join(incoming, cfg.entriesFileName), entriesJson, { mode: PRIVATE_FILE_MODE });
    const signed = {
      buildId,
      version: input.version,
      format: BUNDLE_FORMAT,
      bundleName,
      sha256: packed.blob.sha256,
      size: packed.blob.size,
      unpackedSize: packed.unpackedSize,
      entryCount: packed.entries.length,
      entriesSha256: entriesSha256(packed.entries)!,
      ...(input.minEngineBuild !== undefined ? { minEngineBuild: input.minEngineBuild } : {}),
      createdAt: (input.now ?? new Date()).toISOString(),
    };
    const manifest = AppUpdateManifestSchema.parse({
      ...signed,
      signingKeyId: input.signingKey.keyId,
      signature: signManifest(input.signingKey, signed),
    });
    writeFileSync(join(incoming, cfg.manifestFileName), JSON.stringify(manifest, null, 2), { mode: PRIVATE_FILE_MODE });
    const target = join(dir, buildId);
    if (existsSync(target)) {
      // The same build id again: the old folder steps aside first, so the id never names a mix of two publishes.
      const aside = `${incoming}.replaced`;
      renameSync(target, aside);
      renameSync(incoming, target);
      rmSync(aside, { recursive: true, force: true });
    } else {
      renameSync(incoming, target);
    }
    writeAtomic(join(dir, cfg.currentFileName), JSON.stringify({ buildId }));
    return { manifest, pruned: pruneBuilds(cfg, dir, buildId) };
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
}

/** Deletes all but the newest `keep` complete builds (never `currentId`) and every incomplete build folder. */
export function pruneBuilds(cfg: AppUpdatesConfig, dir: string, currentId: string): string[] {
  const complete = listPublishedBuilds(cfg, dir);
  const keepIds = new Set([currentId, ...complete.filter((m) => m.buildId !== currentId).slice(0, Math.max(0, cfg.keep - 1)).map((m) => m.buildId)]);
  const pruned: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || keepIds.has(name)) continue;
    let isDir = false;
    try {
      isDir = statSync(join(dir, name)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir || !BuildIdSchema.safeParse(name).success) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    pruned.push(name);
  }
  return pruned;
}

export interface AppUpdateService {
  /** The build to announce: the current one, unless it asks for a newer engine than this one. */
  current(): AppUpdateManifest | null;
  /** Remembers what an app said it is (for `clients`). */
  seen(client: { clientId: string; buildId: string; version: string }): void;
  report(report: { clientId: string; buildId: string; outcome: AppUpdateOutcome; detail?: string }): void;
  clients(): AppUpdateClient[];
  /** A URL path for the blob of the current build, with its entry list. Throws EngineError NOT_FOUND when `buildId` is not it. */
  issue(owner: object, buildId: string): AppUpdateDownload;
  revokeOwner(owner: object): void;
  /** Handles `${APP_UPDATE_HTTP_PREFIX}…` requests; false for any other path. */
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  stats(): { tokens: number; activeStreams: number };
  stop(): void;
}

export interface AppUpdateServiceDeps {
  config: AppUpdatesConfig;
  dir: string;
  engineBuild: BuildInfo;
  logger: Logger;
  now?: () => number;
}

interface Grant {
  owner: object;
  manifest: AppUpdateManifest;
  expiresAt: number;
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  const { config: cfg, dir, logger } = deps;
  const now = deps.now ?? Date.now;
  const grants = new Map<string, Grant>();
  const streams = new Set<{ destroy(): void }>();
  const seenClients = new Map<string, AppUpdateClient>();
  let withheld: string | undefined;
  /** The entry list of the build last asked for (read and checked once per build). */
  let listed: { buildId: string; sha256: string; entries: BundleEntry[] } | undefined;

  function entriesOf(manifest: AppUpdateManifest): BundleEntry[] | undefined {
    if (listed?.buildId === manifest.buildId && listed.sha256 === manifest.sha256) return listed.entries;
    try {
      const path = join(dir, manifest.buildId, cfg.entriesFileName);
      if (statSync(path).size > cfg.maxEntriesChars * 4) return undefined;
      const entries = validateBundleEntries(JSON.parse(readFileSync(path, "utf8")), bundleLimits(cfg));
      // The list on disk must be the one the manifest signs; a changed file is not handed out.
      if (entries.length !== manifest.entryCount || entriesSha256(entries) !== manifest.entriesSha256) return undefined;
      listed = { buildId: manifest.buildId, sha256: manifest.sha256, entries };
      return entries;
    } catch (err) {
      logger.warn("app build has no usable entry list", { buildId: manifest.buildId, err: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  const baseHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } as const;

  function refuse(res: http.ServerResponse, status: number, extra: http.OutgoingHttpHeaders = {}): void {
    res.writeHead(status, { ...baseHeaders, "content-type": "text/plain; charset=utf-8", "content-length": 0, ...extra });
    res.end();
  }

  function current(): AppUpdateManifest | null {
    const manifest = readCurrentBuild(cfg, dir);
    if (!manifest) return null;
    if (manifest.minEngineBuild !== undefined && !satisfiesMinBuild(deps.engineBuild.buildId, manifest.minEngineBuild)) {
      if (withheld !== manifest.buildId) {
        withheld = manifest.buildId;
        logger.warn("app build withheld: it needs a newer engine", { buildId: manifest.buildId, minEngineBuild: manifest.minEngineBuild, engineBuild: deps.engineBuild.buildId });
      }
      return null;
    }
    return manifest;
  }

  /** The archive of `manifest`, opened, when it still is the regular file of that size. The caller closes it. */
  function open(manifest: AppUpdateManifest): number | undefined {
    let fd: number;
    try {
      fd = openSync(join(dir, manifest.buildId, cfg.blobFileName), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return undefined;
    }
    const st = fstatSync(fd);
    if (st.isFile() && st.size === manifest.size) return fd;
    closeSync(fd);
    return undefined;
  }

  function remember(client: AppUpdateClient): void {
    seenClients.delete(client.clientId);
    seenClients.set(client.clientId, client);
    while (seenClients.size > cfg.maxClients) seenClients.delete(seenClients.keys().next().value!);
  }

  return {
    current,

    seen(c) {
      const before = seenClients.get(c.clientId);
      if (before?.buildId !== c.buildId) logger.info("app build seen", { clientId: c.clientId, buildId: c.buildId });
      remember({
        clientId: c.clientId,
        buildId: c.buildId,
        version: c.version,
        seenAt: new Date(now()).toISOString(),
        ...(before?.outcome !== undefined ? { outcome: before.outcome } : {}),
        ...(before?.outcomeBuildId !== undefined ? { outcomeBuildId: before.outcomeBuildId } : {}),
      });
    },

    report(r) {
      const log = r.outcome === "updated" ? logger.info.bind(logger) : logger.warn.bind(logger);
      log("app update report", { clientId: r.clientId, buildId: r.buildId, outcome: r.outcome, ...(r.detail !== undefined ? { detail: r.detail } : {}) });
      const before = seenClients.get(r.clientId);
      if (before) remember({ ...before, outcome: r.outcome, outcomeBuildId: r.buildId });
    },

    clients: () => [...seenClients.values()],

    issue(owner, buildId) {
      const manifest = current();
      if (!manifest || manifest.buildId !== buildId) throw engineError("NOT_FOUND", "engine.appUpdates.notPublished");
      const fd = open(manifest);
      if (fd === undefined) throw engineError("NOT_FOUND", "engine.appUpdates.notPublished");
      closeSync(fd);
      const entries = entriesOf(manifest);
      if (!entries) throw engineError("NOT_FOUND", "engine.appUpdates.notPublished");

      const t = now();
      for (const [token, g] of grants) if (g.expiresAt <= t) grants.delete(token);
      const mine = [...grants].filter(([, g]) => g.owner === owner);
      for (const [token] of mine.slice(0, Math.max(0, mine.length - cfg.maxTokensPerConnection + 1))) grants.delete(token);
      while (grants.size >= cfg.maxTokens) grants.delete(grants.keys().next().value!);

      const token = randomBytes(cfg.tokenBytes).toString("base64url");
      const expiresAt = t + cfg.tokenTtlMs;
      grants.set(token, { owner, manifest, expiresAt });
      return { path: `${APP_UPDATE_HTTP_PREFIX}${token}`, size: manifest.size, sha256: manifest.sha256, expiresAt: new Date(expiresAt).toISOString(), entries };
    },

    revokeOwner(owner) {
      for (const [token, g] of grants) if (g.owner === owner) grants.delete(token);
    },

    handleHttp(req, res) {
      const raw = req.url ?? "";
      const pathname = raw.split("?")[0] ?? "";
      if (!pathname.startsWith(APP_UPDATE_HTTP_PREFIX)) return false;
      if (req.method !== "GET" && req.method !== "HEAD") {
        refuse(res, 405, { allow: "GET, HEAD" });
        return true;
      }
      if (!isAppUpdateTokenPath(raw)) {
        refuse(res, 404);
        return true;
      }
      const token = raw.slice(APP_UPDATE_HTTP_PREFIX.length);
      const grant = grants.get(token);
      if (!grant || grant.expiresAt <= now()) {
        if (grant) grants.delete(token);
        logger.warn("app update url rejected", { reason: grant ? "expired" : "unknown" });
        refuse(res, 404);
        return true;
      }
      const fd = open(grant.manifest);
      if (fd === undefined) {
        grants.delete(token);
        logger.warn("app update archive no longer servable", { buildId: grant.manifest.buildId });
        refuse(res, 404);
        return true;
      }
      const size = grant.manifest.size;
      const range = parseRange(req.headers.range, size);
      if (range === "unsatisfiable") {
        closeSync(fd);
        refuse(res, 416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
        return true;
      }
      const start = range === "full" ? 0 : range.start;
      const end = range === "full" ? size - 1 : range.end;
      const headers: http.OutgoingHttpHeaders = {
        ...baseHeaders,
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        // The archive a URL names never changes (one token, one build), so a resumed download may rely on this.
        etag: `"${grant.manifest.sha256}"`,
        ...(range === "full" ? {} : { "content-range": `bytes ${start}-${end}/${size}` }),
      };
      const status = range === "full" ? 200 : 206;
      if (req.method === "HEAD") {
        closeSync(fd);
        grant.expiresAt = now() + cfg.tokenTtlMs;
        res.writeHead(status, headers);
        res.end();
        return true;
      }
      if (streams.size >= cfg.maxStreams) {
        closeSync(fd);
        logger.warn("app update stream refused", { reason: "too many streams", limit: cfg.maxStreams });
        refuse(res, 503, { "retry-after": String(cfg.retryAfterS) });
        return true;
      }
      grant.expiresAt = now() + cfg.tokenTtlMs;
      const stream = createReadStream("", { fd, start, end, highWaterMark: cfg.chunkBytes, autoClose: true });
      streams.add(stream);
      const done = (): void => {
        streams.delete(stream);
        stream.destroy();
      };
      // A slow link keeps its URL alive for as long as bytes flow.
      stream.on("data", () => (grant.expiresAt = now() + cfg.tokenTtlMs));
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
      for (const s of [...streams]) s.destroy();
      streams.clear();
    },
  };
}
