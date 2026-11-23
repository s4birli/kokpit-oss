// Kendini güncelleme: the Electron side of the updater — real files, real tools, timers and IPC around updater.ts.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rawFsp } from "./fs-raw.ts";
import { dirname, join } from "node:path";
import type { BuildInfo } from "@kokpit/shared";
import type { EngineSettings } from "../../renderer/engine/types.ts";
import { UPDATE_IPC, type UpdateStatus } from "../../renderer/engine/update-ipc.ts";
import { APP_BUILD, APP_UPDATE_KEY } from "./build-info.ts";
import { loadUpdateConfig, type UpdateConfig } from "./config.ts";
import { downloadArchive } from "./download.ts";
import {
  applyLockHolder,
  cleanOtherDownloads,
  cleanStaging,
  ensureStagingFolders,
  isAppProcess,
  profileKeyOf,
  releaseApplyLock,
  type IsAppProcess,
  inspectInstall,
  locateBundle,
  otherInstances,
  readHelperResult,
  stagingChild,
  startHelper,
  takeApplyLock,
  writeHealthFile,
  type InstallLocation,
} from "./install.ts";
import { openSession } from "./session.ts";
import { createStateStore } from "./state.ts";
import { createUpdater, type Updater } from "./updater.ts";
import { bundleLimitsOf, readBundleIdentity, reverifyStaged, stableRequirement, verifyAndUnpack, VerifyError, type RunTool } from "./verify.ts";
import { checkManifestSignature } from "./signature.ts";
import { checkUpdateTransport } from "./transport.ts";
import { validateBundleEntries } from "@kokpit/shared";
import { entriesSha256 } from "@kokpit/shared/update-signing";
import type { TailnetConfig, TailnetVerifier } from "../tailnet.ts";
import { t } from "../../i18n/index.ts";

/** The parts of Electron's `app` the host uses. */
export interface AppLike {
  isPackaged: boolean;
  getPath(name: "userData" | "exe"): string;
  quit(): void;
  exit(code: number): void;
  moveToApplicationsFolder?(): boolean;
}

export interface UpdateHostDeps {
  app: AppLike;
  /** The saved connection (decrypted), or null. */
  settings(): Promise<EngineSettings | null>;
  /** Sends to the app window, if there is one. */
  send(channel: string, payload: unknown): void;
  /** True while a window of the app has the keyboard focus. */
  focused(): boolean;
  build?: BuildInfo;
  /** The publisher's public key updates must be signed with (default: the one this build embeds). */
  updateKey?: string | undefined;
  /** Tailscale's own view of the tailnet: an update comes over Tailscale only while the address is in it. */
  tailnet: { verifier: Pick<TailnetVerifier, "verify">; config: Pick<TailnetConfig, "cidrs"> };
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface UpdateHost {
  /** Registers the IPC handlers through main's guarded `handle`. */
  register(handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => void): void;
  /** Before the first window. True = an update is being installed right now: do not open a window, the app quits. */
  beforeWindow(): Promise<boolean>;
  /** Starts the periodic checks. */
  start(): void;
  stop(): void;
  status(): UpdateStatus;
}

const { readFile, rm, writeFile } = rawFsp;
/** The validated, signed entry list, kept next to a staged bundle (reverify reads it back). */
const ENTRIES_FILE = "entries.json";

/** A graceful quit that did not happen within this long is forced; the swap helper is waiting for the exit. */
const QUIT_GRACE_MS = 5000;
const TOOL_MAX_BUFFER = 8 * 1024 * 1024;

function toolRunner(cfg: UpdateConfig): RunTool {
  return (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: cfg.toolTimeoutMs, maxBuffer: TOOL_MAX_BUFFER, encoding: "utf8" }, (err, stdout, stderr) => {
        const status = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : null) : 0;
        resolve({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    });
}

export function createUpdateHost(deps: UpdateHostDeps): UpdateHost {
  const { app } = deps;
  const build = deps.build ?? APP_BUILD;
  const updateKey = "updateKey" in deps ? deps.updateKey : APP_UPDATE_KEY;
  const env = deps.env ?? process.env;
  const userData = app.getPath("userData");
  // The folder name itself is fixed by the defaults: the overrides file has to be found before it can be read.
  const base = loadUpdateConfig("").config;
  const stateDir = join(userData, base.stateDirName);
  const loaded = loadUpdateConfig(join(stateDir, base.overridesFileName));
  const cfg = loaded.config;
  const log = (message: string, detail?: Record<string, unknown>): void => console.info(`[kokpit] update: ${message}`, detail ?? "");
  if (loaded.problem !== undefined) log("overrides file ignored", { problem: loaded.problem });

  const exePath = app.getPath("exe");
  // Staged builds are kept per app profile (userData): two profiles of one app never clean each other's up.
  const location: InstallLocation | undefined = app.isPackaged ? locateBundle(exePath, cfg, profileKeyOf(userData)) : undefined;
  const run = toolRunner(cfg);
  const state = createStateStore(join(stateDir, cfg.stateFileName));

  let runningIdentity: Promise<{ bundleName: string; bundleId: string; requirement: string | undefined }> | undefined;
  const running = (loc: InstallLocation) =>
    (runningIdentity ??= (async () => ({
      bundleName: loc.bundleName,
      bundleId: (await readBundleIdentity(loc.bundlePath, cfg, run)).bundleId,
      requirement: await stableRequirement(loc.bundlePath, cfg, run),
    }))());

  const isApp: IsAppProcess = (pid) => isAppProcess(pid, exePath, cfg, run);

  const need = (): InstallLocation => {
    if (!location) throw new Error("not a packaged app");
    return location;
  };

  const updater: Updater = createUpdater({
    cfg,
    app: build,
    packaged: location !== undefined,
    state,
    settings: deps.settings,
    connect: (settings) => openSession(settings, { handshakeTimeoutMs: cfg.handshakeTimeoutMs, requestTimeoutMs: cfg.requestTimeoutMs }),
    transport: (settings) => checkUpdateTransport(settings.url, deps.tailnet.verifier, deps.tailnet.config),
    verifySignature: (manifest) => checkManifestSignature(manifest, updateKey),
    async download(manifest, url, onProgress) {
      const loc = need();
      if (manifest.size > cfg.maxArchiveBytes) throw new Error(t("update.host.archiveTooLarge"));
      const folders = await ensureStagingFolders(loc);
      if (!folders.ok) throw new Error(folders.message);
      const partPath = stagingChild(loc.downloadsDir, `${manifest.buildId}.bin.part`);
      // A stale download of another build is not left to fill the disk.
      await cleanOtherDownloads(loc, partPath);
      await downloadArchive({ url, partPath, size: manifest.size, attempts: cfg.downloadAttempts, idleTimeoutMs: cfg.downloadIdleTimeoutMs, onProgress });
      return partPath;
    },
    async verify(blobPath, manifest, entries) {
      const loc = need();
      try {
        const extractDir = stagingChild(loc.buildsDir, manifest.buildId);
        const staged = await verifyAndUnpack({ blobPath, entries, extractDir, manifest, publicKey: updateKey, running: await running(loc) }, cfg, run);
        // The signed list goes next to the bundle: the check before the swap compares the tree with it again.
        await writeFile(join(extractDir, ENTRIES_FILE), JSON.stringify(entries), { mode: 0o600, flag: "wx" });
        return staged;
      } finally {
        // Verified or not, the blob has served its purpose (a failed one must not be resumed from).
        await rm(blobPath, { force: true });
      }
    },
    async reverify(pending) {
      const loc = need();
      try {
        const raw: unknown = JSON.parse(await readFile(join(dirname(pending.stagedBundle), ENTRIES_FILE), "utf8"));
        // The list on disk must still be the signed one the build was verified against.
        if (entriesSha256(raw) !== pending.entriesSha256) return false;
        const entries = validateBundleEntries(raw, bundleLimitsOf(cfg));
        await reverifyStaged({ stagedBundle: pending.stagedBundle, entries, buildId: pending.buildId, version: pending.version, running: await running(loc) }, cfg, run);
        return true;
      } catch (err) {
        log("staged build failed its check before the swap", { check: err instanceof VerifyError ? err.code : "unexpected" });
        return false;
      }
    },
    async inspect(bytes) {
      const loc = need();
      const can = await inspectInstall(loc, bytes, cfg);
      return can.ok ? ensureStagingFolders(loc) : can;
    },
    stagedExists: (pending) => existsSync(join(pending.stagedBundle, "Contents", "Info.plist")),
    async otherInstances() {
      if ((await applyLockHolder(stateDir, isApp)) !== undefined) return 1;
      return otherInstances(exePath, process.pid, cfg, run);
    },
    async startSwap(pending) {
      if (!(await takeApplyLock(stateDir, isApp))) throw new Error(t("update.host.otherInstaller"));
      await startHelper(
        { oldPid: process.pid, location: need(), stagedBundle: pending.stagedBundle, stateDir, buildId: pending.buildId, appArgs: (deps.argv ?? process.argv).slice(1), env },
        cfg,
      );
    },
    helperResult: (buildId) => readHelperResult(stateDir, buildId),
    async markHealthy(buildId) {
      await writeHealthFile(stateDir, buildId);
      // The old process that took the lock is gone; this build is up.
      await releaseApplyLock(stateDir, isApp);
    },
    cleanup: async (keep) => {
      if (location) await cleanStaging(location, keep);
    },
    now: Date.now,
    emit: (status) => deps.send(UPDATE_IPC.changed, status),
    log,
  });

  const timers: ReturnType<typeof setTimeout>[] = [];
  let quitting = false;
  function quitForSwap(): void {
    if (quitting) return;
    quitting = true;
    app.quit();
    setTimeout(() => app.exit(0), QUIT_GRACE_MS).unref();
  }
  const safely = (work: Promise<unknown>): void => void work.catch((err: unknown) => log("failed", { err: err instanceof Error ? err.message : String(err) }));

  return {
    status: () => updater.status(),

    register(handle) {
      handle(UPDATE_IPC.status, async () => updater.status());
      handle(UPDATE_IPC.check, async () => void safely(updater.check()));
      handle(UPDATE_IPC.download, async () => void safely(updater.check({ byUser: true })));
      handle(UPDATE_IPC.apply, async () => {
        if (await updater.apply("user")) quitForSwap();
      });
      handle(UPDATE_IPC.setAuto, async (on) => {
        updater.setAuto(on === true);
        if (on === true) safely(updater.check());
      });
      handle(UPDATE_IPC.rendererReady, async () => {
        await updater.rendererReady();
      });
      handle(UPDATE_IPC.dismiss, async () => updater.dismiss());
      // "Eski sürüme dön": its own action, never a side effect of checking.
      handle(UPDATE_IPC.resetFloor, async () => updater.resetFloor());
      handle(UPDATE_IPC.confirmDowngrade, async (buildId) => {
        if (typeof buildId === "string") safely(updater.confirmDowngrade(buildId));
      });
      handle(UPDATE_IPC.moveToApplications, async () => {
        // Electron asks before replacing an app of the same name and relaunches from the new place.
        if (app.isPackaged) app.moveToApplicationsFolder?.();
      });
    },

    async beforeWindow() {
      try {
        if ((await updater.startup()) === "apply") {
          quitForSwap();
          return true;
        }
        // No swap in flight from this start: a lock the last (now gone) process left behind is released.
        await releaseApplyLock(stateDir, isApp);
      } catch (err) {
        log("startup failed", { err: err instanceof Error ? err.message : String(err) });
      }
      return false;
    },

    start() {
      if (!location) return;
      timers.push(setTimeout(() => safely(updater.check()), cfg.startupCheckDelayMs));
      timers.push(setInterval(() => safely(updater.check()), cfg.checkIntervalMs));
      timers.push(
        setInterval(() => {
          safely(
            updater.tick(deps.focused()).then((applied) => {
              if (applied) quitForSwap();
            }),
          );
        }, cfg.idlePollMs),
      );
      for (const t of timers) t.unref();
    },

    stop() {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}
