// @vitest-environment node
// Kendini güncelleme — the updater's state machine with fakes and a fake clock:
// idle → downloading → verifying → ready → applying → (relaunch) → healthy, or rolled back and never tried again.
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type AppUpdateManifest, type BuildInfo } from "@kokpit/shared";
import type { UpdatePhase, UpdateStatus } from "../../renderer/engine/update-ipc.ts";
import { DEFAULT_UPDATE_CONFIG, loadUpdateConfig } from "./config.ts";
import { DownloadError } from "./download.ts";
import type { HelperResult, InstallCheck } from "./install.ts";
import { canTransition, isBusy, shouldAutoApply } from "./policy.ts";
import { SessionError, type EngineHello, type EngineSession } from "./session.ts";
import { createStateStore, freshState, memoryStateStore, type PendingUpdate, type StateStore, type UpdateState } from "./state.ts";
import { createUpdater, type Updater, type UpdaterDeps } from "./updater.ts";
import { VerifyError } from "./verify.ts";
import type { SignatureCheck } from "./signature.ts";
import type { TransportCheck } from "./transport.ts";
import { entriesSha256 } from "@kokpit/shared/update-signing";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = { ...DEFAULT_UPDATE_CONFIG, idleApplyMs: 10 * 60_000, maxApplyAttempts: 2, maxVerifyFailures: 2 };
const build = (id: string): BuildInfo => ({ buildId: id, version: "0.1.0", commit: "abc", builtAt: "2026-11-18T10:00:00.000Z" });
const A = "0.1.0+20261118100000.aaa";
const B = "0.1.0+20261118110000.bbb";
const C = "0.1.0+20261118120000.ccc";
const ENTRIES = [
  { path: "Contents", type: "dir" as const },
  { path: "Contents/Info.plist", type: "file" as const, mode: 0o644 as const, size: 3000, sha256: "b".repeat(64) },
];
const manifest = (buildId: string): AppUpdateManifest => ({
  buildId,
  version: "0.1.0",
  format: 1,
  bundleName: "Kokpit.app",
  sha256: "a".repeat(64),
  size: 1000,
  unpackedSize: 3000,
  entryCount: ENTRIES.length,
  createdAt: "2026-11-18T12:00:00.000Z",
  entriesSha256: entriesSha256(ENTRIES)!,
  signingKeyId: "c".repeat(16),
  signature: `${"A".repeat(86)}==`,
});
const TOKEN = "t".repeat(43);
const SETTINGS = { url: "ws://engine.test:7420", key: "k".repeat(20) };

interface World {
  updater: Updater;
  state: StateStore;
  phases: UpdatePhase[];
  statuses: UpdateStatus[];
  requests: { method: string; params: Record<string, unknown> }[];
  swaps: PendingUpdate[];
  healthy: string[];
  cleanups: (string | undefined)[];
  logs: string[];
  clock: { now: number };
  /** Mutable world the fakes read. */
  env: {
    published: AppUpdateManifest | null;
    engine: EngineHello;
    settings: typeof SETTINGS | null;
    connectError?: Error;
    downloadError?: Error;
    verifyError?: Error;
    /** When set, the fake download only calls this (with the fresh-url function) and succeeds. */
    downloadHook?: (url: () => Promise<string>) => Promise<void>;
    inspect: InstallCheck;
    staged: boolean;
    reverify: boolean;
    others: number;
    helperResult?: HelperResult;
    swapError?: Error;
    transport: TransportCheck;
    signature: SignatureCheck;
  };
}

function world(opts: { app?: string; packaged?: boolean; state?: UpdateState } = {}): World {
  const state = memoryStateStore(opts.state ?? freshState());
  const w: Omit<World, "updater"> = {
    state,
    phases: [],
    statuses: [],
    requests: [],
    swaps: [],
    healthy: [],
    cleanups: [],
    logs: [],
    clock: { now: 1_800_000_000_000 },
    env: {
      published: null,
      engine: { version: "0.1.0", build: build("0.1.0+20261118090000.eng"), protocol: PROTOCOL_VERSION },
      settings: SETTINGS,
      inspect: { ok: true },
      staged: true,
      reverify: true,
      others: 0,
      transport: { ok: true, via: "loopback" },
      signature: { ok: true },
    },
  };
  const session = (): EngineSession => ({
    engine: w.env.engine,
    httpOrigin: "http://engine.test:7420",
    async request(method, params) {
      w.requests.push({ method, params: params as Record<string, unknown> });
      if (method === "app.update.check") return { engine: { build: w.env.engine.build!, protocol: w.env.engine.protocol! }, update: w.env.published } as never;
      if (method === "app.update.download") return { path: `/app-updates/${TOKEN}`, size: 1000, sha256: "a".repeat(64), expiresAt: "x", entries: ENTRIES } as never;
      return {} as never;
    },
    close() {},
  });
  const deps: UpdaterDeps = {
    cfg,
    app: build(opts.app ?? A),
    packaged: opts.packaged ?? true,
    state,
    settings: async () => w.env.settings,
    connect: async () => {
      if (w.env.connectError) throw w.env.connectError;
      return session();
    },
    transport: async () => w.env.transport,
    verifySignature: () => w.env.signature,
    download: async (m, url, onProgress) => {
      if (w.env.downloadError) throw w.env.downloadError;
      if (w.env.downloadHook) {
        await w.env.downloadHook(url);
        onProgress(m.size);
        return `/staging/${m.buildId}.zip.part`;
      }
      expect(await url()).toBe(`http://engine.test:7420/app-updates/${TOKEN}`);
      onProgress(m.size);
      return `/staging/${m.buildId}.zip.part`;
    },
    verify: async (_archive, m, entries) => {
      // The list the engine sent with the download reaches the unpacker.
      expect(entries).toEqual(ENTRIES);
      if (w.env.verifyError) throw w.env.verifyError;
      return `/staging/${m.buildId}/Kokpit.app`;
    },
    reverify: async () => w.env.reverify,
    inspect: async (bytes) => {
      // Room is asked for the download AND the unpacked bundle.
      expect(bytes).toBe(1000 + 3000);
      return w.env.inspect;
    },
    stagedExists: () => w.env.staged,
    otherInstances: async () => w.env.others,
    startSwap: async (p) => {
      if (w.env.swapError) throw w.env.swapError;
      w.swaps.push(p);
    },
    helperResult: () => w.env.helperResult,
    markHealthy: async (id) => void w.healthy.push(id),
    cleanup: async (keep) => void w.cleanups.push(keep),
    now: () => w.clock.now,
    emit: (s) => {
      w.statuses.push(s);
      if (w.phases.at(-1) !== s.phase) w.phases.push(s.phase);
    },
    log: (m) => void w.logs.push(m),
  };
  return { ...w, updater: createUpdater(deps) };
}

const MIN = 60_000;

describe("policy", () => {
  it("phases follow each other only along the documented paths", () => {
    expect(canTransition("idle", "checking")).toBe(true);
    expect(canTransition("checking", "downloading")).toBe(true);
    expect(canTransition("downloading", "verifying")).toBe(true);
    expect(canTransition("verifying", "ready")).toBe(true);
    expect(canTransition("ready", "applying")).toBe(true);
    // Never straight from a download to a swap, never out of "disabled".
    expect(canTransition("downloading", "applying")).toBe(false);
    expect(canTransition("idle", "applying")).toBe(false);
    expect(canTransition("available", "applying")).toBe(false);
    expect(canTransition("disabled", "checking")).toBe(false);
    expect(isBusy("downloading")).toBe(true);
    expect(isBusy("ready")).toBe(false);
  });

  it("auto-apply: only when ready, automatic, unfocused, and unfocused for the whole idle period", () => {
    const base = { phase: "ready" as UpdatePhase, auto: true, focused: false, lastFocusedAt: 0, now: 10 * MIN, idleApplyMs: 10 * MIN };
    expect(shouldAutoApply(base)).toBe(true);
    expect(shouldAutoApply({ ...base, now: 10 * MIN - 1 })).toBe(false);
    expect(shouldAutoApply({ ...base, auto: false })).toBe(false);
    expect(shouldAutoApply({ ...base, phase: "downloading" })).toBe(false);
    // A focused window is never interrupted, however long nothing happened in it.
    expect(shouldAutoApply({ ...base, focused: true, now: 1000 * MIN })).toBe(false);
  });
});

describe("check", () => {
  it("nothing published → idle; the app told the engine who it is", async () => {
    const w = world();
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "idle", compat: "ok", engine: { build: { buildId: "0.1.0+20261118090000.eng" } } });
    expect(w.requests).toEqual([{ method: "app.update.check", params: { clientId: w.state.get().clientId, app: build(A), protocol: PROTOCOL_VERSION } }]);
    expect(w.phases).toEqual(["checking", "idle"]);
  });

  it("a published build is downloaded in the background, verified and staged: idle → checking → downloading → verifying → ready", async () => {
    const w = world();
    w.env.published = manifest(B);
    await w.updater.check();
    expect(w.phases).toEqual(["checking", "downloading", "verifying", "ready"]);
    expect(w.updater.status()).toMatchObject({ phase: "ready", target: { buildId: B } });
    expect(w.state.get().pending).toEqual({ phase: "ready", buildId: B, version: "0.1.0", stagedBundle: `/staging/${B}/Kokpit.app`, entriesSha256: entriesSha256(ENTRIES), fromBuildId: A, attempts: 0 });
    // Nothing was swapped: being ready restarts nothing by itself.
    expect(w.swaps).toEqual([]);
    expect(w.statuses.some((s) => s.progress?.received === 1000)).toBe(true);
  });

  it("already that build → nothing; a second check while ready stays ready without downloading again", async () => {
    const w = world();
    w.env.published = manifest(A);
    await w.updater.check();
    expect(w.updater.status().phase).toBe("idle");
    w.env.published = manifest(B);
    await w.updater.check();
    const downloads = w.requests.filter((r) => r.method === "app.update.download").length;
    await w.updater.check();
    expect(w.updater.status().phase).toBe("ready");
    expect(w.requests.filter((r) => r.method === "app.update.download")).toHaveLength(downloads);
  });

  it("automatic updates off → only 'available'; the user's click fetches it", async () => {
    const w = world();
    w.updater.setAuto(false);
    w.env.published = manifest(B);
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "available", auto: false, target: { buildId: B } });
    expect(w.requests.some((r) => r.method === "app.update.download")).toBe(false);
    await w.updater.check({ byUser: true });
    expect(w.updater.status().phase).toBe("ready");
    // …and it still does not restart by itself, however idle the app is.
    w.clock.now += 100 * MIN;
    expect(await w.updater.tick(false)).toBe(false);
    expect(await w.updater.apply("user")).toBe(true);
  });

  it("an engine from before the handshake (closes without a challenge) is 'older': no update request reaches it", async () => {
    const w = world();
    w.env.connectError = new SessionError("outdated", "Motor eski sürüm");
    await w.updater.check();
    expect(w.requests).toEqual([]);
    expect(w.updater.status()).toMatchObject({ phase: "idle", compat: "engine-older" });
    expect(w.updater.status().message).toContain("Motor");
  });

  it("a server that could not prove it is the engine: nothing asked, nothing fetched, the user is told", async () => {
    const w = world();
    w.env.published = manifest(B);
    w.env.connectError = new SessionError("unverified", "x");
    await w.updater.check();
    expect(w.requests).toEqual([]);
    expect(w.updater.status().phase).toBe("idle");
    expect(w.updater.status().message).toContain("kanıtlayamadı");
    expect(w.logs).toContain("engine could not prove itself");
  });

  it("a transport that does not protect the update (not loopback / Tailscale / TLS): not even a connection", async () => {
    const w = world();
    w.env.published = manifest(B);
    w.env.transport = { ok: false, message: "Güncelleme yalnız Tailscale ya da bu Mac üzerinden alınır" };
    await w.updater.check();
    expect(w.requests).toEqual([]);
    expect(w.updater.status()).toMatchObject({ phase: "blocked", blocked: "transport" });
    expect(w.updater.status().message).toContain("Tailscale ya da bu Mac");
    // Back on Tailscale: the check goes through.
    w.env.transport = { ok: true, via: "tailnet" };
    await w.updater.check();
    expect(w.updater.status().phase).toBe("ready");
  });

  it("a manifest not signed by the publisher: blocked, nothing downloaded, not marked bad (a real build may follow)", async () => {
    const w = world();
    w.env.published = manifest(B);
    w.env.signature = { ok: false, message: "Güncellemenin imzası geçersiz; kurulmadı." };
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "blocked", blocked: "unsigned" });
    expect(w.requests.some((r) => r.method === "app.update.download")).toBe(false);
    expect(w.state.get().badBuilds).toEqual([]);
    expect(w.state.get().pending).toBeUndefined();
  });

  it("a manifest whose (signed) stamp is later than its own createdAt, or far later than this Mac's clock, is refused", async () => {
    const future = "0.1.0+20261118130000.fff";
    const w = world({ app: A });
    w.env.published = { ...manifest(future), createdAt: "2026-11-18T12:00:00.000Z" };
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "blocked", blocked: "bad-stamp" });
    expect(w.requests.some((r) => r.method === "app.update.download")).toBe(false);
    // createdAt agrees, but the clock here says it is years earlier.
    const v = world({ app: A });
    v.clock.now = Date.UTC(2026, 0, 1);
    v.env.published = { ...manifest(future), createdAt: "2026-11-18T13:00:00.000Z" };
    await v.updater.check();
    expect(v.updater.status()).toMatchObject({ phase: "blocked", blocked: "bad-stamp" });
    // Neither raised the floor.
    expect(w.state.get().floorStamp).toBeUndefined();
  });

  it("the floor can be reset — only on the user's confirmed action — back to the running build", async () => {
    const w = world({ app: A, state: { ...freshState(), floorStamp: "20991231235959" } });
    w.env.published = manifest(B);
    await w.updater.check();
    expect(w.updater.status().target?.downgrade).toBe(true);
    w.updater.resetFloor();
    expect(w.state.get().floorStamp).toBe("20261118100000");
    await w.updater.check();
    expect(w.updater.status().phase).toBe("ready");
  });

  it("an older signed build (below the floor) is offered, never downloaded or applied — whatever the signing identity", async () => {
    const w = world({ app: C });
    w.env.published = manifest(B);
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "available", target: { buildId: B, downgrade: true } });
    expect(w.requests.some((r) => r.method === "app.update.download")).toBe(false);
    // Neither "check" nor "İndir" by the user gets past it…
    await w.updater.check({ byUser: true });
    expect(w.requests.some((r) => r.method === "app.update.download")).toBe(false);
    expect(w.state.get().pending).toBeUndefined();
    // …and nothing applies it, however idle.
    w.clock.now += 1000 * MIN;
    expect(await w.updater.tick(false)).toBe(false);
    expect(w.swaps).toEqual([]);
  });

  it("only the dedicated 'Eski sürüme dön' confirmation of THAT build lets it through", async () => {
    const w = world({ app: C });
    w.env.published = manifest(B);
    await w.updater.check();
    expect(await w.updater.confirmDowngrade(A)).toBe(false);
    expect(w.updater.status().phase).toBe("available");
    expect(await w.updater.confirmDowngrade(B)).toBe(true);
    expect(w.updater.status().phase).toBe("ready");
    expect(w.state.get().pending?.buildId).toBe(B);
    expect(await w.updater.apply("user")).toBe(true);
    // Another, even older build later is a new decision: the confirmation was for B only.
    const next = world({ app: C, state: w.state.get() });
    next.env.published = manifest(A);
    await next.updater.check();
    expect(next.updater.status()).toMatchObject({ phase: "available", target: { buildId: A, downgrade: true } });
  });

  it("the floor is the highest build ever installed AND healthy, and survives restarts", async () => {
    const run1 = world({ app: C });
    expect(run1.state.get().floorStamp).toBeUndefined();
    await run1.updater.rendererReady();
    expect(run1.state.get().floorStamp).toBe("20261118120000");
    // A later run as an older build (a confirmed downgrade, or a manual install): the floor stays at C.
    const run2 = world({ app: A, state: run1.state.get() });
    await run2.updater.rendererReady();
    expect(run2.state.get().floorStamp).toBe("20261118120000");
    run2.env.published = manifest(B);
    await run2.updater.check();
    expect(run2.updater.status()).toMatchObject({ phase: "available", target: { buildId: B, downgrade: true } });
  });

  it("a tampered floor (lowered, garbage) counts as max(floor, the running build)", async () => {
    for (const floorStamp of ["19700101000000", "not-a-stamp", ""]) {
      const w = world({ app: C, state: { ...freshState(), floorStamp } as UpdateState });
      w.env.published = manifest(B);
      await w.updater.check();
      expect(w.updater.status().target?.downgrade, floorStamp).toBe(true);
      expect(w.requests.some((r) => r.method === "app.update.download")).toBe(false);
    }
  });

  it("a newer build than the floor is a plain update; the rollback after a failed health check is not affected", async () => {
    const w = world({ app: A, state: { ...freshState(), floorStamp: "20261118100000" } });
    w.env.published = manifest(B);
    await w.updater.check();
    expect(w.updater.status().phase).toBe("ready");
    expect(w.updater.status().target?.downgrade).toBeUndefined();
  });

  it("an engine behind the app's protocol is 'older'; one ahead means the app is older — and the update still comes", async () => {
    const w = world();
    w.env.engine = { ...w.env.engine, protocol: PROTOCOL_VERSION - 1 };
    await w.updater.check();
    expect(w.updater.status().compat).toBe("engine-older");
    w.env.engine = { ...w.env.engine, protocol: PROTOCOL_VERSION + 1 };
    w.env.published = manifest(B);
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ compat: "app-older", phase: "ready" });
  });

  it("an unreachable engine is not an update error: the phase is left as it was, quietly", async () => {
    const w = world();
    w.env.connectError = new SessionError("unreachable", "Motora bağlanılamadı");
    await w.updater.check();
    expect(w.updater.status().phase).toBe("idle");
    expect(w.updater.status().message).toBeUndefined();
    expect(w.logs).toEqual([]);
  });

  it("no saved connection, or an app run from source → nothing is asked", async () => {
    const w = world();
    w.env.settings = null;
    await w.updater.check();
    expect(w.phases).toEqual([]);
    const dev = world({ packaged: false });
    dev.env.published = manifest(B);
    await dev.updater.check();
    expect(dev.updater.status().phase).toBe("disabled");
    expect(await dev.updater.startup()).toBe("continue");
  });

  it("cannot be installed where the app is → blocked with the reason, nothing downloaded", async () => {
    const w = world();
    w.env.published = manifest(B);
    w.env.inspect = { ok: false, reason: "translocated", message: "taşı" };
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "blocked", blocked: "translocated", message: "taşı" });
    expect(w.requests.some((r) => r.method === "app.update.download")).toBe(false);
    // Fixed (the app was moved): the next check goes through.
    w.env.inspect = { ok: true };
    await w.updater.check();
    expect(w.updater.status().phase).toBe("ready");
  });

  it("a failed download is an error that the next check retries", async () => {
    const w = world();
    w.env.published = manifest(B);
    w.env.downloadError = new DownloadError("network", "bağlantı koptu");
    await w.updater.check();
    expect(w.updater.status().phase).toBe("error");
    expect(w.updater.status().message).toContain("bağlantı koptu");
    expect(w.state.get().pending).toBeUndefined();
    delete w.env.downloadError;
    await w.updater.check();
    expect(w.updater.status().phase).toBe("ready");
  });

  it.each([
    ["size", "kesik indirme"],
    ["hash", "özet uyuşmuyor"],
  ] as const)("a %s mismatch of the download is a transport fault: retried, never counted toward 'bad build'", async (code, text) => {
    const w = world();
    w.env.published = manifest(B);
    w.env.verifyError = new VerifyError(code, text);
    for (let i = 0; i < cfg.maxVerifyFailures + 2; i++) {
      await w.updater.check();
      expect(w.updater.status().phase).toBe("error");
    }
    expect(w.state.get().badBuilds).toEqual([]);
    expect(w.state.get().verifyFailures[B] ?? 0).toBe(0);
    delete w.env.verifyError;
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "ready", target: { buildId: B } });
  });

  it("the transport gate is checked again before each download attempt (Tailscale may have gone down meanwhile)", async () => {
    const w = world();
    w.env.published = manifest(B);
    let calls = 0;
    const flip = w.env;
    w.env.downloadHook = async (url) => {
      calls++;
      flip.transport = { ok: false, message: "Tailscale kapalı" };
      await url();
    };
    await w.updater.check();
    expect(calls).toBe(1);
    expect(w.updater.status()).toMatchObject({ phase: "blocked", blocked: "transport" });
    expect(w.state.get().pending).toBeUndefined();
  });

  it("a build that fails verification is never staged; after maxVerifyFailures it is marked bad and not fetched again", async () => {
    const w = world();
    w.env.published = manifest(B);
    w.env.verifyError = new VerifyError("entries", "liste uyuşmuyor");
    await w.updater.check();
    expect(w.updater.status().phase).toBe("error");
    expect(w.state.get().pending).toBeUndefined();
    expect(w.state.get().badBuilds).toEqual([]);
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "blocked", blocked: "bad-build" });
    expect(w.state.get().badBuilds.map((b) => b.buildId)).toEqual([B]);
    const before = w.requests.length;
    delete w.env.verifyError;
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "blocked", blocked: "bad-build" });
    expect(w.requests.slice(before).map((r) => r.method)).toEqual(["app.update.check", "app.update.report"]);
    // A NEW build (another id) is taken again.
    w.env.published = manifest(C);
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "ready", target: { buildId: C } });
  });

  it("the engine moved on to another build while one was staged: the stale one is dropped, the new one staged", async () => {
    const w = world();
    w.env.published = manifest(B);
    await w.updater.check();
    w.env.published = manifest(C);
    await w.updater.check();
    expect(w.state.get().pending?.buildId).toBe(C);
    w.env.published = null;
    await w.updater.check();
    expect(w.state.get().pending).toBeUndefined();
    expect(w.updater.status().phase).toBe("idle");
  });

  it("two checks at once: the second does nothing", async () => {
    const w = world();
    w.env.published = manifest(B);
    await Promise.all([w.updater.check(), w.updater.check()]);
    expect(w.requests.filter((r) => r.method === "app.update.check")).toHaveLength(1);
  });
});

describe("consent and idle (fake clock)", () => {
  async function ready(): Promise<World> {
    const w = world();
    w.env.published = manifest(B);
    await w.updater.check();
    return w;
  }

  it("a focused window is never restarted, however long the update has been ready", async () => {
    const w = await ready();
    for (let i = 0; i < 100; i++) {
      w.clock.now += MIN;
      expect(await w.updater.tick(true)).toBe(false);
    }
    expect(w.swaps).toEqual([]);
  });

  it("unfocused: restarts only once no window has had focus for idleApplyMs", async () => {
    const w = await ready();
    expect(await w.updater.tick(true)).toBe(false);
    w.clock.now += 9 * MIN;
    expect(await w.updater.tick(false)).toBe(false);
    // The user came back for a moment: the wait starts again.
    expect(await w.updater.tick(true)).toBe(false);
    w.clock.now += 9 * MIN;
    expect(await w.updater.tick(false)).toBe(false);
    w.clock.now += MIN;
    expect(await w.updater.tick(false)).toBe(true);
    expect(w.swaps.map((s) => s.buildId)).toEqual([B]);
    expect(w.updater.status().phase).toBe("applying");
    expect(w.state.get().pending).toMatchObject({ phase: "applying", attempts: 1 });
  });

  it("the user's 'Yeniden başlat' applies at once, focused or not", async () => {
    const w = await ready();
    await w.updater.tick(true);
    expect(await w.updater.apply("user")).toBe(true);
    expect(w.phases.slice(-2)).toEqual(["ready", "applying"]);
  });

  it("apply does nothing unless an update is ready", async () => {
    const w = world();
    expect(await w.updater.apply("user")).toBe(false);
    expect(w.swaps).toEqual([]);
  });

  it("another instance of the app is running: not applied, the strip says why, and it applies once that is gone", async () => {
    const w = await ready();
    w.env.others = 1;
    expect(await w.updater.apply("user")).toBe(false);
    expect(w.updater.status()).toMatchObject({ phase: "ready", blocked: "other-instance" });
    expect(w.state.get().pending?.phase).toBe("ready");
    w.env.others = 0;
    expect(await w.updater.apply("user")).toBe(true);
  });

  it("a staged build that no longer verifies right before the swap is dropped, not installed", async () => {
    const w = await ready();
    w.env.reverify = false;
    expect(await w.updater.apply("user")).toBe(false);
    expect(w.swaps).toEqual([]);
    expect(w.state.get().pending).toBeUndefined();
    expect(w.updater.status().phase).toBe("idle");
  });

  it("the helper could not be started: back to ready, nothing lost", async () => {
    const w = await ready();
    w.env.swapError = new Error("spawn failed");
    expect(await w.updater.apply("user")).toBe(false);
    expect(w.updater.status().phase).toBe("ready");
    expect(w.state.get().pending?.phase).toBe("ready");
  });
});

describe("the launch after", () => {
  const pending = (over: Partial<PendingUpdate> = {}): PendingUpdate => ({
    phase: "applying",
    buildId: B,
    version: "0.1.0",
    stagedBundle: `/staging/${B}/Kokpit.app`,
    entriesSha256: entriesSha256(ENTRIES)!,
    fromBuildId: A,
    attempts: 1,
    ...over,
  });
  const withPending = (p: PendingUpdate, auto = true): UpdateState => ({ ...freshState(), auto, pending: p });

  it("as the new build: healthy only once the page reports in; then 'updated' is recorded and reported to the engine", async () => {
    const w = world({ app: B, state: withPending(pending()) });
    w.env.helperResult = "swapped";
    expect(await w.updater.startup()).toBe("continue");
    expect(w.healthy).toEqual([]);
    expect(w.state.get().pending).toBeDefined();
    await w.updater.rendererReady();
    expect(w.healthy).toEqual([B]);
    expect(w.state.get().pending).toBeUndefined();
    expect(w.state.get().last).toMatchObject({ outcome: "updated", buildId: B, reported: false });
    w.env.published = manifest(B);
    await w.updater.check();
    expect(w.requests.find((r) => r.method === "app.update.report")?.params).toMatchObject({ buildId: B, outcome: "updated" });
    expect(w.state.get().last?.reported).toBe(true);
    // A second page load is not a second health report.
    await w.updater.rendererReady();
    expect(w.healthy).toEqual([B]);
  });

  it("a check while the new build has not reported healthy yet does not throw its own journal away", async () => {
    const w = world({ app: B, state: withPending(pending()) });
    await w.updater.startup();
    w.env.published = manifest(B);
    await w.updater.check();
    expect(w.state.get().pending?.buildId).toBe(B);
  });

  it("as the old build after a rollback: the build is marked bad, the user is told, and it is never downloaded again", async () => {
    const w = world({ app: A, state: withPending(pending()) });
    w.env.helperResult = "rolledBack";
    expect(await w.updater.startup()).toBe("continue");
    expect(w.state.get().badBuilds.map((b) => b.buildId)).toEqual([B]);
    expect(w.state.get().pending).toBeUndefined();
    expect(w.updater.status().last).toMatchObject({ outcome: "rolledBack", buildId: B });
    w.env.published = manifest(B);
    await w.updater.check();
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "blocked", blocked: "bad-build" });
    expect(w.requests.some((r) => r.method === "app.update.download")).toBe(false);
    expect(w.requests.find((r) => r.method === "app.update.report")?.params).toMatchObject({ buildId: B, outcome: "rolledBack" });
    expect(w.swaps).toEqual([]);
    w.updater.dismiss();
    expect(w.updater.status().last).toBeUndefined();
  });

  it("a build staged earlier but older than the floor is NOT installed at startup: dropped, the app stays", async () => {
    // Running C, floor C, B staged ready (e.g. staged before C was installed by hand).
    const w = world({ app: C, state: { ...withPending(pending({ phase: "ready", attempts: 0, fromBuildId: A })), floorStamp: "20261118120000" } });
    expect(await w.updater.startup()).toBe("continue");
    expect(w.swaps).toEqual([]);
    expect(w.state.get().pending).toBeUndefined();
    // Also when the stored floor is gone: the running build is the floor.
    const v = world({ app: C, state: withPending(pending({ phase: "ready", attempts: 0, fromBuildId: A })) });
    expect(await v.updater.startup()).toBe("continue");
    expect(v.swaps).toEqual([]);
  });

  it("…unless the user confirmed exactly that older build", async () => {
    const w = world({ app: C, state: { ...withPending(pending({ phase: "ready", attempts: 0, fromBuildId: C })), floorStamp: "20261118120000", allowDowngradeTo: B } });
    expect(await w.updater.startup()).toBe("apply");
    expect(w.swaps.map((x) => x.buildId)).toEqual([B]);
  });

  it("the 'already staged' shortcut does not make an older staged build ready", async () => {
    const w = world({ app: C, state: { ...withPending(pending({ phase: "ready", attempts: 0, fromBuildId: A })), floorStamp: "20261118120000" } });
    w.env.published = manifest(B);
    await w.updater.check();
    expect(w.updater.status()).toMatchObject({ phase: "available", target: { buildId: B, downgrade: true } });
    expect(w.state.get().pending).toBeUndefined();
    expect(await w.updater.apply("user")).toBe(false);
    expect(w.swaps).toEqual([]);
  });

  it("power went out before the swap (still the old build, staged build intact): it is applied on this launch", async () => {
    const w = world({ app: A, state: withPending(pending({ attempts: 1 })) });
    expect(await w.updater.startup()).toBe("apply");
    expect(w.swaps.map((s) => s.buildId)).toEqual([B]);
    expect(w.state.get().pending).toMatchObject({ phase: "applying", attempts: 2 });
  });

  it("a swap that was given up maxApplyAttempts times is not tried a third time: marked bad, the app stays as it is", async () => {
    const w = world({ app: A, state: withPending(pending({ attempts: 2 })) });
    w.env.helperResult = "aborted";
    expect(await w.updater.startup()).toBe("continue");
    expect(w.swaps).toEqual([]);
    expect(w.state.get().badBuilds.map((b) => b.buildId)).toEqual([B]);
    expect(w.updater.status().last).toMatchObject({ outcome: "failed", buildId: B });
  });

  it("the staged build is gone (someone cleaned the folder): the journal is dropped, nothing breaks", async () => {
    const w = world({ app: A, state: withPending(pending({ phase: "ready", attempts: 0 })) });
    w.env.staged = false;
    expect(await w.updater.startup()).toBe("continue");
    expect(w.state.get().pending).toBeUndefined();
    expect(w.updater.status().phase).toBe("idle");
  });

  it("'on next launch': a ready update is applied before the window opens — unless automatic updates are off", async () => {
    const auto = world({ app: A, state: withPending(pending({ phase: "ready", attempts: 0 })) });
    expect(await auto.updater.startup()).toBe("apply");
    expect(auto.swaps).toHaveLength(1);

    const manual = world({ app: A, state: withPending(pending({ phase: "ready", attempts: 0 }), false) });
    expect(await manual.updater.startup()).toBe("continue");
    expect(manual.swaps).toEqual([]);
    expect(manual.updater.status()).toMatchObject({ phase: "ready", target: { buildId: B } });
  });

  it("a journal about a build that is neither this one nor a rollback target (the app was reinstalled by hand) is settled", async () => {
    const w = world({ app: C, state: withPending(pending({ phase: "ready", attempts: 0 })) });
    w.env.staged = false;
    expect(await w.updater.startup()).toBe("continue");
    expect(w.state.get().pending).toBeUndefined();
  });

  it("the whole way in one story: A stages B, restarts, B is healthy; C is published, fails, A… B stays and C is bad", async () => {
    // Run 1 — build A.
    const run1 = world({ app: A });
    run1.env.published = manifest(B);
    await run1.updater.check();
    expect(await run1.updater.apply("user")).toBe(true);
    // Run 2 — build B, same state file.
    const run2 = world({ app: B, state: run1.state.get() });
    run2.env.helperResult = "swapped";
    expect(await run2.updater.startup()).toBe("continue");
    await run2.updater.rendererReady();
    run2.env.published = manifest(C);
    await run2.updater.check();
    expect(run2.updater.status().phase).toBe("ready");
    expect(await run2.updater.apply("user")).toBe(true);
    // Run 3 — build C never came up; the helper put B back and started it.
    const run3 = world({ app: B, state: run2.state.get() });
    run3.env.helperResult = "rolledBack";
    run3.env.published = manifest(C);
    expect(await run3.updater.startup()).toBe("continue");
    await run3.updater.check();
    expect(run3.updater.status()).toMatchObject({ phase: "blocked", blocked: "bad-build", last: { outcome: "rolledBack", buildId: C } });
    expect(run3.swaps).toEqual([]);
    expect(run3.phases).toEqual(["checking", "blocked"]);
  });
});

describe("state file and config", () => {
  it("the state survives a restart; a missing or broken file starts fresh with automatic updates on", () => {
    const dir = mkdtempSync(join(tmpdir(), "kokpit-update-state-"));
    try {
      const file = join(dir, "update", "update-state.json");
      const first = createStateStore(file);
      expect(first.get().auto).toBe(true);
      first.update((d) => {
        d.auto = false;
        d.badBuilds.push({ buildId: B, reason: "x", at: "t" });
        d.floorStamp = "20261118120000";
      });
      const again = createStateStore(file);
      expect(again.get()).toEqual(first.get());
      expect(again.get().floorStamp).toBe("20261118120000");
      expect(again.get().clientId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      writeFileSync(file, "{ broken");
      const fresh = createStateStore(file);
      expect(fresh.get()).toMatchObject({ auto: true, badBuilds: [] });
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the overrides file changes single values; a broken or invalid one is ignored with a reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "kokpit-update-config-"));
    try {
      const file = join(dir, "update-config.json");
      expect(loadUpdateConfig(file).config).toEqual(DEFAULT_UPDATE_CONFIG);
      writeFileSync(file, JSON.stringify({ idleApplyMs: 1234, tools: { open: "/opt/fake-open" } }));
      const loaded = loadUpdateConfig(file).config;
      expect(loaded.idleApplyMs).toBe(1234);
      expect(loaded.tools).toEqual({ ...DEFAULT_UPDATE_CONFIG.tools, open: "/opt/fake-open" });
      expect(loaded.healthTimeoutMs).toBe(DEFAULT_UPDATE_CONFIG.healthTimeoutMs);
      writeFileSync(file, JSON.stringify({ idleApplyMs: -5 }));
      expect(loadUpdateConfig(file)).toMatchObject({ config: DEFAULT_UPDATE_CONFIG, problem: expect.any(String) });
      writeFileSync(file, JSON.stringify({ unknownKey: 1 }));
      expect(loadUpdateConfig(file).problem).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
