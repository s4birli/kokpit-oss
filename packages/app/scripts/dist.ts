// Builds and packages the app with ONE build identity: the same id is compiled into the main process (what the app
// says it is) and written into the bundle's Info.plist (what the updater checks before it lets a build in).
//
//   node scripts/dist.ts            → dist/mac-arm64/Kokpit.app + dist/Kokpit-<version>-arm64-mac.zip
//
// Environment:
//   KOKPIT_DIST_DIR            output folder instead of dist/ (tests build into temp folders)
//   KOKPIT_APP_SIGNING_DIR     the publisher key folder (@kokpit/shared update-signing.ts) whose PUBLIC key the app
//                              embeds; default: the engine's appUpdates.signingKeyDir default. Nothing is created
//                              here — `pnpm deploy:local` makes the key first. Without a key the app installs no
//                              update (a warning is printed).
//   KOKPIT_CODESIGN_IDENTITY   signing identity instead of the ad-hoc "-" of electron-builder.yml (e.g. the name of
//                              a self-signed code-signing certificate, so every build has the same identity)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildInfo } from "@kokpit/shared/build-info";
import { keyIdOf, readSigningPublicKey } from "@kokpit/shared/update-signing";
import { homedir } from "node:os";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(APP_DIR, "node_modules", ".bin");
/** Read by electron.vite.config.ts; the one place both halves of the build get the identity from. */
export const BUILD_INFO_ENV = "KOKPIT_BUILD_INFO";
const DIST_DIR_ENV = "KOKPIT_DIST_DIR";
const IDENTITY_ENV = "KOKPIT_CODESIGN_IDENTITY";
const SIGNING_DIR_ENV = "KOKPIT_APP_SIGNING_DIR";
/** Read by electron.vite.config.ts. */
const PUBLIC_KEY_ENV = "KOKPIT_UPDATE_PUBLIC_KEY";
const ENGINE_UPDATE_DEFAULTS = join(APP_DIR, "..", "engine", "app-updates.defaults.json");

/** The publisher key folder: $KOKPIT_APP_SIGNING_DIR, else the engine's default (`~/` = home). */
function signingDir(): string {
  const raw = process.env[SIGNING_DIR_ENV] || (JSON.parse(readFileSync(ENGINE_UPDATE_DEFAULTS, "utf8")) as { signingKeyDir: string }).signingKeyDir;
  return raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync(cmd, args, { cwd: APP_DIR, env, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.signal})`);
}

function main(): void {
  const { buildIdPlistKey, updateKeyIdPlistKey } = JSON.parse(readFileSync(join(APP_DIR, "src", "main", "update", "update.defaults.json"), "utf8")) as {
    buildIdPlistKey: string;
    updateKeyIdPlistKey: string;
  };
  const build = computeBuildInfo({ packageJsonPath: join(APP_DIR, "package.json") });
  const keyDir = signingDir();
  const publicKey = readSigningPublicKey(keyDir);
  if (publicKey === undefined) process.stderr.write(`\nWARNING: no publisher key in ${keyDir}: this build will install NO update (run pnpm deploy:local).\n\n`);
  const env = { ...process.env, [BUILD_INFO_ENV]: JSON.stringify(build), [PUBLIC_KEY_ENV]: publicKey ?? "" };

  run(join(BIN, "electron-vite"), ["build"], env);

  const outDir = process.env[DIST_DIR_ENV];
  if (outDir !== undefined && outDir !== "" && !isAbsolute(outDir)) throw new Error(`${DIST_DIR_ENV} must be an absolute path`);
  const identity = process.env[IDENTITY_ENV];
  run(
    join(BIN, "electron-builder"),
    [
      "--mac",
      "--arm64",
      "--publish",
      "never",
      `-c.mac.extendInfo.${buildIdPlistKey}=${build.buildId}`,
      ...(publicKey !== undefined ? [`-c.mac.extendInfo.${updateKeyIdPlistKey}=${keyIdOf(publicKey)}`] : []),
      ...(outDir ? [`-c.directories.output=${outDir}`] : []),
      ...(identity ? [`-c.mac.identity=${identity}`] : []),
    ],
    env,
  );
  process.stdout.write(`\nbuilt ${build.buildId}${publicKey !== undefined ? ` (updates from publisher key ${keyIdOf(publicKey)})` : " (NO update key)"}\n`);
}

main();
