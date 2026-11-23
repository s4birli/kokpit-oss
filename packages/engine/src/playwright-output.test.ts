// Adım 9 İş T: Playwright MCP output lives in `<base>/<projectId>/`; the engine deletes files older than the
// retention limit. Everything here runs in a temp base dir with a fake clock — never the real per-user temp folder.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  lutimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "./contracts.ts";
import {
  createPlaywrightOutputSweeper,
  playwrightOutputBaseDir,
  playwrightOutputDirFor,
  sweepPlaywrightOutput,
  type SweepResult,
} from "./playwright-output.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * DAY_MS;
const MAX_ENTRIES = 10_000;
/** The fake "now": every age below is relative to it. */
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const OLD = NOW - RETENTION_MS - 60_000;
const FRESH = NOW - RETENTION_MS + 60_000;

let root: string;
let base: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-pw-output-test-")));
  base = join(root, "kokpit-playwright-mcp");
  outside = join(root, "outside");
  mkdirSync(base);
  mkdirSync(outside);
});
afterEach(() => {
  // Unreadable-entry tests take permissions away; give them back so the temp tree can be removed.
  const restore = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      chmodSync(p, 0o700);
      restore(p);
    }
  };
  restore(root);
  rmSync(root, { recursive: true, force: true });
});

function file(path: string, mtimeMs: number, content = "x"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}
const age = (path: string, mtimeMs: number) => utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
const sweep = (over: Partial<Parameters<typeof sweepPlaywrightOutput>[0]> = {}): Promise<SweepResult> =>
  sweepPlaywrightOutput({ baseDir: base, retentionMs: RETENTION_MS, maxEntries: MAX_ENTRIES, now: NOW, ...over });
const gone = (p: string) => {
  try {
    lstatSync(p);
    return false;
  } catch {
    return true;
  }
};

describe("playwrightOutputBaseDir", () => {
  it("is <per-user temp>/<name> by default and <parent>/<name> when a parent is configured", () => {
    expect(playwrightOutputBaseDir({ playwrightMcpOutputDirName: "kokpit-pw" }, "/var/folders/xy/T")).toBe("/var/folders/xy/T/kokpit-pw");
    expect(playwrightOutputBaseDir({ playwrightMcpOutputDirName: "kokpit-pw", playwrightMcpOutputParentDir: "/data/out" }, "/var/folders/xy/T")).toBe(
      "/data/out/kokpit-pw",
    );
  });
});

describe("playwrightOutputDirFor", () => {
  it("is <base>/<projectId>", () => {
    expect(playwrightOutputDirFor("/t/kokpit-pw", "Acme")).toBe("/t/kokpit-pw/Acme");
    expect(playwrightOutputDirFor("/t/kokpit-pw/", "web-tasks")).toBe("/t/kokpit-pw/web-tasks");
    expect(playwrightOutputDirFor("/t/kokpit-pw", "Proje_1.2")).toBe("/t/kokpit-pw/Proje_1.2");
  });

  it.each(["", ".", "..", "a/b", "../x", "/etc", "a\\b", "a\0b", "a\nb", "x".repeat(256), " ", "..."])(
    "refuses an id that is not one safe path segment: %j",
    (id) => {
      expect(() => playwrightOutputDirFor("/t/kokpit-pw", id)).toThrow(/project id/);
    },
  );

  it("refuses a relative base", () => {
    expect(() => playwrightOutputDirFor("kokpit-pw", "Acme")).toThrow(/absolute/);
  });

  it("monkey: any id either throws or yields a direct child of the base", () => {
    const alphabet = ["a", "Z", "0", "-", "_", ".", "/", "\\", "..", " ", "\0", "\n", "ş", "~", "%2e", "*"];
    let seed = 20261117;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      const id = Array.from({ length: rnd(8) }, () => alphabet[rnd(alphabet.length)]!).join("");
      let out: string;
      try {
        out = playwrightOutputDirFor(base, id);
      } catch {
        continue;
      }
      expect(dirname(out)).toBe(base);
      expect(out).toBe(base + sep + id);
    }
  });
});

describe("sweepPlaywrightOutput", () => {
  it("deletes files older than the limit and keeps newer ones", async () => {
    const old = file(join(base, "Acme", "page-old.png"), OLD);
    const fresh = file(join(base, "Acme", "page-new.png"), FRESH);
    const rootOld = file(join(base, "legacy.yml"), OLD);
    const future = file(join(base, "Acme", "future.png"), NOW + DAY_MS);
    const r = await sweep();
    expect(gone(old)).toBe(true);
    expect(gone(rootOld)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(future)).toBe(true);
    expect(r).toMatchObject({ deletedFiles: 2, errors: 0, truncated: false });
  });

  it("a file exactly at the limit stays; one millisecond older goes", async () => {
    const at = file(join(base, "p", "at"), NOW - RETENTION_MS);
    const past = file(join(base, "p", "past"), NOW - RETENTION_MS - 1000);
    await sweep();
    expect(existsSync(at)).toBe(true);
    expect(gone(past)).toBe(true);
  });

  it("nested dirs: old files go at every depth, emptied subdirectories are removed, the base stays", async () => {
    const deep = file(join(base, "p", "a", "b", "c", "old.png"), OLD);
    const keep = file(join(base, "p", "keep", "new.png"), FRESH);
    const r = await sweep();
    expect(gone(deep)).toBe(true);
    expect(gone(join(base, "p", "a"))).toBe(true);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(join(base, "p"))).toBe(true);
    expect(existsSync(base)).toBe(true);
    expect(r).toMatchObject({ deletedFiles: 1, deletedDirs: 3 });
  });

  it("an empty subdirectory goes only when it is old (a just-created one may be about to be written to)", async () => {
    const oldDir = join(base, "old-empty");
    const newDir = join(base, "new-empty");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    age(oldDir, OLD);
    age(newDir, FRESH);
    const r = await sweep();
    expect(gone(oldDir)).toBe(true);
    expect(existsSync(newDir)).toBe(true);
    expect(r.deletedDirs).toBe(1);
  });

  it("never empties the base itself, even when everything in it is old", async () => {
    file(join(base, "only.png"), OLD);
    age(base, OLD);
    await sweep();
    expect(existsSync(base)).toBe(true);
    expect(readdirSync(base)).toEqual([]);
  });

  it("a missing base is fine (nothing was ever written)", async () => {
    rmSync(base, { recursive: true });
    expect(await sweep()).toMatchObject({ deletedFiles: 0, deletedDirs: 0, errors: 0, skipped: "missing" });
    expect(existsSync(base)).toBe(false);
  });

  it("a symlink to a directory outside is unlinked when old, never traversed", async () => {
    const victim = file(join(outside, "victim.txt"), OLD);
    const nestedVictim = file(join(outside, "deep", "victim.txt"), OLD);
    const link = join(base, "p", "escape");
    mkdirSync(join(base, "p"));
    symlinkSync(outside, link);
    lutimesSync(link, OLD / 1000, OLD / 1000);
    const r = await sweep();
    expect(gone(link)).toBe(true);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(nestedVictim)).toBe(true);
    expect(r.deletedFiles).toBe(1);
  });

  it("a fresh symlink to a directory outside stays and is still never traversed", async () => {
    const victim = file(join(outside, "victim.txt"), OLD);
    const link = join(base, "escape");
    symlinkSync(outside, link);
    lutimesSync(link, FRESH / 1000, FRESH / 1000);
    await sweep();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(victim)).toBe(true);
  });

  it("a symlink to an old file outside: the link goes, the file stays", async () => {
    const victim = file(join(outside, "victim.txt"), OLD);
    const link = join(base, "link.txt");
    symlinkSync(victim, link);
    lutimesSync(link, OLD / 1000, OLD / 1000);
    await sweep();
    expect(gone(link)).toBe(true);
    expect(existsSync(victim)).toBe(true);
  });

  it("a `..` symlink and a symlink to the base's parent do not let the sweep out", async () => {
    const sibling = file(join(root, "sibling.txt"), OLD);
    symlinkSync("..", join(base, "up"));
    symlinkSync(root, join(base, "abs-up"));
    symlinkSync(join(base, "..", "outside"), join(base, "dotdot"));
    const victim = file(join(outside, "victim.txt"), OLD);
    await sweep();
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("a base that is itself a symlink is not swept at all", async () => {
    const victim = file(join(outside, "victim.txt"), OLD);
    rmSync(base, { recursive: true });
    symlinkSync(outside, base);
    const r = await sweep();
    expect(existsSync(victim)).toBe(true);
    expect(r).toMatchObject({ deletedFiles: 0, skipped: "not-a-directory" });
  });

  it("a base given with `..` segments or a symlinked parent is swept only at its real location", async () => {
    const old = file(join(base, "old.png"), OLD);
    const sibling = file(join(root, "sibling.txt"), OLD);
    const viaLink = join(root, "parent-link");
    symlinkSync(root, viaLink);
    await sweep({ baseDir: join(viaLink, "outside", "..", "kokpit-playwright-mcp") });
    expect(gone(old)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
  });

  it("a base that is a file, or a relative base, is refused", async () => {
    const f = file(join(root, "plain"), OLD);
    expect(await sweep({ baseDir: f })).toMatchObject({ skipped: "not-a-directory" });
    expect(existsSync(f)).toBe(true);
    expect(await sweep({ baseDir: "relative/dir" })).toMatchObject({ skipped: "not-absolute" });
  });

  it("an unreadable subdirectory is counted and skipped; the rest is still swept", async () => {
    const locked = join(base, "locked");
    const inside = file(join(locked, "old.png"), OLD);
    chmodSync(locked, 0o000);
    const other = file(join(base, "other", "old.png"), OLD);
    const r = await sweep();
    expect(gone(other)).toBe(true);
    expect(r.errors).toBeGreaterThanOrEqual(1);
    chmodSync(locked, 0o700);
    expect(existsSync(inside)).toBe(true);
  });

  it("a file that cannot be deleted (read-only directory) is counted and the sweep goes on", async () => {
    const ro = join(base, "readonly");
    const stuck = file(join(ro, "old.png"), OLD);
    chmodSync(ro, 0o500);
    const other = file(join(base, "z-other", "old.png"), OLD);
    const r = await sweep();
    expect(existsSync(stuck)).toBe(true);
    expect(gone(other)).toBe(true);
    expect(r.errors).toBeGreaterThanOrEqual(1);
  });

  it("work per sweep is bounded: at most maxEntries entries are looked at, the rest waits for the next sweep", async () => {
    const total = 500;
    const limit = 120;
    for (let i = 0; i < total; i++) file(join(base, `d${i % 10}`, `f${i}.png`), OLD);
    const first = await sweep({ maxEntries: limit });
    expect(first.truncated).toBe(true);
    expect(first.scanned).toBeLessThanOrEqual(limit);
    expect(first.deletedFiles).toBeLessThanOrEqual(limit);
    expect(first.deletedFiles).toBeGreaterThan(0);
    // Repeated sweeps finish the job.
    let left = total - first.deletedFiles;
    for (let i = 0; i < total && left > 0; i++) left -= (await sweep({ maxEntries: limit })).deletedFiles;
    expect(left).toBe(0);
  });

  it("a huge flat directory is handled within the bound", async () => {
    const total = 3000;
    for (let i = 0; i < total; i++) file(join(base, "p", `f${i}`), i % 2 ? OLD : FRESH);
    const r = await sweep();
    expect(r).toMatchObject({ deletedFiles: total / 2, truncated: false, errors: 0 });
    expect(readdirSync(join(base, "p"))).toHaveLength(total / 2);
  });

  it("monkey: random trees — exactly the old files and old links inside the base go; nothing outside changes", async () => {
    let seed = 987654321;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 25; round++) {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      mkdirSync(base);
      mkdirSync(outside);
      const outsideFiles = Array.from({ length: 5 }, (_, i) => file(join(outside, `o${i}`, "f.txt"), OLD));
      const expectGone: string[] = [];
      const expectKept: string[] = [];
      const dirs = [base];
      const names = ["a", "b", "ç ğ", "..x", "-rf", "*", "x.png", "n\nl"];
      for (let i = 0; i < 60; i++) {
        const dir = dirs[rnd(dirs.length)]!;
        const p = join(dir, `${names[rnd(names.length)]}-${i}`);
        const old = rnd(2) === 0;
        const kind = rnd(10);
        if (kind < 3) {
          mkdirSync(p);
          dirs.push(p);
        } else if (kind < 5) {
          const target = [outside, root, "..", outsideFiles[rnd(outsideFiles.length)]!, join(outside, "missing")][rnd(5)]!;
          symlinkSync(target, p);
          lutimesSync(p, (old ? OLD : FRESH) / 1000, (old ? OLD : FRESH) / 1000);
          (old ? expectGone : expectKept).push(p);
        } else {
          file(p, old ? OLD : FRESH);
          (old ? expectGone : expectKept).push(p);
        }
      }
      const r = await sweep();
      expect(r.errors).toBe(0);
      expect(r.deletedFiles).toBe(expectGone.length);
      for (const p of expectGone) expect(gone(p), p).toBe(true);
      for (const p of expectKept) expect(gone(p), p).toBe(false);
      for (const p of outsideFiles) expect(existsSync(p), p).toBe(true);
      expect(existsSync(base)).toBe(true);
      expect(readdirSync(outside)).toHaveLength(5);
    }
  });
});

describe("createPlaywrightOutputSweeper", () => {
  const INTERVAL_MS = 24 * 60 * 60 * 1000;

  function setup(over: { now?: () => number } = {}) {
    const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
    const logger: Logger = {
      info: (msg, extra) => logs.push({ level: "info", msg, ...(extra ? { extra } : {}) }),
      warn: (msg, extra) => logs.push({ level: "warn", msg, ...(extra ? { extra } : {}) }),
      error: (msg, extra) => logs.push({ level: "error", msg, ...(extra ? { extra } : {}) }),
    };
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    let clock = NOW;
    const sweeper = createPlaywrightOutputSweeper({
      baseDir: base,
      retentionDays: RETENTION_DAYS,
      intervalMs: INTERVAL_MS,
      maxEntries: MAX_ENTRIES,
      logger,
      now: over.now ?? (() => clock),
      setInterval: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearInterval: (t) => {
        (t as { cleared: boolean }).cleared = true;
      },
    });
    return { sweeper, logs, timers, advance: (ms: number) => (clock += ms) };
  }

  it("sweeps at start, then on every tick of the configured interval, with the injected clock", async () => {
    const old = file(join(base, "p", "old.png"), OLD);
    const later = file(join(base, "p", "later.png"), FRESH);
    const s = setup();
    s.sweeper.start();
    await s.sweeper.whenIdle();
    expect(gone(old)).toBe(true);
    expect(existsSync(later)).toBe(true);
    expect(s.timers).toHaveLength(1);
    expect(s.timers[0]!.ms).toBe(INTERVAL_MS);

    // One day later the second file has crossed the limit.
    s.advance(DAY_MS);
    s.timers[0]!.fn();
    await s.sweeper.whenIdle();
    expect(gone(later)).toBe(true);
  });

  it("logs a count at info level and never a file name", async () => {
    file(join(base, "gizli-proje", "secret-page-name.png"), OLD);
    file(join(base, "gizli-proje", "another-secret.yml"), OLD);
    const s = setup();
    s.sweeper.start();
    await s.sweeper.whenIdle();
    const info = s.logs.filter((l) => l.level === "info");
    expect(info).toHaveLength(1);
    expect(info[0]!.extra).toMatchObject({ deletedFiles: 2, errors: 0 });
    const text = JSON.stringify(s.logs);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("gizli-proje");
  });

  it("dispose stops the timer; a later tick does nothing", async () => {
    const s = setup();
    s.sweeper.start();
    await s.sweeper.whenIdle();
    s.sweeper.dispose();
    expect(s.timers[0]!.cleared).toBe(true);
    const old = file(join(base, "old.png"), OLD);
    s.timers[0]!.fn();
    await s.sweeper.whenIdle();
    expect(existsSync(old)).toBe(true);
  });

  it("start twice keeps one timer; a tick during a running sweep does not start a second one", async () => {
    for (let i = 0; i < 200; i++) file(join(base, "p", `f${i}`), OLD);
    const s = setup();
    s.sweeper.start();
    s.sweeper.start();
    s.timers[0]!.fn();
    await s.sweeper.whenIdle();
    expect(s.timers).toHaveLength(1);
    expect(s.logs.filter((l) => l.level === "info")).toHaveLength(1);
    expect(readdirSync(base)).toEqual([]);
  });

  it("a failing clock or sweep never throws out of the timer; it is logged", async () => {
    const s = setup({
      now: () => {
        throw new Error("clock broke");
      },
    });
    s.sweeper.start();
    await s.sweeper.whenIdle();
    expect(s.logs.some((l) => l.level === "warn")).toBe(true);
  });
});
