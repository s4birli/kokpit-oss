// Yollar: a path as a terminal printed it → what it is on this machine. Real files in a temp HOME and project.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineError } from "./contracts.ts";
import { createFileService, loadFilesConfig } from "./files.ts";
import { createMediaService } from "./files-media.ts";
import { createPreviewService } from "./files-preview.ts";
import { createCwdLookup, createPathLocator, parseLsofCwd, pathCandidates, type PathLocator, type PathOwner } from "./local-paths.ts";
import { FakeLogger } from "../test/fakes/server-fakes.ts";

let base: string;
let home: string;
let project: string;
let card: string;
let locator: PathLocator;
const cfg = loadFilesConfig({});

const write = (path: string, content = "x"): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};
const owner = (extra: Partial<PathOwner> = {}): PathOwner => ({ root: project, roots: [project], ...extra });
function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
  return "ok";
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-paths-")));
  home = join(base, "home");
  project = join(base, "Ana Disk", "proje");
  card = join(base, "kartlar", "kart-1");
  write(join(home, "Documents", "Acme-ux-2026-11-05", "index.html"), "<!doctype html>");
  write(join(home, "Documents", "Acme-ux-2026-11-05", "style.css"));
  write(join(home, "Documents", "notlar.md"), "# not");
  write(join(home, "Documents", "arsiv.zip"));
  write(join(home, "Movies", "klip.mp4"));
  write(join(home, ".ssh", "id_rsa.html"));
  write(join(project, "src", "app.ts"));
  write(join(project, "dist", "index.html"));
  write(join(project, "docs", "ekran.png"));
  write(join(project, "docs", "iki kelime", "rapor.html"));
  write(join(project, ".git", "config"));
  write(join(card, "src", "app.ts"), "kart");
  symlinkSync(join(home, "Documents", "notlar.md"), join(project, "disari.md"));
  const logger = new FakeLogger();
  const files = createFileService({ config: cfg });
  const media = createMediaService({ config: cfg.media, resolve: files.resolve, logger });
  const preview = createPreviewService({ config: cfg.preview, homeDir: home, logger });
  locator = createPathLocator({ config: cfg.paths, homeDir: home, resolveInRoot: files.resolve, mediaKindOf: media.kindOf, preview });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("pathCandidates", () => {
  const ctx = { home: "/Users/ada", dirs: ["/work/cwd", "/work/root"], maxTailWords: 12 };
  it.each([
    ["~/Documents/a.html", ["/Users/ada/Documents/a.html"]],
    ["$HOME/a/b", ["/Users/ada/a/b"]],
    ["~", ["/Users/ada"]],
    ["/tmp/x/../y.html", ["/tmp/y.html"]],
    ["src/a.ts", ["/work/cwd/src/a.ts", "/work/root/src/a.ts"]],
    ["./a.html", ["/work/cwd/a.html", "/work/root/a.html"]],
    ["../../../etc/passwd", ["/etc/passwd"]],
    ["~ada/x.html", ["/work/cwd/~ada/x.html", "/work/root/~ada/x.html"]],
  ])("%s → %j", (path, expected) => expect(pathCandidates({ path }, ctx)).toEqual(expected));

  it("the continuation of an unquoted path is tried longest first, then the path itself", () => {
    expect(pathCandidates({ path: "/Volumes/Main", tail: " Disk/kokpit/docs/rapor.html (3 kB)." }, ctx)).toEqual([
      "/Volumes/Main Disk/kokpit/docs/rapor.html (3 kB)",
      "/Volumes/Main Disk/kokpit/docs/rapor.html (3",
      "/Volumes/Main Disk/kokpit/docs/rapor.html",
      "/Volumes/Main",
    ]);
    expect(pathCandidates({ path: "/a/b", tail: " c d e" }, { ...ctx, maxTailWords: 1 })).toEqual(["/a/b c", "/a/b"]);
    expect(pathCandidates({ path: "/a/b", tail: " c" }, { ...ctx, maxTailWords: 0 })).toEqual(["/a/b"]);
  });

  it("nothing for what is no path", () => {
    expect(pathCandidates({ path: "" }, ctx)).toEqual([]);
    expect(pathCandidates({ path: "a\0b" }, ctx)).toEqual([]);
    expect(pathCandidates({ path: "/a", tail: " b\0" }, ctx)).toEqual([]);
    expect(pathCandidates({ path: "a/b.ts" }, { ...ctx, dirs: [] })).toEqual([]);
  });
});

describe("terminalin bulunduğu klasör (lsof)", () => {
  it("reads the directory from lsof's field output", () => {
    expect(parseLsofCwd("p123\nfcwd\nn/Users/ada/proje\n")).toBe("/Users/ada/proje");
    expect(parseLsofCwd("p123\nfcwd\nn/Volumes/Main Disk/kokpit\n")).toBe("/Volumes/Main Disk/kokpit");
    expect(parseLsofCwd("")).toBeUndefined();
    expect(parseLsofCwd("p1\nfcwd\nn\n")).toBeUndefined();
    expect(parseLsofCwd("p1\nfcwd\nngöreli\n")).toBeUndefined();
  });

  it("asks once per terminal within the cache time; a failure is 'unknown', not an error", async () => {
    let now = 0;
    const calls: string[][] = [];
    const lookup = createCwdLookup({
      config: { ...cfg.paths, cwdCacheMs: 1000 },
      logger: new FakeLogger(),
      now: () => now,
      exec: async (file, args) => {
        calls.push([file, ...args]);
        if (args.includes("7")) throw new Error("lsof: no such process");
        return "p5\nfcwd\nn/work/here\n";
      },
    });
    expect(await lookup.cwdOf(5)).toBe("/work/here");
    expect(await lookup.cwdOf(5)).toBe("/work/here");
    expect(calls).toEqual([[cfg.paths.lsofPath, "-a", "-p", "5", "-d", "cwd", "-Fn"]]);
    now = 1001;
    await lookup.cwdOf(5);
    expect(calls).toHaveLength(2);
    expect(await lookup.cwdOf(7)).toBeUndefined();
    expect(await lookup.cwdOf(0)).toBeUndefined();
    expect(await lookup.cwdOf(-3)).toBeUndefined();
    expect(await lookup.cwdOf(1.5)).toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  it("reads the real current directory of a real process", async () => {
    const lookup = createCwdLookup({ config: cfg.paths, logger: new FakeLogger() });
    expect(await lookup.cwdOf(process.pid)).toBe(realpathSync(process.cwd()));
  });
});

describe("locate: yol neyi gösteriyor", () => {
  it("the user's case: a page outside the project opens in the browser", () => {
    expect(locator.locate(owner(), { path: "~/Documents/Acme-ux-2026-11-05/index.html" })).toEqual({
      path: join(home, "Documents", "Acme-ux-2026-11-05", "index.html"),
      kind: "page",
      browser: true,
    });
  });

  it("a page inside the project is a page there too, and Dosyalar can show it", () => {
    expect(locator.locate(owner(), { path: "dist/index.html" })).toEqual({ path: join(project, "dist", "index.html"), kind: "page", rootPath: "dist/index.html", browser: true });
    expect(locator.locate(owner(), { path: join(project, "dist", "index.html") })).toMatchObject({ kind: "page", rootPath: "dist/index.html" });
  });

  it("media: inside the project for Dosyalar, outside it for the browser", () => {
    expect(locator.locate(owner(), { path: "docs/ekran.png" })).toEqual({ path: join(project, "docs", "ekran.png"), kind: "media", media: "image", rootPath: "docs/ekran.png", browser: true });
    expect(locator.locate(owner(), { path: "~/Movies/klip.mp4" })).toEqual({ path: join(home, "Movies", "klip.mp4"), kind: "media", media: "video", browser: true });
  });

  it("other files: shown in Dosyalar when inside the project; outside only what the preview serves has a browser", () => {
    expect(locator.locate(owner(), { path: "src/app.ts" })).toEqual({ path: join(project, "src", "app.ts"), kind: "file", rootPath: "src/app.ts", browser: false });
    expect(locator.locate(owner(), { path: "~/Documents/notlar.md" })).toEqual({ path: join(home, "Documents", "notlar.md"), kind: "file", browser: true });
    expect(locator.locate(owner(), { path: "~/Documents/arsiv.zip" })).toEqual({ path: join(home, "Documents", "arsiv.zip"), kind: "file", browser: false });
  });

  it("a folder: Dosyalar when inside the project, never the browser", () => {
    expect(locator.locate(owner(), { path: "src" })).toEqual({ path: join(project, "src"), kind: "dir", rootPath: "src", browser: false });
    expect(locator.locate(owner(), { path: project })).toEqual({ path: project, kind: "dir", rootPath: "", browser: false });
    expect(locator.locate(owner(), { path: "~/Documents" })).toEqual({ path: join(home, "Documents"), kind: "dir", browser: false });
  });

  it("a relative path is looked for in the terminal's current directory first, then in the folder", () => {
    expect(locator.locate(owner({ cwd: join(project, "src") }), { path: "app.ts" }).path).toBe(join(project, "src", "app.ts"));
    expect(locator.locate(owner({ cwd: join(project, "src") }), { path: "dist/index.html" }).path).toBe(join(project, "dist", "index.html"));
    expect(locator.locate(owner({ cwd: join(home, "Documents") }), { path: "Acme-ux-2026-11-05/index.html" })).toMatchObject({ kind: "page", browser: true });
    // A card's terminal: the card's folder, and the answer says so.
    expect(locator.locate({ root: card, roots: [card, project], cardId: "kart-1" }, { path: "src/app.ts" })).toEqual({
      path: join(card, "src", "app.ts"),
      kind: "file",
      rootPath: "src/app.ts",
      cardId: "kart-1",
      browser: false,
    });
  });

  it("an unquoted path with a space in it is found through what follows it", () => {
    const first = join(base, "Ana");
    expect(locator.locate(owner(), { path: first, tail: " Disk/proje/dist/index.html (3 kB)" })).toMatchObject({ path: join(project, "dist", "index.html"), kind: "page" });
    expect(locator.locate(owner(), { path: "docs/iki", tail: " kelime/rapor.html yazıldı." })).toMatchObject({ path: join(project, "docs", "iki kelime", "rapor.html"), rootPath: "docs/iki kelime/rapor.html" });
    expect(failure(() => locator.locate(owner(), { path: first }))).toBe("NOT_FOUND");
  });

  it("what Dosyalar hides or a link that leaves the folder has no place in Dosyalar", () => {
    expect(locator.locate(owner(), { path: ".git/config" })).toEqual({ path: join(project, ".git", "config"), kind: "file", browser: false });
    // The link's target is outside the project: it is that file, not a project file.
    expect(locator.locate(owner(), { path: "disari.md" })).toEqual({ path: join(home, "Documents", "notlar.md"), kind: "file", browser: true });
  });

  it("a refused folder says why; the type alone does not open it", () => {
    const hidden = locator.locate(owner(), { path: "~/.ssh/id_rsa.html" });
    expect(hidden).toMatchObject({ kind: "page", browser: false });
    expect(hidden.browserRefusal).toContain("Gizli");
    expect(hidden.rootPath).toBeUndefined();
  });

  it("nothing there → NOT_FOUND; a device or FIFO → INVALID", () => {
    expect(failure(() => locator.locate(owner(), { path: "~/Documents/yok.html" }))).toBe("NOT_FOUND");
    expect(failure(() => locator.locate(owner(), { path: "yok/yok.ts" }))).toBe("NOT_FOUND");
    expect(failure(() => locator.locate({ root: null, roots: [] }, { path: "src/app.ts" }))).toBe("NOT_FOUND");
    expect(failure(() => locator.locate(owner(), { path: "/dev/null" }))).toBe("INVALID");
    const fifo = join(project, "boru.html");
    execFileSync("mkfifo", [fifo]);
    expect(failure(() => locator.locate(owner(), { path: "boru.html" }))).toBe("INVALID");
    rmSync(fifo);
  });

  it("maymun: random text never throws anything but an EngineError and never names a file outside what exists", () => {
    const pieces = ["~", "/", "..", ".", "src", "dist", "index.html", " ", "\\", "$HOME", "%2e", "*", "?", "\n", "Documents", ".ssh", "ç", "报告", "-", ":", "//"];
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 1500; i++) {
      let path = "";
      for (let k = next(8); k >= 0; k--) path += pieces[next(pieces.length)];
      const tail = next(3) === 0 ? ` ${pieces[next(pieces.length)]}` : undefined;
      if (path === "") continue;
      try {
        const found = locator.locate(owner({ cwd: next(2) === 0 ? join(project, "src") : undefined }), { path, tail });
        expect(found.path.startsWith("/"), path).toBe(true);
        if (found.rootPath !== undefined) expect(found.rootPath.split("/").includes(".."), path).toBe(false);
      } catch (e) {
        expect(e, JSON.stringify(path)).toBeInstanceOf(EngineError);
      }
    }
  });
});
