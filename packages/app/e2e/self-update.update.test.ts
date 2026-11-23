// Kendini güncelleme — the real thing, in temp folders only: two packaged builds (A, B) made by `scripts/dist.ts`,
// A installed into a temp "Applications" folder with a temp userData, a temp engine that publishes B (packed into
// Kokpit's update format by the publish script). A downloads the blob, writes B from it with its own unpacker,
// verifies it (codesign included), swaps on the next launch and comes back as B — launched from the rebuilt bundle —
// with its state intact. Then a deliberately broken build C is published: B installs it, C never reports healthy,
// the helper puts B back and B marks C bad.
//
// Run with `pnpm --filter @kokpit/app test:update` (not part of test:e2e / test:dist: it builds the app twice,
// about three minutes each). `KOKPIT_UPDATE_E2E_BUILDS=<dir>` reuses (or fills) `<dir>/a` and `<dir>/b`.
//
// Never touched: /Applications/Kokpit.app, the real userData, the live engine, the real Keychain (the app runs with
// Chromium's `--use-mock-keychain`, so `safeStorage` uses no Keychain item — see docs/kabul-testleri.md §21), the
// real publisher key (~/.config/kokpit/app-signing): a temp one is made next to the builds and embedded in them.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_DIR, electronEnv, ENGINE_DIR, engineRequest, SCREENSHOT_DIR, sleep, startEngine, stopEngine, type EngineHandle } from "./harness.ts";
import { ensureSigningKey } from "@kokpit/shared/update-signing";

const KEY = randomBytes(32).toString("base64url");
const MOCK_KEYCHAIN = "--use-mock-keychain";
const BUNDLE = "Kokpit.app";
const EXE = join("Contents", "MacOS", "Kokpit");
const STAGING = ".Kokpit-update";
/** This profile's staged builds and downloads (one profile in this test: the only folder under `profiles/`). */
const profileDir = (): string => {
  const profiles = join(appsDir, STAGING, "profiles");
  const [only] = readdirSync(profiles);
  return join(profiles, only!);
};
const BUILD_TIMEOUT_MS = 15 * 60_000;
const STEP_TIMEOUT_MS = 5 * 60_000;
/** One wait inside a step; shorter than the step, so a failure says what it was waiting for. */
const WAIT_TIMEOUT_MS = 2 * 60_000;
const UI_TIMEOUT_MS = 30_000;
/** How long the helper waits for the new build's health signal in this test (default: 90 s). */
const HEALTH_TIMEOUT_MS = 20_000;
const CHECK_INTERVAL_MS = 3000;
/** The updater's waits, shortened through the per-machine overrides file. Idle auto-apply is far away on purpose:
 * the test restarts the app itself ("on next launch"), so whether the test window has focus does not matter. */
const OVERRIDES = {
  startupCheckDelayMs: 500,
  checkIntervalMs: CHECK_INTERVAL_MS,
  idlePollMs: 1000,
  idleApplyMs: 24 * 60 * 60_000,
  healthTimeoutMs: HEALTH_TIMEOUT_MS,
  exitWaitMs: 20_000,
  relaunchEnv: ["KOKPIT_USER_DATA_DIR", "KOKPIT_LOCAL_ENGINE_DETECT"],
};

let root: string;
let buildsDir: string;
let ownBuilds = false;
let appsDir: string;
let target: string;
let userData: string;
let engineConfig: string;
let engine: EngineHandle | undefined;
let env: Record<string, string>;
const children: ChildProcess[] = [];
const ids = { a: "", b: "", c: "" };
let appLog = "";

const plist = (bundle: string, key: string): string => execFileSync("/usr/bin/plutil", ["-extract", key, "raw", join(bundle, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
const buildOf = (bundle: string): string => plist(bundle, "KokpitBuildId");
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const stateFile = (): string => join(userData, "update", "update-state.json");

interface State {
  auto: boolean;
  clientId: string;
  badBuilds: { buildId: string }[];
  pending?: { phase: string; buildId: string; stagedBundle: string; fromBuildId: string };
  last?: { outcome: string; buildId: string; reported: boolean };
}
function readState(): State | undefined {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as State;
  } catch {
    return undefined;
  }
}

/** Pids of main processes running from the temp install (never anything outside `root`). */
function targetPids(): number[] {
  const exe = join(target, EXE);
  return execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && m[2] === exe)
    .map((m) => Number(m[1]));
}

function killUnderRoot(): void {
  const out = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2]!.startsWith(`${root}/`)) {
      try {
        process.kill(Number(m[1]), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

async function waitFor<T>(what: string, read: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = WAIT_TIMEOUT_MS): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await read();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}\nstate: ${JSON.stringify(readState())}\nhelper: ${helperLog()}\napp log:\n${appLog.slice(-4000)}`);
    await sleep(250);
  }
}
const helperLog = (): string => {
  try {
    return readFileSync(join(userData, "update", "helper.log"), "utf8");
  } catch {
    return "(none)";
  }
};

/** Starts the installed app like a user would start its binary; its output is kept for failure messages. */
function startApp(): ChildProcess {
  const child = spawn(join(target, EXE), [MOCK_KEYCHAIN], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (d: Buffer) => (appLog += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (appLog += d.toString()));
  children.push(child);
  return child;
}
const exited = (child: ChildProcess): Promise<void> => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve())));

async function quitTargets(): Promise<void> {
  for (const pid of targetPids()) process.kill(pid, "SIGTERM");
  await waitFor("the app to quit", () => targetPids().length === 0, 30_000);
}

/** The temp publisher key folder (kept with the builds: a reused build embeds its public key). */
const signingDir = (): string => join(buildsDir, "signing");

function dist(outDir: string): void {
  const r = spawnSync(process.execPath, ["scripts/dist.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, KOKPIT_DIST_DIR: outDir, KOKPIT_APP_SIGNING_DIR: signingDir() },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`dist failed (${r.status}):\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`);
}
const builtBundle = (which: "a" | "b"): string => join(buildsDir, which, "mac-arm64", BUNDLE);
/** Publishes a built bundle folder the way a deploy does. */
function publish(bundle: string): string {
  return execFileSync(process.execPath, [join(ENGINE_DIR, "scripts", "publish-app.ts"), "--config", engineConfig, "--app", bundle], { encoding: "utf8" });
}
type Clients = { current: { buildId: string } | null; clients: { clientId: string; buildId: string; outcome?: string; outcomeBuildId?: string }[] };
const clients = async (): Promise<Clients> => (await engineRequest(engine!.url, KEY, "app.update.clients", {})) as Clients;

/**
 * Build C: B's bundle with its code replaced by a main process that never opens a window (so it never reports
 * healthy), a build id of its own, signed again ad-hoc. It passes every check — it is "only" broken.
 */
function makeBrokenBuild(): string {
  const work = join(root, "broken");
  const bundle = join(work, BUNDLE);
  mkdirSync(work, { recursive: true });
  execFileSync("/usr/bin/ditto", [builtBundle("b"), bundle]);
  const resources = join(bundle, "Contents", "Resources");
  rmSync(join(resources, "app.asar"));
  mkdirSync(join(resources, "app"));
  writeFileSync(join(resources, "app", "package.json"), JSON.stringify({ name: "kokpit-broken", version: plist(bundle, "CFBundleShortVersionString"), main: "main.js" }));
  writeFileSync(join(resources, "app", "main.js"), "setInterval(() => {}, 1000);\n");
  ids.c = ids.b.replace(/\+(\d{14})\./, (_m, stamp: string) => `+${String(BigInt(stamp) + 1n)}.`) + ".broken";
  execFileSync("/usr/bin/plutil", ["-replace", "KokpitBuildId", "-string", ids.c, join(bundle, "Contents", "Info.plist")]);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "pipe" });
  return bundle;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-update-e2e-")));
  const reuse = process.env.KOKPIT_UPDATE_E2E_BUILDS;
  ownBuilds = reuse === undefined || reuse === "";
  buildsDir = ownBuilds ? join(root, "builds") : reuse!;
  // The deploy's first step (publish-app.ts keygen), in a temp folder: the builds embed this key.
  mkdirSync(buildsDir, { recursive: true });
  ensureSigningKey(signingDir());
  for (const which of ["a", "b"] as const) {
    if (!existsSync(builtBundle(which))) dist(join(buildsDir, which));
  }
  ids.a = buildOf(builtBundle("a"));
  ids.b = buildOf(builtBundle("b"));

  appsDir = join(root, "Applications");
  target = join(appsDir, BUNDLE);
  userData = join(root, "userData");
  mkdirSync(appsDir, { recursive: true });
  mkdirSync(join(userData, "update"), { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(join(userData, "update", "update-config.json"), JSON.stringify(OVERRIDES));
  execFileSync("/usr/bin/ditto", [builtBundle("a"), target]);

  engineConfig = join(root, "engine.json");
  writeFileSync(
    engineConfig,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      browser: { testMode: true, headless: true },
      appUpdates: { signingKeyDir: signingDir() },
    }),
  );
  engine = await startEngine(engineConfig, KEY, { HOME: join(root, "home") });
  env = electronEnv({ KOKPIT_USER_DATA_DIR: userData });
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  for (const c of children) c.kill("SIGKILL");
  if (root) killUnderRoot();
  await stopEngine(engine);
  if (root) {
    await sleep(500);
    killUnderRoot();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("self-update, end to end", { timeout: STEP_TIMEOUT_MS }, () => {
  /** What must survive the swap: the saved connection (key encrypted), the layout, the user's sites (if any were saved). */
  const STATE_FILES = ["engine-settings.json", "ui-state.json", "web-sites.json"];
  const snapshot: Record<string, string> = {};
  let uiSelection: unknown;

  it("the two builds are different builds: own build ids, and ad-hoc signatures with per-build identities", () => {
    expect(ids.a).toMatch(/^\d+\.\d+\.\d+\+\d{14}\.[0-9a-f]+/);
    expect(ids.b).not.toBe(ids.a);
    const requirement = (bundle: string): string => {
      const r = spawnSync("/usr/bin/codesign", ["-d", "-r-", bundle], { encoding: "utf8" });
      return /designated => (.+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? "";
    };
    // Measured, and the reason the Keychain question exists: an ad-hoc build's identity is its own hash.
    expect(requirement(builtBundle("a"))).toMatch(/^cdhash H"[0-9a-f]{40}"$/);
    expect(requirement(builtBundle("b"))).toMatch(/^cdhash H"[0-9a-f]{40}"$/);
    expect(requirement(builtBundle("b"))).not.toBe(requirement(builtBundle("a")));
  });

  it("build A: connect, and Ayarlar › Bağlantı shows the app's and the engine's build id", async () => {
    let app: ElectronApplication | undefined;
    try {
      app = await _electron.launch({ executablePath: join(target, EXE), args: [MOCK_KEYCHAIN], cwd: APP_DIR, env });
      const page: Page = await app.firstWindow();
      expect(await app.evaluate(({ app: a }) => a.getPath("userData"))).toBe(userData);
      expect(await app.evaluate(({ app: a }) => a.getPath("exe"))).toBe(join(target, EXE));
      await page.getByLabel("Motor adresi").fill(engine!.url);
      await page.getByLabel("Anahtar").fill(KEY);
      await page.getByRole("button", { name: "Bağlan" }).click();
      const rail = page.getByRole("navigation", { name: "Kokpit" });
      await expect.poll(() => rail.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(true);
      // Nothing is published yet: no strip, no restart.
      expect(await page.locator(".kp-banner--update").count()).toBe(0);

      await rail.getByRole("button", { name: "Ayarlar" }).click();
      await page.getByRole("tab", { name: "Bağlantı" }).click();
      const about = page.getByRole("region", { name: "Sürüm ve güncelleme" });
      await expect.poll(() => about.textContent(), { timeout: UI_TIMEOUT_MS }).toContain(ids.a);
      await expect.poll(async () => (await about.textContent()) ?? "", { timeout: UI_TIMEOUT_MS }).toMatch(/Motor\d+\.\d+\.\d+\+\d{14}\./);
      await expect.poll(async () => (await about.textContent()) ?? "", { timeout: UI_TIMEOUT_MS }).toContain("uyumlu");
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(SCREENSHOT_DIR, "self-update-01-about.png") });
      await page.getByRole("button", { name: "Geri" }).click();
      // Let the UI state reach the disk before the app closes.
      await expect.poll(() => existsSync(join(userData, "ui-state.json")), { timeout: UI_TIMEOUT_MS }).toBe(true);
      await sleep(1500);
    } finally {
      await app?.close();
    }
    for (const name of STATE_FILES) if (existsSync(join(userData, name))) snapshot[name] = sha(join(userData, name));
    expect(Object.keys(snapshot)).toContain("engine-settings.json");
    expect(Object.keys(snapshot)).toContain("ui-state.json");
    uiSelection = (JSON.parse(readFileSync(join(userData, "ui-state.json"), "utf8")) as { layouts: unknown }).layouts;
    expect(readFileSync(join(userData, "engine-settings.json"), "utf8")).not.toContain(KEY);
    expect(readState()).toMatchObject({ auto: true, badBuilds: [] });
  });

  it("B is published: A fetches, verifies and stages it in the background — and does not restart by itself", async () => {
    expect(publish(builtBundle("b"))).toContain(`published ${ids.b}`);
    const a = startApp();
    const pending = await waitFor("build B to be staged", () => {
      const p = readState()?.pending;
      return p?.phase === "ready" && p.buildId === ids.b ? p : undefined;
    });
    expect(pending.fromBuildId).toBe(ids.a);
    expect(pending.stagedBundle).toBe(join(profileDir(), "builds", ids.b, BUNDLE));
    expect(buildOf(pending.stagedBundle)).toBe(ids.b);
    // Staged next to the app (same volume), written by the app's own unpacker: the signature made at build time
    // holds for the rebuilt bundle, it is byte for byte the built one, and the download is gone.
    expect(spawnSync("/usr/bin/diff", ["-r", builtBundle("b"), pending.stagedBundle]).status).toBe(0);
    expect(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", pending.stagedBundle]).status).toBe(0);
    expect(readdirSync(join(profileDir(), "downloads"))).toEqual([]);
    // The staging folder is ours alone.
    expect(statSync(join(appsDir, STAGING)).mode & 0o777).toBe(0o700);
    // The installed app is untouched and still running as A: ready is not a restart.
    await sleep(2 * CHECK_INTERVAL_MS);
    expect(buildOf(target)).toBe(ids.a);
    expect(a.exitCode).toBeNull();
    expect(targetPids()).toEqual([a.pid]);
    expect((await clients()).clients).toEqual([expect.objectContaining({ buildId: ids.a })]);
  });

  it("on the next launch A swaps itself for B; B starts, reports healthy and still has the connection, layout and sites", async () => {
    await quitTargets();
    const relaunch = startApp();
    // A's process ends by itself (no window opened): the helper takes over once it is gone.
    await exited(relaunch);
    const state = await waitFor("build B to report healthy", () => {
      const s = readState();
      return s?.last?.outcome === "updated" && s.last.buildId === ids.b && s.pending === undefined ? s : undefined;
    });
    expect(buildOf(target)).toBe(ids.b);
    expect(buildOf(join(appsDir, STAGING, "backup", BUNDLE))).toBe(ids.a);
    expect(readFileSync(join(userData, "update", `result-${ids.b}`), "utf8").trim()).toMatch(/^(swapped|healthy)$/);
    // B runs from the same path, exactly once.
    await waitFor("one running app", () => targetPids().length === 1, 30_000);
    // B talks to the engine with the SAVED key (nobody entered it again): the engine sees this install as build B.
    const seen = await waitFor("the engine to see build B", async () => {
      const c = (await clients()).clients.find((x) => x.clientId === state.clientId);
      return c?.buildId === ids.b && c.outcome === "updated" ? c : undefined;
    });
    expect(seen.outcomeBuildId).toBe(ids.b);
    // State survived the swap.
    expect(sha(join(userData, "engine-settings.json"))).toBe(snapshot["engine-settings.json"]);
    for (const name of Object.keys(snapshot).filter((k) => k !== "ui-state.json")) expect(sha(join(userData, name)), name).toBe(snapshot[name]);
    expect((JSON.parse(readFileSync(join(userData, "ui-state.json"), "utf8")) as { layouts: unknown }).layouts).toEqual(uiSelection);
    // The download and the unpacked build are cleaned up; only the backup stays.
    expect(readdirSync(join(appsDir, STAGING)).sort()).toEqual(["backup", "profiles"]);
    expect(readdirSync(join(profileDir(), "builds"))).toEqual([]);
    expect(readdirSync(join(profileDir(), "downloads"))).toEqual([]);
    expect(await waitFor("helper to finish", () => readFileSync(join(userData, "update", `result-${ids.b}`), "utf8").trim() === "healthy", 30_000)).toBe(true);
  });

  it("a broken build C is published: B installs it, C never comes up, B is put back, C is marked bad and not tried again", async () => {
    expect(publish(makeBrokenBuild())).toContain(`published ${ids.c}`);
    await waitFor("build C to be staged", () => {
      const p = readState()?.pending;
      return p?.phase === "ready" && p.buildId === ids.c;
    });
    expect(buildOf(target)).toBe(ids.b);

    await quitTargets();
    const started = Date.now();
    await exited(startApp());
    // C is swapped in and launched…
    await waitFor("build C to be swapped in", () => existsSync(join(userData, "update", `result-${ids.c}`)) && buildOf(target) !== ids.b, 60_000).catch(() => undefined);
    // …and after the health timeout the helper restores B and starts it.
    const state = await waitFor("the rollback to be recorded", () => {
      const s = readState();
      return s?.last?.outcome === "rolledBack" && s.last.buildId === ids.c ? s : undefined;
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(HEALTH_TIMEOUT_MS);
    expect(readFileSync(join(userData, "update", `result-${ids.c}`), "utf8").trim()).toBe("rolledBack");
    expect(helperLog()).toContain("rolling back");
    expect(buildOf(target)).toBe(ids.b);
    expect(spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", target]).status).toBe(0);
    expect(state.badBuilds.map((b) => b.buildId)).toEqual([ids.c]);
    expect(state.pending).toBeUndefined();
    await waitFor("one running app", () => targetPids().length === 1, 30_000);
    const seen = await waitFor("the engine to hear of the rollback", async () => {
      const c = (await clients()).clients.find((x) => x.clientId === state.clientId);
      return c?.outcome === "rolledBack" ? c : undefined;
    });
    expect(seen).toMatchObject({ buildId: ids.b, outcomeBuildId: ids.c });

    // No loop: C stays published, several checks pass, and B neither downloads nor installs it again.
    const pidBefore = targetPids();
    await sleep(4 * CHECK_INTERVAL_MS);
    expect(targetPids()).toEqual(pidBefore);
    expect(readState()).toMatchObject({ badBuilds: [{ buildId: ids.c }] });
    expect(readState()?.pending).toBeUndefined();
    expect(existsSync(join(profileDir(), "builds", ids.c))).toBe(false);
    expect(readdirSync(join(profileDir(), "downloads"))).toEqual([]);
    expect(buildOf(target)).toBe(ids.b);
    // The saved connection still works after all of it.
    expect(sha(join(userData, "engine-settings.json"))).toBe(snapshot["engine-settings.json"]);
  });
});
