// @vitest-environment node
// Kendini güncelleme — where the app is, whether it can be replaced there, and the swap helper run for real
// (real /bin/sh, real processes, folders standing in for bundles) in a temp folder.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_CONFIG, type UpdateConfig } from "./config.ts";
import {
  applyLockHolder,
  cleanOtherDownloads,
  cleanStaging,
  ensureStagingFolders,
  profileKeyOf,
  releaseApplyLock,
  HELPER_SCRIPT,
  helperArgs,
  inspectInstall,
  locateBundle,
  otherInstances,
  readHelperResult,
  takeApplyLock,
  writeHealthFile,
  type ApplyPlan,
  type InstallFs,
} from "./install.ts";
import type { RunTool } from "./verify.ts";

const cfg = DEFAULT_UPDATE_CONFIG;
const root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-update-install-")));
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const fresh = (): string => {
  const dir = join(root, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const PROFILE = "0123456789abcdef";

describe("locateBundle", () => {
  it("finds the bundle, its folder, the staging folder next to it, and this profile's part of it", () => {
    const S = `/Applications/${cfg.stagingDirName}`;
    expect(locateBundle("/Applications/Kokpit.app/Contents/MacOS/Kokpit", cfg, PROFILE)).toEqual({
      bundlePath: "/Applications/Kokpit.app",
      bundleName: "Kokpit.app",
      parentDir: "/Applications",
      stagingDir: S,
      backupBundle: `${S}/${cfg.backupDirName}/Kokpit.app`,
      profileDir: `${S}/${cfg.profilesDirName}/${PROFILE}`,
      buildsDir: `${S}/${cfg.profilesDirName}/${PROFILE}/${cfg.buildsDirName}`,
      downloadsDir: `${S}/${cfg.profilesDirName}/${PROFILE}/${cfg.downloadsDirName}`,
    });
    expect(profileKeyOf("/Users/x/Library/Application Support/@kokpit/app")).toMatch(/^[0-9a-f]{16}$/);
    expect(profileKeyOf("/a")).not.toBe(profileKeyOf("/b"));
    expect(locateBundle("/Users/x/Applications/Kokpit.app/Contents/MacOS/Kokpit", cfg, PROFILE)?.parentDir).toBe("/Users/x/Applications");
  });

  it("an executable outside a bundle (run from source) has none", () => {
    expect(locateBundle("/repo/node_modules/electron/dist/electron", cfg, PROFILE)).toBeUndefined();
    expect(locateBundle("/x/Kokpit.app/Contents/Resources/Kokpit", cfg, PROFILE)).toBeUndefined();
  });
});

describe("inspectInstall", () => {
  const loc = locateBundle("/Applications/Kokpit.app/Contents/MacOS/Kokpit", cfg, PROFILE)!;
  const MB = 1024 * 1024;
  const fs = (over: Partial<InstallFs> = {}): InstallFs => ({ access: async () => {}, statfs: async () => ({ bavail: 100_000, bsize: 4096 }), ...over });
  const errno = (code: string) => async () => {
    throw Object.assign(new Error(code), { code });
  };

  it("a writable folder with room is fine", async () => {
    expect(await inspectInstall(loc, 50 * MB, cfg, fs())).toEqual({ ok: true });
  });

  it("an app run from Gatekeeper's translocated copy cannot update itself — and says what to do", async () => {
    const moved = locateBundle("/private/var/folders/ab/T/AppTranslocation/1234-5678/d/Kokpit.app/Contents/MacOS/Kokpit", cfg, PROFILE)!;
    const r = await inspectInstall(moved, MB, cfg, fs());
    expect(r).toMatchObject({ ok: false, reason: "translocated" });
    expect((r as { message: string }).message).toContain("Uygulamalar klasörüne taşı");
  });

  it("a read-only place (a disk image) and a folder without write permission are told apart", async () => {
    expect(await inspectInstall(loc, MB, cfg, fs({ access: errno("EROFS") }))).toMatchObject({ ok: false, reason: "read-only" });
    expect(await inspectInstall(loc, MB, cfg, fs({ access: errno("EACCES") }))).toMatchObject({ ok: false, reason: "no-write" });
  });

  it("too little free space: archive × freeSpaceFactor is needed", async () => {
    const free = 100_000 * 4096;
    const justFits = Math.floor(free / cfg.freeSpaceFactor);
    expect((await inspectInstall(loc, justFits, cfg, fs())).ok).toBe(true);
    const r = await inspectInstall(loc, justFits + MB, cfg, fs());
    expect(r).toMatchObject({ ok: false, reason: "disk-space" });
    expect((r as { message: string }).message).toMatch(/\d+ MB gerekli, \d+ MB boş/);
  });

  it("unknown free space does not block", async () => {
    expect((await inspectInstall(loc, MB, cfg, fs({ statfs: errno("ENOSYS") as never }))).ok).toBe(true);
  });
});

describe("otherInstances", () => {
  const exe = "/Applications/Kokpit.app/Contents/MacOS/Kokpit";
  const ps = (lines: string[]): RunTool => async () => ({ status: 0, stdout: lines.join("\n"), stderr: "" });

  it("counts other main processes of the same executable — not itself, not helpers, not other apps", async () => {
    const run = ps([
      `  100 ${exe}`,
      `  200 ${exe}`,
      `  201 /Applications/Kokpit.app/Contents/Frameworks/Kokpit Helper.app/Contents/MacOS/Kokpit Helper`,
      `  300 /Users/x/Applications/Kokpit.app/Contents/MacOS/Kokpit`,
      `  400 /sbin/launchd`,
    ]);
    expect(await otherInstances(exe, 100, cfg, run)).toBe(1);
    expect(await otherInstances(exe, 999, cfg, run)).toBe(2);
  });

  it("with the real ps: this test process is the only one running its executable path, by pid", async () => {
    const real: RunTool = async (cmd, args) => ({ status: 0, stdout: execFileSync(cmd, args, { encoding: "utf8" }), stderr: "" });
    const out = (await real(cfg.tools.ps, ["-axo", "pid=,comm="])).stdout;
    expect(out).toMatch(new RegExp(`^\\s*${process.pid}\\s+/`, "m"));
  });
});

describe("apply lock", () => {
  /** "Is this pid a running Kokpit?" — here: the pids the test says are. */
  const appPids = (...pids: number[]) => async (pid: number) => pids.includes(pid);

  it("is taken exclusively; one's own lock is no obstacle", async () => {
    const dir = fresh();
    expect(await applyLockHolder(dir, appPids())).toBeUndefined();
    expect(await takeApplyLock(dir, appPids())).toBe(true);
    expect(readFileSync(join(dir, "apply.lock"), "utf8").trim()).toBe(String(process.pid));
    expect(await applyLockHolder(dir, appPids(process.pid))).toBeUndefined();
  });

  it("a lock held by another running Kokpit blocks; the lock stays theirs", async () => {
    const dir = fresh();
    const other = spawn("/bin/sleep", ["30"]);
    children.push(other);
    writeFileSync(join(dir, "apply.lock"), `${other.pid}\n`);
    expect(await applyLockHolder(dir, appPids(other.pid!))).toBe(other.pid);
    expect(await takeApplyLock(dir, appPids(other.pid!))).toBe(false);
    expect(readFileSync(join(dir, "apply.lock"), "utf8").trim()).toBe(String(other.pid));
    await releaseApplyLock(dir, appPids(other.pid!));
    expect(existsSync(join(dir, "apply.lock"))).toBe(true);
  });

  it("a lock whose pid is alive but is NOT Kokpit (a reused pid) is stale: taken over", async () => {
    const dir = fresh();
    const unrelated = spawn("/bin/sleep", ["30"]);
    children.push(unrelated);
    writeFileSync(join(dir, "apply.lock"), `${unrelated.pid}\n`);
    expect(await applyLockHolder(dir, appPids())).toBeUndefined();
    expect(await takeApplyLock(dir, appPids())).toBe(true);
    expect(readFileSync(join(dir, "apply.lock"), "utf8").trim()).toBe(String(process.pid));
  });

  it("a lock of a process that is gone, or garbage, is stale; release removes it", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "apply.lock"), "999999\n");
    expect(await applyLockHolder(dir, appPids())).toBeUndefined();
    writeFileSync(join(dir, "apply.lock"), "not a pid");
    expect(await takeApplyLock(dir, appPids())).toBe(true);
    await releaseApplyLock(dir, appPids());
    expect(existsSync(join(dir, "apply.lock"))).toBe(false);
  });
});

describe("staging folders", () => {
  it("are created owner-only, and every one is checked", async () => {
    const dir = fresh();
    const loc = locateBundle(join(dir, "Kokpit.app", "Contents", "MacOS", "Kokpit"), cfg, PROFILE)!;
    expect(await ensureStagingFolders(loc)).toEqual({ ok: true });
    for (const d of [loc.stagingDir, dirname(loc.backupBundle), loc.profileDir, loc.buildsDir, loc.downloadsDir]) {
      expect(lstatSync(d).mode & 0o777, d).toBe(0o700);
    }
    expect(await ensureStagingFolders(loc)).toEqual({ ok: true });
  });

  it("a staging folder that is a link (to somewhere someone else chose) is refused, nothing is written there", async () => {
    const dir = fresh();
    const elsewhere = fresh();
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, join(dir, cfg.stagingDirName));
    const loc = locateBundle(join(dir, "Kokpit.app", "Contents", "MacOS", "Kokpit"), cfg, PROFILE)!;
    const r = await ensureStagingFolders(loc);
    expect(r).toMatchObject({ ok: false, reason: "unsafe-staging" });
    expect((r as { message: string }).message).toContain("bağlantı");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("a staging folder others may enter, or that is not a folder, is refused", async () => {
    const open = fresh();
    mkdirSync(join(open, cfg.stagingDirName), { mode: 0o755 });
    chmodSync(join(open, cfg.stagingDirName), 0o755);
    const r = await ensureStagingFolders(locateBundle(join(open, "Kokpit.app", "Contents", "MacOS", "Kokpit"), cfg, PROFILE)!);
    expect(r).toMatchObject({ ok: false, reason: "unsafe-staging" });
    expect((r as { message: string }).message).toContain("755");
    const file = fresh();
    writeFileSync(join(file, cfg.stagingDirName), "x");
    expect(await ensureStagingFolders(locateBundle(join(file, "Kokpit.app", "Contents", "MacOS", "Kokpit"), cfg, PROFILE)!)).toMatchObject({ ok: false });
  });

  it("someone else's folder is refused (checked against the owner)", async () => {
    const dir = fresh();
    const loc = locateBundle(join(dir, "Kokpit.app", "Contents", "MacOS", "Kokpit"), cfg, PROFILE)!;
    const r = await ensureStagingFolders(loc, (process.getuid?.() ?? 0) + 1);
    expect(r).toMatchObject({ ok: false, reason: "unsafe-staging" });
    expect((r as { message: string }).message).toContain("başka bir kullanıcı");
  });
});

describe("cleanStaging", () => {
  it("removes this profile's downloads and unpacked builds; keeps the backup, the staged build and other profiles' builds", async () => {
    const dir = fresh();
    const loc = locateBundle(join(dir, "Kokpit.app", "Contents", "MacOS", "Kokpit"), cfg, PROFILE)!;
    const other = locateBundle(join(dir, "Kokpit.app", "Contents", "MacOS", "Kokpit"), cfg, "fedcba9876543210")!;
    const put = (p: string) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "x");
    };
    for (const p of [join(loc.downloadsDir, "old.bin.part"), join(loc.buildsDir, "old", "Kokpit.app", "x"), join(loc.buildsDir, "new", "Kokpit.app", "x"), join(loc.backupBundle, "x"), join(other.buildsDir, "theirs", "Kokpit.app", "x")]) put(p);
    await cleanStaging(loc, join(loc.buildsDir, "new", "Kokpit.app"));
    expect(existsSync(join(loc.downloadsDir, "old.bin.part"))).toBe(false);
    expect(existsSync(join(loc.buildsDir, "old"))).toBe(false);
    expect(existsSync(join(loc.buildsDir, "new", "Kokpit.app", "x"))).toBe(true);
    expect(existsSync(loc.backupBundle)).toBe(true);
    expect(existsSync(join(other.buildsDir, "theirs", "Kokpit.app", "x"))).toBe(true);
  });

  it("downloads of other builds are dropped before a new one starts", async () => {
    const dir = fresh();
    const loc = locateBundle(join(dir, "Kokpit.app", "Contents", "MacOS", "Kokpit"), cfg, PROFILE)!;
    mkdirSync(loc.downloadsDir, { recursive: true });
    writeFileSync(join(loc.downloadsDir, "a.bin.part"), "x");
    writeFileSync(join(loc.downloadsDir, "b.bin.part"), "x");
    await cleanOtherDownloads(loc, join(loc.downloadsDir, "b.bin.part"));
    expect(readdirSync(loc.downloadsDir)).toEqual(["b.bin.part"]);
  });
});

// ---------- the helper, for real ----------

interface Scene {
  dir: string;
  target: string;
  staged: string;
  backup: string;
  state: string;
  launches: string;
  script: string;
}

const BUILD = "0.1.0+20261118110000.new0000";
const MARK = "marker.txt";

/** Folders standing in for the installed app (OLD) and the staged build (NEW), and a launcher that records calls. */
function scene(): Scene {
  const dir = fresh();
  const target = join(dir, "Apps", "Kokpit.app");
  const staged = join(dir, "Apps", cfg.stagingDirName, BUILD, "Kokpit.app");
  const backup = join(dir, "Apps", cfg.stagingDirName, cfg.backupDirName, "Kokpit.app");
  const state = join(dir, "state");
  for (const [bundle, mark] of [
    [target, "OLD"],
    [staged, "NEW"],
  ] as const) {
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(bundle, MARK), mark);
  }
  mkdirSync(state, { recursive: true });
  const script = join(state, "apply.sh");
  writeFileSync(script, HELPER_SCRIPT, { mode: 0o700 });
  return { dir, target, staged, backup, state, launches: join(dir, "launches.log"), script };
}

/**
 * A launcher in place of `open`: records which build it was asked to start (by the marker in the target) and, when
 * told to, runs a real process FROM INSIDE the target bundle, so the helper has something to stop. The executable
 * there is a link to /bin/sleep (`ps` shows the path it was started by): a COPY of an Apple system binary is killed
 * by macOS at once and then lingers unkillable in `ps`, which would say nothing about the helper.
 */
function launcher(s: Scene, behaviour: "healthy" | "silent" | "hang"): string {
  const path = join(s.dir, "launcher.sh");
  const health = `printf up > "${s.state}/healthy-${BUILD}"`;
  writeFileSync(
    path,
    `#!/bin/sh
MARK=$(cat "${s.target}/${MARK}")
printf '%s|%s\\n' "$MARK" "$*" >> "${s.launches}"
[ "$MARK" = "NEW" ] || exit 0
${behaviour === "healthy" ? health : ""}
${behaviour === "hang" ? `/bin/ln -s /bin/sleep "${s.target}/Contents/MacOS/Kokpit" && "${s.target}/Contents/MacOS/Kokpit" 300 &` : ""}
exit 0
`,
    { mode: 0o755 },
  );
  return path;
}

function runHelper(s: Scene, oldPid: number, launch: string[], waits: { exit?: number; health?: number } = {}): Promise<number | null> {
  const child = spawn(cfg.tools.sh, [s.script, "apply", String(oldPid), s.target, s.staged, s.backup, s.state, BUILD, String(waits.exit ?? 5), String(waits.health ?? 3), "--", ...launch], {
    env: { PATH: cfg.helperPath, KOKPIT_UPDATE_PS: cfg.tools.ps },
    stdio: "ignore",
  });
  children.push(child);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

const mark = (bundle: string): string | undefined => (existsSync(join(bundle, MARK)) ? readFileSync(join(bundle, MARK), "utf8") : undefined);
const launchesOf = (s: Scene): string[] => (existsSync(s.launches) ? readFileSync(s.launches, "utf8").trim().split("\n") : []);
/** A pid that is certainly gone. */
function deadPid(): number {
  const pid = Number(execFileSync(cfg.tools.sh, ["-c", "echo $$"], { encoding: "utf8" }).trim());
  return pid;
}

describe("swap helper (real sh, real processes)", { timeout: 30_000 }, () => {
  it("waits for the old app to exit, swaps, launches, and stops watching once the new build reports healthy", async () => {
    const s = scene();
    const old = spawn("/bin/sleep", ["300"]);
    children.push(old);
    const done = runHelper(s, old.pid!, [launcher(s, "healthy"), "--flag", "a b"]);
    // While the old app runs, nothing is touched.
    await new Promise((r) => setTimeout(r, 600));
    expect(mark(s.target)).toBe("OLD");
    expect(launchesOf(s)).toEqual([]);
    old.kill("SIGTERM");
    expect(await done).toBe(0);
    expect(mark(s.target)).toBe("NEW");
    expect(mark(s.backup)).toBe("OLD");
    expect(existsSync(s.staged)).toBe(false);
    // The launch command and its arguments arrive untouched (spaces included).
    expect(launchesOf(s)).toEqual(["NEW|--flag a b"]);
    expect(readHelperResult(s.state, BUILD)).toBe("healthy");
  });

  it("a new build that never reports healthy is stopped, the old build is put back and launched; the result says rolledBack", async () => {
    const s = scene();
    const code = await runHelper(s, deadPid(), [launcher(s, "hang")], { health: 2 });
    expect(code).toBe(2);
    expect(mark(s.target)).toBe("OLD");
    expect(existsSync(s.backup)).toBe(false);
    expect(existsSync(`${s.staged}.failed`)).toBe(false);
    expect(launchesOf(s)).toEqual(["NEW|", "OLD|"]);
    expect(readHelperResult(s.state, BUILD)).toBe("rolledBack");
    // The process that ran from inside the new bundle is gone.
    const ps = execFileSync(cfg.tools.ps, ["-axo", "pid=,comm="], { encoding: "utf8" });
    expect(ps).not.toContain(`${s.target}/Contents/MacOS/Kokpit`);
    expect(readFileSync(join(s.state, "helper.log"), "utf8")).toContain("rolling back");
  });

  it("a new build that exits at once (crash on start) is rolled back the same way", async () => {
    const s = scene();
    expect(await runHelper(s, deadPid(), [launcher(s, "silent")], { health: 1 })).toBe(2);
    expect(mark(s.target)).toBe("OLD");
    expect(readHelperResult(s.state, BUILD)).toBe("rolledBack");
  });

  it("an old app that does not exit: nothing is changed, nothing is launched", async () => {
    const s = scene();
    const old = spawn("/bin/sleep", ["300"]);
    children.push(old);
    expect(await runHelper(s, old.pid!, [launcher(s, "healthy")], { exit: 1 })).toBe(1);
    expect(mark(s.target)).toBe("OLD");
    expect(mark(s.staged)).toBe("NEW");
    expect(existsSync(s.backup)).toBe(false);
    expect(launchesOf(s)).toEqual([]);
    expect(readHelperResult(s.state, BUILD)).toBe("aborted");
  });

  it("the staged build vanished: the old app is launched again untouched", async () => {
    const s = scene();
    rmSync(s.staged, { recursive: true });
    expect(await runHelper(s, deadPid(), [launcher(s, "healthy")])).toBe(1);
    expect(mark(s.target)).toBe("OLD");
    expect(launchesOf(s)).toEqual(["OLD|"]);
    expect(readHelperResult(s.state, BUILD)).toBe("aborted");
  });

  it("the second rename fails (staged cannot be moved): the first is undone and the old app launched", async () => {
    const s = scene();
    // The staged bundle's parent is read-only: `mv staged target` cannot unlink it there.
    const parent = join(s.staged, "..");
    execFileSync("/bin/chmod", ["555", parent]);
    try {
      expect(await runHelper(s, deadPid(), [launcher(s, "healthy")])).toBe(1);
    } finally {
      execFileSync("/bin/chmod", ["755", parent]);
    }
    expect(mark(s.target)).toBe("OLD");
    expect(existsSync(s.backup)).toBe(false);
    expect(launchesOf(s)).toEqual(["OLD|"]);
    expect(readHelperResult(s.state, BUILD)).toBe("aborted");
  });

  it("the reviewer's case: a build staged AT the backup's place is refused — the app stays, nothing is moved", async () => {
    const s = scene();
    // Stage "the new build" exactly where the backup lives.
    rmSync(s.staged, { recursive: true });
    mkdirSync(join(s.backup, "Contents"), { recursive: true });
    writeFileSync(join(s.backup, MARK), "NEW");
    const t: Scene = { ...s, staged: s.backup };
    expect(await runHelper(t, deadPid(), [launcher(t, "healthy")])).toBe(4);
    expect(mark(s.target)).toBe("OLD");
    expect(mark(s.backup)).toBe("NEW");
    expect(launchesOf(s)).toEqual([]);
    expect(readHelperResult(s.state, BUILD)).toBe("aborted");
    expect(readFileSync(join(s.state, "helper.log"), "utf8")).toContain("overlap");
    // …and a build staged inside the target or the target inside the backup folder, likewise.
    for (const staged of [join(s.target, "Contents"), join(dirname(s.backup), "x.app")]) {
      expect(await runHelper({ ...s, staged }, deadPid(), [launcher(s, "healthy")])).toBe(4);
      expect(mark(s.target)).toBe("OLD");
    }
  });

  it("the old backup is kept until the new build is healthy, then dropped", async () => {
    const s = scene();
    mkdirSync(s.backup, { recursive: true });
    writeFileSync(join(s.backup, MARK), "ANCIENT");
    expect(await runHelper(s, deadPid(), [launcher(s, "healthy")])).toBe(0);
    expect(mark(s.backup)).toBe("OLD");
    expect(existsSync(`${s.backup}.previous`)).toBe(false);
  });

  it("a rollback restores the old backup too: the backup before the failed swap is not lost", async () => {
    const s = scene();
    mkdirSync(s.backup, { recursive: true });
    writeFileSync(join(s.backup, MARK), "ANCIENT");
    expect(await runHelper(s, deadPid(), [launcher(s, "silent")], { health: 1 })).toBe(2);
    expect(mark(s.target)).toBe("OLD");
    expect(mark(s.backup)).toBe("ANCIENT");
  });

  it("when the backup cannot be moved back, the failed build goes back: an app always remains at the target", async () => {
    const s = scene();
    // The new build's launcher makes the backup immovable (its folder read-only) once the swap is done.
    const launch = join(s.dir, "lock-backup.sh");
    writeFileSync(launch, `#!/bin/sh\nprintf x >> "${s.launches}"\n/bin/chmod 555 "${dirname(s.backup)}"\nexit 0\n`, { mode: 0o755 });
    try {
      expect(await runHelper(s, deadPid(), [launch], { health: 1 })).toBe(3);
    } finally {
      execFileSync("/bin/chmod", ["755", dirname(s.backup)]);
    }
    expect(mark(s.target)).toBe("NEW");
    expect(mark(s.backup)).toBe("OLD");
    expect(readFileSync(join(s.state, "helper.log"), "utf8")).toContain("the new build stays");
    // …and it is started again: the user is not left with no app running (once after the swap, once after).
    expect(readFileSync(s.launches, "utf8")).toBe("xx");
  });

  it("an older backup is replaced: exactly one backup is kept", async () => {
    const s = scene();
    mkdirSync(s.backup, { recursive: true });
    writeFileSync(join(s.backup, MARK), "ANCIENT");
    expect(await runHelper(s, deadPid(), [launcher(s, "healthy")])).toBe(0);
    expect(mark(s.backup)).toBe("OLD");
  });

  it("paths with spaces and quotes are arguments, never script text", async () => {
    const s = scene();
    const odd = join(s.dir, `Apps "o'dd $HOME`);
    execFileSync("/bin/mv", [join(s.dir, "Apps"), odd]);
    const t: Scene = { ...s, target: join(odd, "Kokpit.app"), staged: join(odd, cfg.stagingDirName, BUILD, "Kokpit.app"), backup: join(odd, cfg.stagingDirName, cfg.backupDirName, "Kokpit.app") };
    const launch = join(s.dir, "plain-launcher.sh");
    writeFileSync(launch, `#!/bin/sh\nprintf launched >> "${s.launches}"\nprintf up > "${s.state}/healthy-${BUILD}"\n`, { mode: 0o755 });
    expect(await runHelper(t, deadPid(), [launch])).toBe(0);
    expect(mark(t.target)).toBe("NEW");
    expect(mark(t.backup)).toBe("OLD");
  });
});

describe("helper arguments", () => {
  const plan = (over: Partial<ApplyPlan> = {}): ApplyPlan => ({
    oldPid: 4242,
    location: locateBundle("/Applications/Kokpit.app/Contents/MacOS/Kokpit", cfg, PROFILE)!,
    stagedBundle: `/Applications/${cfg.stagingDirName}/${cfg.profilesDirName}/${PROFILE}/${cfg.buildsDirName}/${BUILD}/Kokpit.app`,
    stateDir: "/ud/update",
    buildId: BUILD,
    appArgs: [],
    env: {},
    ...over,
  });

  it("refuses a plan whose staged build overlaps the backup or the target (before the helper ever runs)", () => {
    const loc = plan().location;
    for (const stagedBundle of [loc.backupBundle, join(loc.backupBundle, "Contents"), dirname(loc.backupBundle), join(loc.bundlePath, "Contents"), loc.bundlePath]) {
      expect(() => helperArgs(plan({ stagedBundle }), "/s", cfg), stagedBundle).toThrow("overlap");
    }
  });

  it("launches the app bundle with `open -n` after the fixed arguments", () => {
    const args = helperArgs(plan(), "/ud/update/apply.sh", cfg);
    const sep = args.indexOf("--");
    expect(args.slice(0, sep)).toEqual([
      "/ud/update/apply.sh",
      "apply",
      "4242",
      "/Applications/Kokpit.app",
      plan().stagedBundle,
      plan().location.backupBundle,
      "/ud/update",
      BUILD,
      String(cfg.exitWaitMs / 1000),
      String(cfg.healthTimeoutMs / 1000),
    ]);
    expect(args.slice(sep + 1)).toEqual([cfg.tools.open, "-n", "/Applications/Kokpit.app"]);
  });

  it("forwards the app's own arguments and only the configured environment variables", () => {
    const custom: UpdateConfig = { ...cfg, relaunchEnv: ["KOKPIT_USER_DATA_DIR"] };
    const args = helperArgs(plan({ appArgs: ["--use-mock-keychain"], env: { KOKPIT_USER_DATA_DIR: "/tmp/ud x", SECRET: "no" } }), "/s", custom);
    expect(args.slice(args.indexOf("--") + 1)).toEqual([cfg.tools.open, "-n", "--env", "KOKPIT_USER_DATA_DIR=/tmp/ud x", "/Applications/Kokpit.app", "--args", "--use-mock-keychain"]);
    expect(args.join(" ")).not.toContain("SECRET");
  });
});

describe("health file", () => {
  it("is what the helper waits for", async () => {
    const dir = fresh();
    await writeHealthFile(dir, BUILD);
    expect(existsSync(join(dir, `healthy-${BUILD}`))).toBe(true);
    expect(readHelperResult(dir, BUILD)).toBeUndefined();
    writeFileSync(join(dir, `result-${BUILD}`), "garbage\n");
    expect(readHelperResult(dir, BUILD)).toBeUndefined();
  });
});
