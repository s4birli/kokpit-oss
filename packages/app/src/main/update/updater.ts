// Kendini güncelleme: the updater itself — when to ask the engine, what to do with its answer, and the journal that
// carries an update across the restart. All I/O comes in through `UpdaterDeps`, so the whole flow runs in tests with
// fakes and a fake clock. Timers live in host.ts; this file only reacts to calls.
//
// One update, start to end:
//   check ──► (auto off: "available", waits for the user) ──► downloading ──► verifying ──► ready
//   ready ──► applying (user said restart · no window focused for idleApplyMs · next launch) ──► app quits
//   next launch as the new build: page reports ready ──► health file ──► "updated"
//   no health signal: the helper puts the old build back ──► next launch as the old build: "rolledBack", build
//   marked bad and never tried again
//
// Before any of it: the engine must have proved itself in the handshake (session.ts), the transport must protect
// the update (loopback / Tailscale / TLS, transport.ts) and the manifest must carry the publisher's signature
// (signature.ts). A build older than the rollback floor (the newest build ever installed and healthy here, its
// signed build stamp) is a downgrade: it is only offered, and goes through only after the user confirmed exactly
// that build ("Eski sürüme dön"). The helper's own rollback after a failed health check is the one exception: it
// returns to the exact backup that was running before.
import { PROTOCOL_VERSION, buildStamp, stampTime, decideCompat, decideUpdate, HANDSHAKE_MESSAGES, type AppUpdateManifest, type BuildInfo, type BundleEntry, type Compat } from "@kokpit/shared";
import type { EngineSettings } from "../../renderer/engine/types.ts";
import type { UpdateBlockReason, UpdatePhase, UpdateStatus } from "../../renderer/engine/update-ipc.ts";
import type { UpdateConfig } from "./config.ts";
import { DownloadError } from "./download.ts";
import type { HelperResult, InstallCheck } from "./install.ts";
import { canTransition, isBusy, shouldAutoApply } from "./policy.ts";
import { SessionError, type EngineHello, type EngineSession } from "./session.ts";
import type { SignatureCheck } from "./signature.ts";
import type { TransportCheck } from "./transport.ts";
import type { PendingUpdate, StateStore } from "./state.ts";
import { archiveUrl, parseCheckResult, parseDownloadResult, UntrustedError } from "./untrusted.ts";
import { VerifyError } from "./verify.ts";
import { t } from "../../i18n/index.ts";

export interface UpdaterDeps {
  cfg: UpdateConfig;
  /** This app's build. */
  app: BuildInfo;
  /** False for an app run from source: the updater stays "disabled". */
  packaged: boolean;
  state: StateStore;
  /** The saved connection, or null when there is none (or its key cannot be read). */
  settings(): Promise<EngineSettings | null>;
  connect(settings: EngineSettings): Promise<EngineSession>;
  /** Whether an update may come over the transport `settings.url` names (loopback / Tailscale now / TLS). */
  transport(settings: EngineSettings): Promise<TransportCheck>;
  /** The manifest is signed by the publisher key this app was built with. */
  verifySignature(manifest: AppUpdateManifest): SignatureCheck;
  /** Fetches the blob for `manifest` (resuming); `url` yields a fresh address per connection. */
  download(manifest: AppUpdateManifest, url: () => Promise<string>, onProgress: (received: number) => void): Promise<string>;
  /** Verifies the blob and writes the bundle from it and the entry list; resolves to the staged bundle. Throws VerifyError. */
  verify(blobPath: string, manifest: AppUpdateManifest, entries: readonly BundleEntry[]): Promise<string>;
  /**
   * The full check again right before the swap (the staged bundle sat on disk since it was verified): the signed
   * list, every file's hash, identity, signature and requirement. False = do not install it.
   */
  reverify(pending: PendingUpdate): Promise<boolean>;
  inspect(archiveBytes: number): Promise<InstallCheck>;
  stagedExists(pending: PendingUpdate): boolean;
  otherInstances(): Promise<number>;
  /** Hands the swap to the helper. The caller quits the app afterwards. */
  startSwap(pending: PendingUpdate): Promise<void>;
  helperResult(buildId: string): HelperResult | undefined;
  markHealthy(buildId: string): Promise<void>;
  /** Drops downloads and unpacked builds (keeps the backup and, if given, this staged bundle). */
  cleanup(keepStaged?: string): Promise<void>;
  now(): number;
  emit(status: UpdateStatus): void;
  log(message: string, detail?: Record<string, unknown>): void;
}

export interface Updater {
  status(): UpdateStatus;
  /**
   * Run once before the first window: settles what the last run left (an update that was applied, rolled back or
   * cut off). "apply" = a ready update was handed to the helper; the caller quits without opening a window.
   */
  startup(): Promise<"apply" | "continue">;
  /** Asks the engine. `byUser`: also fetch an offered build while automatic updates are off. */
  check(opts?: { byUser?: boolean }): Promise<void>;
  /** Restart into the ready build. Resolves true when the swap was handed over (the caller quits the app). */
  apply(reason: "user" | "idle" | "startup"): Promise<boolean>;
  /** Called periodically with whether a window has focus; applies a ready update when the idle rule allows. */
  tick(focused: boolean): Promise<boolean>;
  setAuto(on: boolean): void;
  /**
   * The user's "Eski sürüme dön" for the offered older build `buildId`: lets exactly that build through (downloads,
   * verifies and stages it). False when that is not the build on offer.
   */
  confirmDowngrade(buildId: string): Promise<boolean>;
  /**
   * Recovery, only from the user's confirmed action in Ayarlar: the rollback floor goes back to the running build
   * (e.g. after a wrongly dated build raised it). Nothing else ever lowers it.
   */
  resetFloor(): void;
  /** The page rendered. For a freshly installed build this is the health signal. */
  rendererReady(): Promise<void>;
  dismiss(): void;
}

const notPackagedText = (): string => t("update.status.notPackaged");
const otherInstanceText = (): string => t("update.status.otherInstance");
/** The transport gate said no while downloading (checked again before each attempt). */
class TransportRefused extends Error {}

const STAMP_RE = /^\d{14}$/;
/** `yyyymmddHHMMSS` → `yyyy-mm-dd HH:MM` (UTC). */
function stampDate(stamp: string): string {
  return STAMP_RE.test(stamp) ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}` : "?";
}
const downgradeText = (version: string, stamp: string): string => t("update.status.downgrade", { version, date: stampDate(stamp) });
const engineOlderText = (): string => t("update.status.engineOlder");
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createUpdater(deps: UpdaterDeps): Updater {
  const { cfg, app, state } = deps;
  let phase: UpdatePhase = deps.packaged ? "idle" : "disabled";
  let engine: EngineHello | null = null;
  let compat: Compat | "unknown" = "unknown";
  let target: UpdateStatus["target"];
  let progress: { received: number; total: number } | undefined;
  let blocked: UpdateBlockReason | undefined;
  let message: string | undefined = deps.packaged ? undefined : notPackagedText();
  let checkedAt: number | undefined;
  /** This run is the first launch of a freshly swapped-in build and has not reported healthy yet. */
  let awaitingHealth = false;
  let lastFocusedAt = deps.now();

  /** The rollback floor: max(stored floor, the running build). A lowered or garbled stored value changes nothing. */
  function floor(): string {
    const stored = state.get().floorStamp;
    const running = buildStamp(app.buildId) ?? "";
    return stored !== undefined && STAMP_RE.test(stored) && stored > running ? stored : running;
  }

  /** Older than the floor and not the one build the user confirmed ("Eski sürüme dön"). */
  function belowFloor(buildId: string): boolean {
    const stamp = buildStamp(buildId);
    return stamp !== undefined && stamp < floor() && state.get().allowDowngradeTo !== buildId;
  }

  async function dropPendingBelowFloor(): Promise<void> {
    const pending = state.get().pending;
    if (!pending || !belowFloor(pending.buildId)) return;
    deps.log("staged build below the rollback floor dropped", { buildId: pending.buildId, running: app.buildId });
    state.update((d) => {
      delete d.pending;
    });
    await deps.cleanup().catch(() => {});
  }

  function raiseFloor(): void {
    const running = buildStamp(app.buildId);
    if (running === undefined || running <= floor() && state.get().floorStamp === floor()) return;
    state.update((d) => {
      d.floorStamp = floor() > running ? floor() : running;
      if (d.allowDowngradeTo === app.buildId) delete d.allowDowngradeTo;
    });
  }

  function status(): UpdateStatus {
    const s = state.get();
    const last = s.last && !s.last.dismissed ? { outcome: s.last.outcome, buildId: s.last.buildId, ...(s.last.detail !== undefined ? { detail: s.last.detail } : {}) } : undefined;
    return {
      phase,
      app,
      engine,
      compat,
      auto: s.auto,
      ...(target ? { target } : {}),
      ...(progress ? { progress } : {}),
      ...(blocked ? { blocked } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(last ? { last } : {}),
      ...(checkedAt !== undefined ? { checkedAt: new Date(checkedAt).toISOString() } : {}),
    };
  }

  function go(to: UpdatePhase, patch: { message?: string; blocked?: UpdateBlockReason } = {}): void {
    if (phase !== to && !canTransition(phase, to)) throw new Error(`updater: ${phase} → ${to} is not a transition`);
    phase = to;
    message = patch.message;
    blocked = patch.blocked;
    if (to !== "downloading") progress = undefined;
    if (to === "idle") target = undefined;
    deps.emit(status());
  }

  function markBad(buildId: string, reason: string): void {
    state.update((d) => {
      if (!d.badBuilds.some((b) => b.buildId === buildId)) d.badBuilds.push({ buildId, reason, at: new Date(deps.now()).toISOString() });
      delete d.verifyFailures[buildId];
      if (d.pending?.buildId === buildId) delete d.pending;
    });
    deps.log("build marked bad", { buildId, reason });
  }

  async function report(session: EngineSession): Promise<void> {
    const last = state.get().last;
    if (!last || last.reported) return;
    try {
      await session.request("app.update.report", {
        clientId: state.get().clientId,
        buildId: last.buildId,
        outcome: last.outcome,
        ...(last.detail !== undefined ? { detail: last.detail.slice(0, 500) } : {}),
      });
      state.update((d) => {
        if (d.last) d.last.reported = true;
      });
    } catch (err) {
      deps.log("report failed", { err: errText(err) });
    }
  }

  async function fetchAndStage(session: EngineSession, manifest: AppUpdateManifest, settings: EngineSettings): Promise<void> {
    go("downloading");
    progress = { received: 0, total: manifest.size };
    let archive: string;
    let entries: BundleEntry[] | undefined;
    // The engine names only a token route on its own listener, and a list that is valid as a whole; anything else
    // is refused before a request is made or a byte is written.
    const freshUrl = async (): Promise<string> => {
      // Every attempt (a resumed download is a new connection) passes the transport gate again: Tailscale may
      // have gone down since the check.
      const gate = await deps.transport(settings);
      if (!gate.ok) throw new TransportRefused(gate.message);
      const answer = parseDownloadResult(await session.request("app.update.download", { buildId: manifest.buildId }), manifest, cfg);
      entries = answer.entries;
      return archiveUrl(session.httpOrigin, answer.path);
    };
    try {
      archive = await deps.download(manifest, freshUrl, (received) => {
        progress = { received, total: manifest.size };
        deps.emit(status());
      });
      // The blob was already complete on disk (an earlier run): the list is still needed.
      if (!entries) await freshUrl();
    } catch (err) {
      if (err instanceof TransportRefused) {
        go("blocked", { blocked: "transport", message: err.message });
        return;
      }
      // What arrived stays on disk; the next check continues from there.
      go("error", { message: t("update.status.downloadFailed", { error: errText(err) }) });
      if (!(err instanceof DownloadError) && !(err instanceof SessionError)) deps.log(err instanceof UntrustedError ? "engine answer refused" : "download failed", { err: errText(err) });
      return;
    }
    go("verifying");
    let staged: string;
    try {
      staged = await deps.verify(archive, manifest, entries ?? []);
    } catch (err) {
      // The bytes that arrived are not the ones announced (cut short, or changed on the way): a transport fault —
      // dropped and fetched again, never held against the build.
      if (err instanceof VerifyError && (err.code === "size" || err.code === "hash")) {
        deps.log("download damaged; fetched again next time", { buildId: manifest.buildId, check: err.code });
        await deps.cleanup();
        go("error", { message: t("update.status.downloadCorrupt", { error: errText(err) }) });
        return;
      }
      const failures = (state.get().verifyFailures[manifest.buildId] ?? 0) + 1;
      state.update((d) => {
        d.verifyFailures[manifest.buildId] = failures;
      });
      deps.log("verification failed", { buildId: manifest.buildId, check: err instanceof VerifyError ? err.code : "unexpected", failures });
      await deps.cleanup();
      if (failures >= cfg.maxVerifyFailures) {
        markBad(manifest.buildId, `doğrulanamadı: ${errText(err)}`);
        state.update((d) => {
          d.last = { outcome: "failed", buildId: manifest.buildId, detail: errText(err), reported: false, dismissed: false };
        });
        go("blocked", { blocked: "bad-build", message: t("update.status.verifyFailedBlocked", { error: errText(err) }) });
      } else {
        go("error", { message: t("update.status.verifyFailed", { error: errText(err) }) });
      }
      return;
    }
    state.update((d) => {
      d.pending = {
        phase: "ready",
        buildId: manifest.buildId,
        version: manifest.version,
        stagedBundle: staged,
        entriesSha256: manifest.entriesSha256,
        fromBuildId: app.buildId,
        attempts: 0,
      };
      delete d.verifyFailures[manifest.buildId];
    });
    await deps.cleanup(staged);
    go("ready");
  }

  /** Set from the first line of a check to its last: the saved connection is read before the phase changes. */
  let inCheck = false;

  async function check(opts: { byUser?: boolean } = {}): Promise<void> {
    if (!deps.packaged || inCheck || isBusy(phase)) return;
    inCheck = true;
    try {
      const settings = await deps.settings();
      if (settings) await checkWith(settings, opts);
    } finally {
      inCheck = false;
    }
  }

  async function checkWith(settings: EngineSettings, opts: { byUser?: boolean }): Promise<void> {
    const before = phase;
    go("checking");
    // No update over a transport that does not protect it: nothing is even asked.
    const transport = await deps.transport(settings);
    if (!transport.ok) {
      go("blocked", { blocked: "transport", message: transport.message });
      return;
    }
    let session: EngineSession | undefined;
    try {
      session = await deps.connect(settings);
      engine = session.engine;
      compat = decideCompat(PROTOCOL_VERSION, engine.protocol);
      checkedAt = deps.now();
      // Checked before a single field is used: the build id becomes file names, the size bounds the download.
      const res = parseCheckResult(await session.request("app.update.check", { clientId: state.get().clientId, app, protocol: PROTOCOL_VERSION }), cfg);
      await report(session);
      const pending = state.get().pending;
      const decision = decideUpdate(app.buildId, res.update, state.get().badBuilds.map((b) => b.buildId));
      if (decision.kind === "none" || (pending && decision.manifest.buildId !== pending.buildId)) {
        // Nothing to become any more, or the engine moved on to another build: what was staged is stale.
        if (pending && !awaitingHealth) {
          state.update((d) => {
            delete d.pending;
          });
          await deps.cleanup();
        }
      }
      if (decision.kind === "none") {
        go("idle", compat === "engine-older" ? { message: engineOlderText() } : {});
        return;
      }
      const manifest = decision.manifest;
      target = { buildId: manifest.buildId, version: manifest.version };
      // Only the publisher's signature makes a manifest an update: not the engine's word, not the access key.
      const signed = deps.verifySignature(manifest);
      if (!signed.ok) {
        deps.log("update refused: signature", { buildId: manifest.buildId });
        go("blocked", { blocked: "unsigned", message: signed.message });
        return;
      }
      // A future-dated build would raise the rollback floor into the future for good: refused, whatever it says.
      const stampAt = stampTime(buildStamp(manifest.buildId));
      const createdAt = Date.parse(manifest.createdAt);
      if (stampAt === undefined || !Number.isFinite(createdAt) || stampAt > createdAt + cfg.maxStampAfterCreatedMs || stampAt > deps.now() + cfg.maxStampAheadOfClockMs) {
        deps.log("update refused: build time in the future", { buildId: manifest.buildId, createdAt: manifest.createdAt });
        go("blocked", { blocked: "bad-stamp", message: t("update.status.futureStamp", { buildId: manifest.buildId }) });
        return;
      }
      if (decision.kind === "bad") {
        go("blocked", { blocked: "bad-build", message: t("update.status.badBuild", { buildId: manifest.buildId }) });
        return;
      }
      // Below the rollback floor (the build stamp is part of what the publisher signed): only offered — and a copy of
      // it staged earlier is dropped, not made ready.
      const stamp = buildStamp(manifest.buildId) ?? "";
      if (belowFloor(manifest.buildId)) {
        deps.log("downgrade offered", { from: app.buildId, to: manifest.buildId });
        await dropPendingBelowFloor();
        target = { buildId: manifest.buildId, version: manifest.version, downgrade: true, builtAt: stampDate(stamp) };
        go("available", { message: downgradeText(manifest.version, stamp) });
        return;
      }
      const staged = state.get().pending;
      if (staged?.buildId === manifest.buildId && staged.phase === "ready" && deps.stagedExists(staged)) {
        go("ready");
        return;
      }
      const can = await deps.inspect(manifest.size + manifest.unpackedSize);
      if (!can.ok) {
        go("blocked", { blocked: can.reason, message: can.message });
        return;
      }
      if (!state.get().auto && opts.byUser !== true && state.get().allowDowngradeTo !== manifest.buildId) {
        go("available");
        return;
      }
      await fetchAndStage(session, manifest, settings);
    } catch (err) {
      // An engine from before the handshake: it would answer no update request anyway. Said, not logged as a fault.
      if (err instanceof SessionError && err.code === "outdated") {
        compat = "engine-older";
        engine = null;
        if (isBusy(phase)) {
          phase = before === "ready" || before === "available" || before === "blocked" ? before : "idle";
          if (phase === "idle") target = undefined;
          message = engineOlderText();
          blocked = undefined;
          deps.emit(status());
        }
        return;
      }
      if (err instanceof SessionError && err.code === "unverified") deps.log("engine could not prove itself", {});
      const quiet = err instanceof SessionError && (err.code === "unreachable" || err.code === "timeout" || err.code === "closed");
      if (!quiet && !(err instanceof SessionError && err.code === "unverified")) deps.log("check failed", { err: errText(err) });
      // An unreachable engine is the connection banner's business, not an update error: back to where it was.
      if (isBusy(phase)) {
        phase = before === "ready" || before === "available" || before === "blocked" ? before : "idle";
        if (phase === "idle") target = undefined;
        progress = undefined;
        if (err instanceof SessionError && err.code === "unverified") message = HANDSHAKE_MESSAGES.unverified;
        else if (!quiet) message = t("update.status.checkFailed", { error: errText(err) });
        deps.emit(status());
      }
    } finally {
      session?.close();
    }
  }

  async function apply(reason: "user" | "idle" | "startup"): Promise<boolean> {
    const pending = state.get().pending;
    if (phase !== "ready" || !pending || pending.phase !== "ready") return false;
    if (belowFloor(pending.buildId)) {
      await dropPendingBelowFloor();
      go("idle");
      return false;
    }
    if (!deps.stagedExists(pending) || !(await deps.reverify(pending))) {
      deps.log("staged build no longer valid", { buildId: pending.buildId });
      state.update((d) => {
        delete d.pending;
      });
      await deps.cleanup();
      go("idle", { message: t("update.status.stagedCorrupt") });
      return false;
    }
    if ((await deps.otherInstances()) > 0) {
      message = otherInstanceText();
      blocked = "other-instance";
      deps.emit(status());
      return false;
    }
    state.update((d) => {
      if (d.pending) {
        d.pending.phase = "applying";
        d.pending.attempts += 1;
      }
    });
    go("applying");
    deps.log("applying update", { buildId: pending.buildId, reason });
    try {
      await deps.startSwap({ ...pending, phase: "applying" });
      return true;
    } catch (err) {
      state.update((d) => {
        if (d.pending) d.pending.phase = "ready";
      });
      go("ready", { message: t("update.status.applyFailed", { error: errText(err) }) });
      return false;
    }
  }

  return {
    status,
    check,
    apply,

    async startup() {
      if (!deps.packaged) return "continue";
      const pending = state.get().pending;
      if (!pending) {
        await deps.cleanup().catch(() => {});
        return "continue";
      }
      const result = deps.helperResult(pending.buildId);
      if (app.buildId === pending.buildId) {
        // The swap happened and this is the new build's first run: healthy once the page reports in.
        awaitingHealth = true;
        deps.log("first launch after update", { buildId: app.buildId, from: pending.fromBuildId });
        return "continue";
      }
      if (result === "rolledBack") {
        markBad(pending.buildId, "kurulduktan sonra açılmadı");
        state.update((d) => {
          d.last = { outcome: "rolledBack", buildId: pending.buildId, detail: t("update.status.rolledBack"), reported: false, dismissed: false };
        });
        await deps.cleanup().catch(() => {});
        return "continue";
      }
      if (pending.phase === "applying") {
        // The swap was started but this is still the old build: the helper gave up, or the Mac went down first.
        if (pending.attempts >= cfg.maxApplyAttempts || !deps.stagedExists(pending)) {
          markBad(pending.buildId, "kurulum tamamlanamadı");
          state.update((d) => {
            d.last = { outcome: "failed", buildId: pending.buildId, detail: t("update.status.installFailed"), reported: false, dismissed: false };
          });
          await deps.cleanup().catch(() => {});
          return "continue";
        }
        state.update((d) => {
          if (d.pending) d.pending.phase = "ready";
        });
      }
      // A build staged before a newer one got installed (or before the floor rose) is never installed at startup.
      if (belowFloor(state.get().pending?.buildId ?? "")) await dropPendingBelowFloor();
      const ready = state.get().pending;
      if (!ready || !deps.stagedExists(ready)) {
        state.update((d) => {
          delete d.pending;
        });
        await deps.cleanup().catch(() => {});
        return "continue";
      }
      target = { buildId: ready.buildId, version: ready.version };
      go("ready");
      // "On next launch": nobody is in the middle of anything yet, so a ready update goes in before the window opens.
      if (state.get().auto && (await apply("startup"))) return "apply";
      return "continue";
    },

    async tick(focused) {
      const now = deps.now();
      if (focused) lastFocusedAt = now;
      if (!shouldAutoApply({ phase, auto: state.get().auto, focused, lastFocusedAt, now, idleApplyMs: cfg.idleApplyMs })) return false;
      return apply("idle");
    },

    setAuto(on) {
      state.update((d) => {
        d.auto = on;
      });
      deps.emit(status());
    },

    resetFloor() {
      const running = buildStamp(app.buildId);
      deps.log("rollback floor reset by the user", { from: state.get().floorStamp ?? null, to: running ?? null });
      state.update((d) => {
        if (running === undefined) delete d.floorStamp;
        else d.floorStamp = running;
        delete d.allowDowngradeTo;
      });
      deps.emit(status());
    },

    async confirmDowngrade(buildId) {
      if (!target?.downgrade || target.buildId !== buildId || phase !== "available") return false;
      deps.log("downgrade confirmed", { from: app.buildId, to: buildId });
      state.update((d) => {
        d.allowDowngradeTo = buildId;
      });
      await check({ byUser: true });
      return true;
    },

    async rendererReady() {
      // This build is up: the rollback floor rises to it (never falls).
      raiseFloor();
      if (!awaitingHealth) return;
      awaitingHealth = false;
      const pending = state.get().pending;
      await deps.markHealthy(app.buildId);
      state.update((d) => {
        delete d.pending;
        d.last = { outcome: "updated", buildId: app.buildId, ...(pending ? { detail: t("update.status.previous", { buildId: pending.fromBuildId }) } : {}), reported: false, dismissed: false };
      });
      deps.log("update healthy", { buildId: app.buildId });
      await deps.cleanup().catch(() => {});
      deps.emit(status());
    },

    dismiss() {
      state.update((d) => {
        if (d.last) d.last.dismissed = true;
      });
      deps.emit(status());
    },
  };
}
