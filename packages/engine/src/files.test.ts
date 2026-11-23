// İş F — Dosyalar: listing and reading inside a project root, never outside it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES } from "@kokpit/shared";
import { EngineError } from "./contracts.ts";
import {
  createFileService,
  FILES_MAX_ENTRIES,
  FILES_MAX_READ_BYTES,
  FilesConfigOverrideSchema,
  loadFilesConfig,
  type FilesConfig,
} from "./files.ts";

const SECRET = "KOKPIT-FILES-SECRET-OUTSIDE-3e9a";
const GIT_SECRET = "KOKPIT-FILES-GIT-CONFIG-77b1";
const OUTSIDE_MARKER = "OUTSIDE-ONLY-MARKER.txt";
const MAX_READ = 64;
const MAX_ENTRIES = 40;
const CONFIG: FilesConfig = { ...loadFilesConfig({}), maxReadBytes: MAX_READ, maxEntries: MAX_ENTRIES };

let base: string;
let root: string;
let outside: string;
const svc = createFileService({ config: CONFIG });

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-files-")));
  root = join(base, "proje");
  outside = join(base, "dışarı");
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "boş"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "kalabalık"));
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), SECRET);
  writeFileSync(join(outside, OUTSIDE_MARKER), SECRET);
  writeFileSync(join(base, "secret.txt"), SECRET);
  writeFileSync(join(root, ".git", "config"), GIT_SECRET);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  writeFileSync(join(root, "README.md"), "# Proje\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "nested", "deep.txt"), "derin\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x14]));
  writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  writeFileSync(join(root, "big.txt"), "x".repeat(MAX_READ * 3));
  // "ş" is two bytes: an odd cap cuts one in half; the preview must end on a whole character.
  writeFileSync(join(root, "turkish.txt"), "ş".repeat(MAX_READ));
  for (let i = 0; i < MAX_ENTRIES + 5; i++) writeFileSync(join(root, "kalabalık", `f${String(i).padStart(3, "0")}`), "");
  symlinkSync(join(root, "src"), join(root, "link-in"));
  symlinkSync(join(root, "README.md"), join(root, "link-file"));
  symlinkSync("/etc", join(root, "link-out"));
  symlinkSync("/etc/hosts", join(root, "link-out-file"));
  symlinkSync(outside, join(root, "link-sibling"));
  symlinkSync(join(root, ".git"), join(root, "link-git"));
  symlinkSync(join(root, "yok"), join(root, "broken"));
  symlinkSync(root, join(base, "root-link"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof EngineError) return err.code;
    throw err;
  }
  return "OK";
}

describe("loadFilesConfig", () => {
  it("ships defaults that hide .git and fit in one protocol frame", () => {
    const c = loadFilesConfig({});
    expect(c.hiddenNames).toContain(".git");
    expect(c.maxEntries).toBeLessThanOrEqual(FILES_MAX_ENTRIES);
    expect(c.maxReadBytes).toBeLessThanOrEqual(FILES_MAX_READ_BYTES);
    // Worst case JSON escaping (\u00XX per byte) still fits a frame.
    expect(FILES_MAX_READ_BYTES * 6).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it.each([
    ["unknown key", { nope: 1 }],
    ["hidden name with slash", { hiddenNames: ["a/b"] }],
    ["hidden dot-dot", { hiddenNames: [".."] }],
    ["zero entries", { maxEntries: 0 }],
    ["too many entries", { maxEntries: FILES_MAX_ENTRIES + 1 }],
    ["read cap above a frame", { maxReadBytes: FILES_MAX_READ_BYTES + 1 }],
  ])("rejects %s", (_n, o) => {
    expect(FilesConfigOverrideSchema.safeParse(o).success).toBe(false);
  });

  it("applies overrides", () => {
    expect(loadFilesConfig({ hiddenNames: [".git", "node_modules"], maxEntries: 7 })).toMatchObject({
      hiddenNames: [".git", "node_modules"],
      maxEntries: 7,
    });
  });
});

describe("files.list", () => {
  it("lists the root: folders first, by name, .git hidden, symlink targets resolved inside the root only", () => {
    const { entries, truncated } = svc.list(root, "");
    expect(truncated).toBe(false);
    expect(entries.map((e) => e.name)).toEqual([
      "boş",
      "kalabalık",
      "link-in",
      "src",
      ".gitignore",
      "big.txt",
      "bin.dat",
      "broken",
      "latin1.txt",
      "link-file",
      "link-git",
      "link-out",
      "link-out-file",
      "link-sibling",
      "README.md",
      "turkish.txt",
    ]);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["src"]).toEqual({ name: "src", kind: "dir" });
    expect(byName["README.md"]).toEqual({ name: "README.md", kind: "file", size: 8 });
    expect(byName["link-in"]).toEqual({ name: "link-in", kind: "symlink", target: "dir" });
    expect(byName["link-file"]).toEqual({ name: "link-file", kind: "symlink", target: "file" });
    for (const n of ["link-out", "link-out-file", "link-sibling", "link-git", "broken"]) {
      expect(byName[n]).toEqual({ name: n, kind: "symlink" });
    }
  });

  it("lists subfolders, accepting harmless spellings", () => {
    const want = [{ name: "nested", kind: "dir" }, { name: "a.ts", kind: "file", size: 20 }];
    expect(svc.list(root, "src").entries).toEqual(want);
    expect(svc.list(root, "src/").entries).toEqual(want);
    expect(svc.list(root, "./src").entries).toEqual(want);
    expect(svc.list(root, "src/nested").entries.map((e) => e.name)).toEqual(["deep.txt"]);
    expect(svc.list(root, "src//nested").entries.map((e) => e.name)).toEqual(["deep.txt"]);
    expect(svc.list(root, "boş").entries).toEqual([]);
  });

  it("follows a symlink that stays inside the root", () => {
    expect(svc.list(root, "link-in").entries.map((e) => e.name)).toEqual(["nested", "a.ts"]);
    expect(svc.read(root, "link-in/a.ts").text).toBe("export const a = 1;\n");
  });

  it("works when the root itself is reached through a symlink", () => {
    expect(svc.list(join(base, "root-link"), "src").entries.map((e) => e.name)).toEqual(["nested", "a.ts"]);
    expect(code(() => svc.list(join(base, "root-link"), "link-sibling"))).toBe("INVALID");
  });

  it("caps the number of entries", () => {
    const { entries, truncated } = svc.list(root, "kalabalık");
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(truncated).toBe(true);
    expect(entries[0]!.name).toBe("f000");
  });

  it("hides configured names", () => {
    const s = createFileService({ config: { ...CONFIG, hiddenNames: [".git", "src"] } });
    expect(s.list(root, "").entries.map((e) => e.name)).not.toContain("src");
    expect(code(() => s.list(root, "src"))).toBe("NOT_FOUND");
    // A link into a hidden folder is not browsable either.
    expect(s.list(root, "").entries.find((e) => e.name === "link-in")).toEqual({ name: "link-in", kind: "symlink" });
    expect(code(() => s.list(root, "link-in"))).toBe("NOT_FOUND");
  });

  it("refuses to list a file, and a missing folder or root", () => {
    expect(code(() => svc.list(root, "README.md"))).toBe("INVALID");
    expect(code(() => svc.list(root, "yok"))).toBe("NOT_FOUND");
    expect(code(() => svc.list(join(base, "olmayan"), ""))).toBe("NOT_FOUND");
  });
});

describe("files.read", () => {
  it("reads UTF-8 text", () => {
    expect(svc.read(root, "src/a.ts")).toEqual({ text: "export const a = 1;\n", size: 20, truncated: false });
    expect(svc.read(root, "link-file")).toEqual({ text: "# Proje\n", size: 8, truncated: false });
  });

  it("detects binary files (NUL bytes or invalid UTF-8)", () => {
    expect(svc.read(root, "bin.dat")).toEqual({ binary: true, size: 7, truncated: false });
    expect(svc.read(root, "latin1.txt")).toEqual({ binary: true, size: 5, truncated: false });
  });

  it("returns only the first maxReadBytes of a big file", () => {
    expect(svc.read(root, "big.txt")).toEqual({ text: "x".repeat(MAX_READ), size: MAX_READ * 3, truncated: true });
  });

  it("never cuts a multi-byte character in half", () => {
    const s = createFileService({ config: { ...CONFIG, maxReadBytes: MAX_READ - 1 } });
    const r = s.read(root, "turkish.txt");
    expect(r.truncated).toBe(true);
    expect(r.binary).toBeUndefined();
    expect(r.text).toBe("ş".repeat((MAX_READ - 2) / 2));
  });

  it("refuses folders and missing files", () => {
    expect(code(() => svc.read(root, "src"))).toBe("INVALID");
    expect(code(() => svc.read(root, ""))).toBe("INVALID");
    expect(code(() => svc.read(root, "src/yok.ts"))).toBe("NOT_FOUND");
    expect(code(() => svc.read(root, "broken"))).toBe("NOT_FOUND");
  });
});

describe("path safety", () => {
  const ESCAPES = [
    "..",
    "../",
    "../secret.txt",
    "../dışarı/secret.txt",
    "src/../../secret.txt",
    "src/../..",
    "/etc/passwd",
    "/etc",
    "/",
    "//etc/passwd",
    "C:\\Windows",
    "src\\..\\..\\secret.txt",
    "..\\secret.txt",
    "a\0b",
    "link-out",
    "link-out/hosts",
    "link-out-file",
    "link-sibling",
    "link-sibling/secret.txt",
    `link-sibling/${OUTSIDE_MARKER}`,
    "src/../.git/config",
  ];
  const HIDDEN = [".git", ".git/config", "./.git/config", "src//.git", "link-git", "link-git/config"];
  const ENCODED = ["%2e%2e%2fsecret.txt", "..%2fsecret.txt", "%2e%2e/secret.txt", "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd", "..%5csecret.txt"];

  it.each([...ESCAPES, `${"root"}`])("refuses %j", (p) => {
    const path = p === "root" ? join(root, "README.md") : p;
    for (const fn of [() => svc.list(root, path), () => svc.read(root, path)]) {
      expect(["INVALID", "NOT_FOUND"]).toContain(code(fn));
    }
  });

  it("answers INVALID for a path that leaves the root", () => {
    expect(code(() => svc.read(root, "../secret.txt"))).toBe("INVALID");
    expect(code(() => svc.read(root, "link-out-file"))).toBe("INVALID");
    expect(code(() => svc.list(root, "link-out"))).toBe("INVALID");
    expect(code(() => svc.read(root, "/etc/passwd"))).toBe("INVALID");
  });

  // macOS volumes are usually case-insensitive (and normalise Unicode): ".GIT" opens ".git".
  it.each([".GIT/config", ".Git", "./.gIt/config", ".git́"])("hides other spellings of .git: %j", (p) => {
    for (const fn of [() => svc.list(root, p), () => svc.read(root, p)]) {
      expect(code(fn)).toBe("NOT_FOUND");
    }
  });

  it("hides differently-cased entries from listings", () => {
    const s = createFileService({ config: { ...CONFIG, hiddenNames: [".git", "README.MD"] } });
    expect(s.list(root, "").entries.map((e) => e.name)).not.toContain("README.md");
  });

  it.each(HIDDEN)("treats .git as missing: %j", (p) => {
    expect(code(() => svc.list(root, p))).toBe("NOT_FOUND");
    expect(code(() => svc.read(root, p))).toBe("NOT_FOUND");
  });

  it.each(ENCODED)("never decodes %j (a literal, missing name)", (p) => {
    expect(code(() => svc.read(root, p))).toBe("NOT_FOUND");
    expect(code(() => svc.list(root, p))).toBe("NOT_FOUND");
  });

  it("monkey: random paths never reach outside the root or into .git", () => {
    const pool = [
      "..", ".", "", "src", "nested", "link-in", "link-out", "link-sibling", "link-git", ".git", "config", "%2e%2e",
      "secret.txt", OUTSIDE_MARKER, "etc", "hosts", "passwd", "~", "\\", "..\\..", "README.md", "a.ts", "\u0000", "ş", " ",
    ];
    let seed = 0x9e3779b9;
    const rand = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      const parts = Array.from({ length: 1 + rand(6) }, () => pool[rand(pool.length)]!);
      const path = (rand(5) === 0 ? "/" : "") + parts.join(rand(7) === 0 ? "\\" : "/");
      for (const op of ["list", "read"] as const) {
        let out: unknown;
        try {
          out = op === "list" ? svc.list(root, path) : svc.read(root, path);
        } catch (err) {
          expect(err, path).toBeInstanceOf(EngineError);
          expect(["INVALID", "NOT_FOUND"], path).toContain((err as EngineError).code);
          continue;
        }
        const text = JSON.stringify(out);
        expect(text, path).not.toContain(SECRET);
        expect(text, path).not.toContain(GIT_SECRET);
        expect(text, path).not.toContain(OUTSIDE_MARKER);
        expect(text, path).not.toContain('"config"');
        expect(text, path).not.toContain("127.0.0.1"); // /etc/hosts
      }
    }
  });
});
