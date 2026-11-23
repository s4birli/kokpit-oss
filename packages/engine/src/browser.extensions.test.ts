// İş B (uzantılar): pure parts — the Chrome flag that lets CDP load unpacked extensions, and the folder check.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkExtensionDir, chromeArgs, mergeExtensions } from "./browser.ts";
import { EngineError } from "./contracts.ts";

const base = { profileDir: "/data/browser-profiles/p", port: 9333, headless: false, testMode: false, windowWidth: 1280, windowHeight: 800 };

describe("chromeArgs: extensions", () => {
  it("allows CDP Extensions.loadUnpacked (branded Chrome ignores --load-extension since 137)", () => {
    for (const args of [chromeArgs(base), chromeArgs({ ...base, headless: true, testMode: true })]) {
      expect(args).toContain("--enable-unsafe-extension-debugging");
      expect(args.some((a) => a.startsWith("--load-extension"))).toBe(false);
      // DevTools stays on the loopback port (no pipe needed for Extensions.loadUnpacked).
      expect(args.some((a) => a.startsWith("--remote-debugging-pipe"))).toBe(false);
    }
  });
});

describe("checkExtensionDir", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-extdir-")));
    mkdirSync(join(root, "ok"));
    writeFileSync(join(root, "ok", "manifest.json"), "{}");
    mkdirSync(join(root, "empty"));
    writeFileSync(join(root, "file.txt"), "x");
    mkdirSync(join(root, "dirmanifest"));
    mkdirSync(join(root, "dirmanifest", "manifest.json"));
    symlinkSync(join(root, "ok"), join(root, "link"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      return { code: (err as EngineError).code, message: (err as EngineError).message };
    }
    throw new Error("expected EngineError");
  };

  it("accepts an existing folder with manifest.json and returns its real path", () => {
    expect(checkExtensionDir(join(root, "ok"))).toBe(join(root, "ok"));
    expect(checkExtensionDir(join(root, "ok") + "/")).toBe(join(root, "ok"));
    // A symlink resolves to the folder it points at.
    expect(checkExtensionDir(join(root, "link"))).toBe(join(root, "ok"));
  });

  it("refuses with a Turkish reason: missing folder, a file, no manifest, manifest that is a folder", () => {
    expect(code(() => checkExtensionDir(join(root, "nope")))).toMatchObject({ code: "INVALID", message: /bulunamadı/ });
    expect(code(() => checkExtensionDir(join(root, "file.txt")))).toMatchObject({ code: "INVALID", message: /klasör değil/ });
    expect(code(() => checkExtensionDir(join(root, "empty")))).toMatchObject({ code: "INVALID", message: /manifest\.json/ });
    expect(code(() => checkExtensionDir(join(root, "dirmanifest")))).toMatchObject({ code: "INVALID", message: /manifest\.json/ });
  });

  it("monkey: relative, traversing, NUL and option-looking paths never reach the file system", () => {
    for (const p of ["ok", "", "-x", `${root}/ok/../ok`, `${root}/./ok`, "/a\0b", "~/x", `${root}/..`]) {
      expect(code(() => checkExtensionDir(p)), JSON.stringify(p)).toMatchObject({ code: "INVALID" });
    }
  });
});

describe("mergeExtensions", () => {
  it("remembered folders first, with what Chrome reports; unremembered loaded ones after; errors kept", () => {
    const list = mergeExtensions(
      ["/e/a", "/e/b", "/e/c"],
      [
        { id: "ida", name: "A", version: "1", path: "/e/a", enabled: true },
        { id: "idx", name: "X", version: "2", path: "/e/x", enabled: true },
      ],
      new Map([["/e/b", "Manifest file is missing or unreadable"]]),
    );
    expect(list).toEqual([
      { path: "/e/a", id: "ida", name: "A", version: "1", loaded: true },
      { path: "/e/b", loaded: false, error: "Manifest file is missing or unreadable" },
      { path: "/e/c", loaded: false },
      { path: "/e/x", id: "idx", name: "X", version: "2", loaded: true },
    ]);
  });

  it("not running: every remembered folder is listed as not loaded", () => {
    expect(mergeExtensions(["/e/a"], null, new Map())).toEqual([{ path: "/e/a", loaded: false }]);
  });
});
