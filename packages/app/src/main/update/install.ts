// Kendini güncelleme: where the running app is installed, whether it can be replaced there, and the swap itself.
//
// The swap is done by a small shell helper AFTER this process has exited — a running bundle is never replaced
// under itself. The helper is our own text (below), written by the running, already trusted app; nothing from the
// download runs before the new bundle is launched as the app.
//
//   <parent>/Kokpit.app                                            the app (target)
//   <parent>/.Kokpit-update/                                       0700, ours: checked before every use
//   <parent>/.Kokpit-update/backup/Kokpit.app                      the one backup (the build before the last swap)
//   <parent>/.Kokpit-update/profiles/<p>/downloads/<build>.bin.part  the download         ┐ per app profile
//   <parent>/.Kokpit-update/profiles/<p>/builds/<build>/Kokpit.app   the verified build   ┘ (userData)
//
// Staged builds live in their own subfolder, so no build id can ever name the backup (and a build id is never a
// plain word: PublishedBuildIdSchema). Everything is on the app's volume: the swap is renames.
//
// Helper: refuse when the paths overlap → wait for the old process to exit → set the current backup aside →
// rename target → backup, staged → target → launch → wait for the new build's health file → drop the old backup.
// No health file in time: stop what runs from the target, put the backup back (and the old backup with it), launch
// it, and leave `rolledBack` for the old build to read. Whatever fails, an app remains at the target: if the backup
// cannot be moved back, the failed build is moved back instead. If the second rename fails, the first is undone at
// once. A power cut between the two renames (microseconds apart) leaves no app at the target: the previous build
// is then in `.Kokpit-update/backup/` and is moved back by hand (documented in docs/kabul-testleri.md).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readFileSync } from "node:fs";
import { rawFsp } from "./fs-raw.ts";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { UpdateBlockReason } from "../../renderer/engine/update-ipc.ts";
import type { UpdateConfig } from "./config.ts";
import { UntrustedError } from "./untrusted.ts";
import { t } from "../../i18n/index.ts";

// Bundles in the staging folder contain `app.asar`: deleted as plain files, never looked into (fs-raw.ts).
const { access, lstat, mkdir, readFile, readdir, rm, statfs, writeFile } = rawFsp;
import type { RunTool } from "./verify.ts";

export interface InstallLocation {
  /** `/…/Kokpit.app` */
  bundlePath: string;
  /** `Kokpit.app` */
  bundleName: string;
  parentDir: string;
  stagingDir: string;
  backupBundle: string;
  /** This app profile's part of the staging folder, and its two subfolders. */
  profileDir: string;
  buildsDir: string;
  downloadsDir: string;
}

/** A short, stable name for an app profile (its userData folder): staged builds are kept per profile. */
export function profileKeyOf(userDataDir: string): string {
  return createHash("sha256").update(userDataDir).digest("hex").slice(0, 16);
}

/** The bundle an executable path belongs to (`X.app/Contents/MacOS/<exe>`), or undefined outside a bundle. */
export function locateBundle(exePath: string, cfg: UpdateConfig, profileKey: string): InstallLocation | undefined {
  const macos = dirname(exePath);
  const contents = dirname(macos);
  const bundlePath = dirname(contents);
  if (basename(macos) !== "MacOS" || basename(contents) !== "Contents" || !bundlePath.endsWith(".app")) return undefined;
  if (!/^[0-9a-f]{16}$/.test(profileKey)) throw new Error("bad profile key");
  const parentDir = dirname(bundlePath);
  const bundleName = basename(bundlePath);
  const stagingDir = join(parentDir, cfg.stagingDirName);
  const profileDir = join(stagingDir, cfg.profilesDirName, profileKey);
  return {
    bundlePath,
    bundleName,
    parentDir,
    stagingDir,
    backupBundle: join(stagingDir, cfg.backupDirName, bundleName),
    profileDir,
    buildsDir: join(profileDir, cfg.buildsDirName),
    downloadsDir: join(profileDir, cfg.downloadsDirName),
  };
}

/** The folders of the staging area, outermost first. */
const stagingFolders = (loc: InstallLocation): string[] => [loc.stagingDir, dirname(loc.backupBundle), dirname(loc.profileDir), loc.profileDir, loc.buildsDir, loc.downloadsDir];

/**
 * Creates the staging folders (0700) where missing and checks every one: a real folder, not a link, owned by this
 * user, nobody else may enter. A folder someone else could have prepared (a link to elsewhere, another owner, open
 * permissions) is never written into.
 */
export async function ensureStagingFolders(loc: InstallLocation, uid: number | undefined = process.getuid?.()): Promise<InstallCheck> {
  for (const dir of stagingFolders(loc)) {
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, reason: "unsafe-staging", message: t("update.install.stagingCreate", { dir }) };
      }
    }
    let st;
    try {
      st = await lstat(dir);
    } catch {
      return { ok: false, reason: "unsafe-staging", message: t("update.install.stagingRead", { dir }) };
    }
    const problem = st.isSymbolicLink()
      ? t("update.install.problemLink")
      : !st.isDirectory()
        ? t("update.install.problemNotFolder")
        : uid !== undefined && st.uid !== uid
          ? t("update.install.problemOwner")
          : (st.mode & 0o777) !== 0o700
            ? t("update.install.problemMode", { mode: (st.mode & 0o777).toString(8) })
            : undefined;
    if (problem !== undefined) {
      return { ok: false, reason: "unsafe-staging", message: t("update.install.stagingUnsafe", { dir, problem }) };
    }
  }
  return { ok: true };
}

/**
 * `<stagingDir>/<name>` — and nothing else. Every path made from a value the engine supplied (a build id) goes
 * through here: the last guard should a name with a separator or `..` ever get past the checks before it.
 */
export function stagingChild(stagingDir: string, name: string): string {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new UntrustedError(t("update.install.fileName"));
  const base = resolve(stagingDir);
  const path = resolve(base, name);
  if (dirname(path) !== base) throw new UntrustedError(t("update.install.fileName"));
  return path;
}

export type InstallCheck = { ok: true } | { ok: false; reason: UpdateBlockReason; message: string };

export interface InstallFs {
  access(path: string, mode: number): Promise<void>;
  statfs(path: string): Promise<{ bavail: number | bigint; bsize: number | bigint }>;
}
const realFs: InstallFs = { access, statfs };

/** Can a build of `archiveBytes` be staged and swapped in where the app is? (Staging folders: ensureStagingFolders.) */
export async function inspectInstall(loc: InstallLocation, archiveBytes: number, cfg: UpdateConfig, fs: InstallFs = realFs): Promise<InstallCheck> {
  if (loc.bundlePath.includes(cfg.translocationMarker)) {
    return {
      ok: false,
      reason: "translocated",
      message: t("update.install.translocated"),
    };
  }
  try {
    await fs.access(loc.parentDir, constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EROFS"
      ? { ok: false, reason: "read-only", message: t("update.install.readOnly", { dir: loc.parentDir }) }
      : { ok: false, reason: "no-write", message: t("update.install.noWrite", { dir: loc.parentDir }) };
  }
  try {
    const s = await fs.statfs(loc.parentDir);
    const free = Number(s.bavail) * Number(s.bsize);
    const needed = archiveBytes * cfg.freeSpaceFactor;
    if (free < needed) {
      const mb = (n: number): string => `${Math.ceil(n / (1024 * 1024))} MB`;
      return { ok: false, reason: "disk-space", message: t("update.install.diskSpace", { needed: mb(needed), free: mb(free) }) };
    }
  } catch {
    // Unknown free space is not a reason to refuse; a full disk fails the download or the unpacking instead.
  }
  return { ok: true };
}

/** True when `pid` runs this bundle's executable (a Kokpit main process, not just any process). */
export async function isAppProcess(pid: number, exePath: string, cfg: UpdateConfig, run: RunTool): Promise<boolean> {
  const r = await run(cfg.tools.ps, ["-p", String(pid), "-o", "comm="]);
  return r.status === 0 && r.stdout.trim() === exePath;
}

/** Main processes running from this bundle's executable, other than `ownPid`. */
export async function otherInstances(exePath: string, ownPid: number, cfg: UpdateConfig, run: RunTool): Promise<number> {
  const r = await run(cfg.tools.ps, ["-axo", "pid=,comm="]);
  if (r.status !== 0) return 0;
  let n = 0;
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2] === exePath && Number(m[1]) !== ownPid) n++;
  }
  return n;
}

export const HELPER_RESULTS = ["swapped", "healthy", "rolledBack", "aborted"] as const;
export type HelperResult = (typeof HELPER_RESULTS)[number];

const resultFile = (stateDir: string, buildId: string): string => join(stateDir, `result-${buildId}`);
const healthFile = (stateDir: string, buildId: string): string => join(stateDir, `healthy-${buildId}`);

/** What the helper last wrote about `buildId`, if anything. */
export function readHelperResult(stateDir: string, buildId: string): HelperResult | undefined {
  try {
    const text = readFileSync(resultFile(stateDir, buildId), "utf8").trim();
    return (HELPER_RESULTS as readonly string[]).includes(text) ? (text as HelperResult) : undefined;
  } catch {
    return undefined;
  }
}

/** The new build's "I am up" signal; the helper stops watching when it sees it. */
export async function writeHealthFile(stateDir: string, buildId: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(healthFile(stateDir, buildId), `${process.pid}\n`, { mode: 0o600 });
}

/** Forgets the helper's files of one build (after its outcome was read). */
export async function clearHelperFiles(stateDir: string, buildId: string): Promise<void> {
  await rm(resultFile(stateDir, buildId), { force: true });
  await rm(healthFile(stateDir, buildId), { force: true });
}

/**
 * The swap helper. POSIX sh; every path arrives as an argument (never pasted into the text), so no path can change
 * what the script does. Arguments:
 *   mode(apply) old-pid target staged backup state-dir build-id exit-wait-s health-wait-s -- launch command…
 */
export const HELPER_SCRIPT = `#!/bin/sh
set -u
MODE=$1; OLD_PID=$2; TARGET=$3; STAGED=$4; BACKUP=$5; STATE=$6; BUILD=$7; EXIT_WAIT=$8; HEALTH_WAIT=$9
shift 9
[ "\${1:-}" = "--" ] && shift
PS_BIN=\${KOKPIT_UPDATE_PS:-ps}

log() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$STATE/helper.log" 2>/dev/null; }
result() { printf '%s\\n' "$1" > "$STATE/result-$BUILD.tmp" && mv -f "$STATE/result-$BUILD.tmp" "$STATE/result-$BUILD"; log "result $1"; }
launch() { "$@" >/dev/null 2>&1 || log "launch failed: $1"; }
# wait_exit <pid> <seconds>: 0 once the process is gone, 1 if it still runs after the wait.
wait_exit() {
  i=0
  while kill -0 "$1" 2>/dev/null; do
    [ "$i" -ge $(( $2 * 5 )) ] && return 1
    sleep 0.2
    i=$(( i + 1 ))
  done
  return 0
}
# Everything that runs from inside the target bundle (the app and its helper processes).
target_pids() {
  "$PS_BIN" -axo pid=,comm= | while read -r pid comm; do
    case "$comm" in "$TARGET/Contents/"*) printf '%s\\n' "$pid" ;; esac
  done
}
stop_target() {
  for pid in $(target_pids); do kill "$pid" 2>/dev/null; done
  i=0
  while [ -n "$(target_pids)" ] && [ "$i" -lt 25 ]; do sleep 0.2; i=$(( i + 1 )); done
  for pid in $(target_pids); do kill -9 "$pid" 2>/dev/null; done
}

[ "$MODE" = "apply" ] || { log "unknown mode $MODE"; exit 64; }
mkdir -p "$STATE"
# The four places must be four different places: a build staged AT (or inside) the backup or the target would be
# deleted or moved onto itself.
BACKUP_DIR=$(dirname "$BACKUP")
PREV="$BACKUP.previous"
overlap() {
  case "$1" in "$2"|"$2"/*) return 0 ;; esac
  case "$2" in "$1"/*) return 0 ;; esac
  return 1
}
if overlap "$STAGED" "$BACKUP_DIR" || overlap "$STAGED" "$TARGET" || overlap "$TARGET" "$BACKUP_DIR"; then
  log "refused: staged, target and backup overlap"
  result aborted
  exit 4
fi
log "apply $BUILD: waiting for $OLD_PID"
if ! wait_exit "$OLD_PID" "$EXIT_WAIT"; then
  # The old app did not quit: nothing is touched.
  result aborted
  exit 1
fi
if [ ! -d "$STAGED" ] || [ ! -d "$TARGET" ]; then
  result aborted
  launch "$@"
  exit 1
fi
# The current backup is set aside, not deleted: it is dropped only once the new build has reported healthy.
restore_prev() { if [ -d "$PREV" ] && [ ! -e "$BACKUP" ]; then mv "$PREV" "$BACKUP"; fi; }
mkdir -p "$BACKUP_DIR"
rm -rf "$PREV"
if [ -e "$BACKUP" ] && ! mv "$BACKUP" "$PREV"; then
  result aborted
  launch "$@"
  exit 1
fi
if ! mv "$TARGET" "$BACKUP"; then
  restore_prev
  result aborted
  launch "$@"
  exit 1
fi
if ! mv "$STAGED" "$TARGET"; then
  mv "$BACKUP" "$TARGET"
  restore_prev
  result aborted
  launch "$@"
  exit 1
fi
result swapped
launch "$@"

i=0
while [ ! -f "$STATE/healthy-$BUILD" ]; do
  if [ "$i" -ge "$HEALTH_WAIT" ]; then
    log "no health signal after $HEALTH_WAIT s: rolling back"
    stop_target
    FAILED="$STAGED.failed"
    rm -rf "$FAILED"
    if ! mv "$TARGET" "$FAILED"; then
      log "rollback: the failed build could not be moved; it stays"
      launch "$@"
      exit 3
    fi
    if mv "$BACKUP" "$TARGET"; then
      restore_prev
      rm -rf "$FAILED"
      result rolledBack
      launch "$@"
      exit 2
    fi
    # The backup could not be put back: the failed build goes back, so an app always remains at the target.
    mv "$FAILED" "$TARGET"
    log "rollback: the backup could not be moved back; the new build stays (started again)"
    # Stopped above: started again, so the user is not left with nothing running.
    launch "$@"
    exit 3
  fi
  sleep 1
  i=$(( i + 1 ))
done
rm -rf "$PREV"
result healthy
exit 0
`;

export interface ApplyPlan {
  oldPid: number;
  location: InstallLocation;
  stagedBundle: string;
  stateDir: string;
  buildId: string;
  /** Arguments the app was started with (forwarded, like Electron's own relaunch does). */
  appArgs: readonly string[];
  env: NodeJS.ProcessEnv;
}

const inside = (a: string, b: string): boolean => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

/** argv of the helper for a plan; the part after `--` is the launch command. Throws for overlapping paths. */
export function helperArgs(plan: ApplyPlan, scriptPath: string, cfg: UpdateConfig): string[] {
  const staged = resolve(plan.stagedBundle);
  const target = resolve(plan.location.bundlePath);
  const backupDir = resolve(dirname(plan.location.backupBundle));
  if (inside(staged, backupDir) || inside(staged, target) || inside(target, backupDir)) throw new Error("staged, target and backup overlap");
  const forwarded = cfg.relaunchEnv.flatMap((name) => (plan.env[name] !== undefined ? ["--env", `${name}=${plan.env[name]}`] : []));
  return [
    scriptPath,
    "apply",
    String(plan.oldPid),
    plan.location.bundlePath,
    plan.stagedBundle,
    plan.location.backupBundle,
    plan.stateDir,
    plan.buildId,
    String(Math.ceil(cfg.exitWaitMs / 1000)),
    String(Math.ceil(cfg.healthTimeoutMs / 1000)),
    "--",
    cfg.tools.open,
    "-n",
    ...forwarded,
    plan.location.bundlePath,
    ...(plan.appArgs.length > 0 ? ["--args", ...plan.appArgs] : []),
  ];
}

/** Writes the helper next to the state and starts it detached; it outlives this process. */
export async function startHelper(plan: ApplyPlan, cfg: UpdateConfig): Promise<void> {
  await mkdir(plan.stateDir, { recursive: true });
  await clearHelperFiles(plan.stateDir, plan.buildId);
  const scriptPath = join(plan.stateDir, "apply.sh");
  await writeFile(scriptPath, HELPER_SCRIPT, { mode: 0o700 });
  const child = spawn(cfg.tools.sh, helperArgs(plan, scriptPath, cfg), {
    detached: true,
    stdio: "ignore",
    cwd: plan.stateDir,
    env: {
      PATH: cfg.helperPath,
      KOKPIT_UPDATE_PS: cfg.tools.ps,
      ...Object.fromEntries(["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"].flatMap((k) => (plan.env[k] !== undefined ? [[k, plan.env[k]]] : []))),
    },
  });
  child.unref();
}

/**
 * Removes this profile's downloads and unpacked builds; `keep` (a staged bundle) stays. Other profiles' builds and
 * the backup are never touched.
 */
export async function cleanStaging(loc: InstallLocation, keep?: string): Promise<void> {
  for (const dir of [loc.downloadsDir, loc.buildsDir]) {
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (keep !== undefined && (path === keep || keep.startsWith(path + sep))) continue;
      await rm(path, { recursive: true, force: true });
    }
  }
}

/** Downloads of other builds (a stale `.part` of a build the engine no longer publishes) are dropped. */
export async function cleanOtherDownloads(loc: InstallLocation, keepFile: string): Promise<void> {
  if (!existsSync(loc.downloadsDir)) return;
  for (const name of await readdir(loc.downloadsDir)) {
    const path = join(loc.downloadsDir, name);
    if (path !== keepFile) await rm(path, { recursive: true, force: true });
  }
}

const LOCK_FILE = "apply.lock";
/** Answers whether a pid is a running Kokpit main process (not just any process that reuses the pid). */
export type IsAppProcess = (pid: number) => Promise<boolean>;

async function lockPid(stateDir: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(join(stateDir, LOCK_FILE), "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The pid of ANOTHER running Kokpit that holds the apply lock; undefined when the lock is free or stale. */
export async function applyLockHolder(stateDir: string, isApp: IsAppProcess): Promise<number | undefined> {
  const pid = await lockPid(stateDir);
  if (pid === undefined || pid === process.pid) return undefined;
  return (await isApp(pid)) ? pid : undefined;
}

/**
 * Takes the apply lock (created exclusively). A lock left by a process that is gone — or whose pid now belongs to
 * something that is not Kokpit — is stale and replaced. False when another running Kokpit holds it.
 */
export async function takeApplyLock(stateDir: string, isApp: IsAppProcess): Promise<boolean> {
  await mkdir(stateDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(join(stateDir, LOCK_FILE), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if ((await applyLockHolder(stateDir, isApp)) !== undefined) return false;
      await rm(join(stateDir, LOCK_FILE), { force: true });
    }
  }
  return false;
}

/** Drops the lock unless another running Kokpit holds it (the new build's start, a startup without a swap). */
export async function releaseApplyLock(stateDir: string, isApp: IsAppProcess): Promise<void> {
  if ((await applyLockHolder(stateDir, isApp)) === undefined) await rm(join(stateDir, LOCK_FILE), { force: true });
}
