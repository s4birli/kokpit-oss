// Kendini güncelleme: publishes a built app bundle so that running Kokpit apps pick it up from this engine.
//
//   node packages/engine/scripts/publish-app.ts --config <engine.json> [--app <Kokpit.app>] [--min-engine-build <id>]
//   node packages/engine/scripts/publish-app.ts --dir <app-updates dir> [--app <Kokpit.app>]
//   node packages/engine/scripts/publish-app.ts list --config <engine.json>
//   node packages/engine/scripts/publish-app.ts keygen --config <engine.json>   (deploy:local runs it first)
//
// Every published build is signed with the publisher key (@kokpit/shared update-signing.ts) from
// `appUpdates.signingKeyDir` (or --signing-dir). `keygen` creates that key once; `publish` never creates one, and
// refuses a bundle whose Info.plist names another key (or none): such an app could not verify later updates.
//
// Without --app the bundle of `pnpm --filter @kokpit/app dist` is taken (appUpdates.sourceDir: dist/mac-arm64). The
// build id and version are read from the bundle's own Info.plist, so the manifest always describes what it names.
// The bundle is packed into Kokpit's update format (entry list + blob); the zip next to it stays what it was: the
// artifact for a first, manual install. The running engine needs no restart: it reads `current.json` on every check.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { BuildIdSchema, PublishedBuildIdSchema } from "@kokpit/shared";
import { ensureSigningKey, SIGNING_PRIVATE_FILE, type SigningKey } from "@kokpit/shared/update-signing";
import { existsSync } from "node:fs";
import {
  AppUpdatesConfigOverrideSchema,
  appUpdatesDir,
  listPublishedBuilds,
  loadAppUpdatesConfig,
  publishAppBuild,
  readCurrentBuild,
  type AppUpdatesConfig,
} from "../src/app-updates.ts";

const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PLIST_BYTES = 1024 * 1024;

const USAGE = `usage:
  publish-app.ts [publish] (--config <engine.json> | --dir <app-updates dir>) [--app <bundle>] [--min-engine-build <id>]
  publish-app.ts list (--config <engine.json> | --dir <app-updates dir>)
  publish-app.ts keygen (--config <engine.json> | --signing-dir <folder>)
  (publish and keygen take --signing-dir <folder> instead of appUpdates.signingKeyDir)
`;

export class PublishError extends Error {}

export interface PublishDeps {
  cwd: string;
  homedir: string;
  /** Runs a tool with optional stdin; stdout as bytes. */
  run(cmd: string, args: string[], input?: Buffer): { status: number | null; stdout: Buffer; stderr: string };
  stdout(s: string): void;
  stderr(s: string): void;
  now?: () => Date;
}

const expandHome = (p: string, home: string): string => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

/** engine.json → the app-updates config and folder, without creating anything (unlike the engine's loadConfig). */
export function resolveTarget(deps: PublishDeps, opts: { config?: string | undefined; dir?: string | undefined }): { cfg: AppUpdatesConfig; dir: string } {
  if (opts.dir !== undefined) {
    const dir = resolve(deps.cwd, expandHome(opts.dir, deps.homedir));
    return { cfg: loadAppUpdatesConfig({}), dir };
  }
  if (opts.config === undefined) throw new PublishError("--config <engine.json> or --dir <folder> is required");
  const configPath = resolve(deps.cwd, expandHome(opts.config, deps.homedir));
  let parsed: { dataDir?: unknown; appUpdates?: unknown };
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as typeof parsed;
  } catch (e) {
    throw new PublishError(`cannot read config ${configPath}: ${(e as Error).message}`);
  }
  const overrides = AppUpdatesConfigOverrideSchema.safeParse(parsed.appUpdates ?? {});
  if (!overrides.success) throw new PublishError(`config ${configPath}: appUpdates: ${overrides.error.issues[0]?.message ?? "invalid"}`);
  const cfg = loadAppUpdatesConfig(overrides.data);
  if (cfg.dir !== undefined) return { cfg, dir: cfg.dir };
  if (typeof parsed.dataDir !== "string" || parsed.dataDir === "") throw new PublishError(`config ${configPath} has no "dataDir"`);
  const dataDir = expandHome(parsed.dataDir, deps.homedir);
  if (!isAbsolute(dataDir)) throw new PublishError(`"dataDir" must be an absolute path`);
  return { cfg, dir: appUpdatesDir(cfg, dataDir) };
}

/** The newest app bundle in the dist folder. */
export function newestBundle(cfg: AppUpdatesConfig, engineDir: string = ENGINE_DIR): string {
  const dir = resolve(engineDir, cfg.sourceDir);
  const pattern = new RegExp(cfg.sourcePattern);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new PublishError(`no app bundle: ${dir} does not exist (run: pnpm --filter @kokpit/app dist)`);
  }
  const hits = names
    .filter((n) => pattern.test(n))
    .map((n) => ({ path: join(dir, n), mtimeMs: statSync(join(dir, n)).mtimeMs, isDir: statSync(join(dir, n)).isDirectory() }))
    .filter((h) => h.isDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!hits[0]) throw new PublishError(`no app bundle in ${dir} (run: pnpm --filter @kokpit/app dist)`);
  return hits[0].path;
}

/** The publisher key folder: --signing-dir, else the config's (with `~/` the user's home). */
export function signingDirOf(deps: Pick<PublishDeps, "cwd" | "homedir">, cfg: AppUpdatesConfig, flag: string | undefined): string {
  return resolve(deps.cwd, expandHome(flag ?? cfg.signingKeyDir, deps.homedir));
}

/** The existing publisher key; never creates one (that is `keygen`, done before the app is built). */
export function loadSigningKey(dir: string): SigningKey {
  if (!existsSync(join(dir, SIGNING_PRIVATE_FILE))) {
    throw new PublishError(`no publisher key in ${dir}: run "publish-app.ts keygen" (pnpm deploy:local does), then build the app, then publish`);
  }
  return ensureSigningKey(dir);
}

/** Build id, version and the publisher key id from the bundle's own Info.plist. */
export function readBundleIdentity(cfg: AppUpdatesConfig, appPath: string, deps: Pick<PublishDeps, "run">): { buildId: string; version: string; updateKeyId: string | undefined } {
  const zipPath = appPath; // named in the messages below
  const json = deps.run(cfg.plutilPath, ["-convert", "json", "-o", "-", "--", join(appPath, "Contents", "Info.plist")]);
  if (json.status !== 0) throw new PublishError(`${appPath}: Contents/Info.plist could not be read (${json.stderr.trim() || `exit ${json.status}`})`);
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(json.stdout.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new PublishError(`${zipPath}: Info.plist is not a dictionary`);
  }
  const buildId = info[cfg.buildIdPlistKey];
  const version = info[cfg.versionPlistKey];
  if (typeof buildId !== "string" || !PublishedBuildIdSchema.safeParse(buildId).success) {
    throw new PublishError(`${zipPath}: Info.plist has no ${cfg.buildIdPlistKey} — the bundle was not made by "pnpm --filter @kokpit/app dist" of a build with self-update`);
  }
  if (typeof version !== "string" || version === "") throw new PublishError(`${zipPath}: Info.plist has no ${cfg.versionPlistKey}`);
  const keyId = info[cfg.updateKeyIdPlistKey];
  return { buildId, version, updateKeyId: typeof keyId === "string" ? keyId : undefined };
}

export async function runCli(argv: string[], deps: PublishDeps): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { config: { type: "string" }, dir: { type: "string" }, app: { type: "string" }, "min-engine-build": { type: "string" }, "signing-dir": { type: "string" } },
    });
    const command = positionals[0] ?? "publish";
    if (positionals.length > 1 || !["publish", "list", "keygen"].includes(command)) {
      deps.stderr(USAGE);
      return 64;
    }
    if (command === "keygen") {
      const cfg = values.config !== undefined || values.dir !== undefined ? resolveTarget(deps, { config: values.config, dir: values.dir }).cfg : loadAppUpdatesConfig({});
      const signingDir = signingDirOf(deps, cfg, values["signing-dir"]);
      const key = ensureSigningKey(signingDir);
      deps.stdout(`publisher key ${key.keyId}\n  folder: ${signingDir}\n`);
      return 0;
    }
    const { cfg, dir } = resolveTarget(deps, { config: values.config, dir: values.dir });
    if (command === "list") {
      const current = readCurrentBuild(cfg, dir)?.buildId;
      const builds = listPublishedBuilds(cfg, dir);
      deps.stdout(`${dir}\n${builds.map((m) => `${m.buildId === current ? "*" : " "} ${m.buildId}  ${m.size} bayt  ${m.createdAt}`).join("\n") || "  (yayınlanmış derleme yok)"}\n`);
      return 0;
    }
    const appPath = values.app !== undefined ? resolve(deps.cwd, expandHome(values.app, deps.homedir)) : newestBundle(cfg);
    const { updateKeyId, ...identity } = readBundleIdentity(cfg, appPath, deps);
    const signingKey = loadSigningKey(signingDirOf(deps, cfg, values["signing-dir"]));
    if (updateKeyId !== signingKey.keyId) {
      throw new PublishError(
        `${appPath}: built ${updateKeyId === undefined ? "without a publisher key" : `for publisher key ${updateKeyId}`}, but this engine signs with ${signingKey.keyId}. ` +
          "Such an app would refuse every later update: build it again (pnpm deploy:local builds with the right key).",
      );
    }
    const minEngineBuild = values["min-engine-build"];
    if (minEngineBuild !== undefined && !BuildIdSchema.safeParse(minEngineBuild).success) throw new PublishError("--min-engine-build is not a build id");
    const { manifest, pruned } = await publishAppBuild(cfg, dir, {
      appPath,
      ...identity,
      ...(minEngineBuild !== undefined ? { minEngineBuild } : {}),
      ...(deps.now ? { now: deps.now() } : {}),
      signingKey,
    });
    deps.stdout(
      [`published ${manifest.buildId}`, `  bundle:  ${appPath}`, `  into:    ${join(dir, manifest.buildId)}`, `  entries: ${manifest.entryCount} (${manifest.unpackedSize} bayt)`, `  sha256:  ${manifest.sha256}`, `  size:    ${manifest.size}`, `  signed:  ${manifest.signingKeyId}`, ...(pruned.length > 0 ? [`  pruned:  ${pruned.join(", ")}`] : []), ""].join("\n"),
    );
    return 0;
  } catch (e) {
    deps.stderr(`publish-app: ${(e as Error).message}\n`);
    return e instanceof PublishError ? 1 : 70;
  }
}

export function realDeps(): PublishDeps {
  return {
    cwd: process.cwd(),
    homedir: homedir(),
    run: (cmd, args, input) => {
      const r = spawnSync(cmd, args, { ...(input ? { input } : {}), maxBuffer: 4 * MAX_PLIST_BYTES });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr?.toString("utf8") ?? r.error?.message ?? "" };
    },
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), realDeps());
}
