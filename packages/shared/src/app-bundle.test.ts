import { describe, expect, it } from "vitest";
import { BundleFormatError, bundleUnpackedSize, isBundleName, validateBundleEntries, type BundleEntry } from "./app-bundle.ts";

const LIMITS = { maxEntries: 100, maxLinks: 10, maxFileBytes: 1000, maxTotalBytes: 2000 };
const H = "a".repeat(64);
const dir = (path: string) => ({ path, type: "dir" as const });
const file = (path: string, over: Record<string, unknown> = {}) => ({ path, type: "file" as const, mode: 0o644, size: 3, sha256: H, ...over });
const link = (path: string, target: string) => ({ path, type: "symlink" as const, target });

/** A small list shaped like a real bundle: nested folders, an executable, framework-style chained links. */
const GOOD = [
  dir("Contents"),
  file("Contents/Info.plist"),
  dir("Contents/MacOS"),
  file("Contents/MacOS/Kokpit", { mode: 0o755, size: 500 }),
  dir("Contents/Frameworks"),
  dir("Contents/Frameworks/Electron Framework.framework"),
  dir("Contents/Frameworks/Electron Framework.framework/Versions"),
  dir("Contents/Frameworks/Electron Framework.framework/Versions/A"),
  file("Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework", { mode: 0o755 }),
  dir("Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"),
  link("Contents/Frameworks/Electron Framework.framework/Versions/Current", "A"),
  link("Contents/Frameworks/Electron Framework.framework/Electron Framework", "Versions/Current/Electron Framework"),
  link("Contents/Frameworks/Electron Framework.framework/Resources", "Versions/Current/Resources"),
  dir("Contents/Resources"),
  file("Contents/Resources/app (1)+x@2.asar", { size: 0 }),
];
const check = (entries: unknown): BundleEntry[] => validateBundleEntries(entries, LIMITS);
const refused = (entries: unknown): string => {
  let err: unknown;
  try {
    check(entries);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(BundleFormatError);
  return (err as Error).message;
};
const withExtra = (...extra: unknown[]): unknown[] => [...GOOD, ...extra];

describe("validateBundleEntries", () => {
  it("accepts a list shaped like a real bundle, links through links included", () => {
    expect(check(GOOD)).toEqual(GOOD);
    expect(bundleUnpackedSize(check(GOOD))).toBe(3 + 500 + 3 + 0);
  });

  it.each([
    ["not a list", { 0: dir("Contents") }],
    ["empty", []],
    ["a record that is not an object", ["Contents"]],
    ["an unknown type", [{ path: "Contents", type: "device" }]],
    ["an unknown field", [{ ...dir("Contents"), extra: 1 }]],
    ["a file without a hash", [dir("Contents"), { path: "Contents/a", type: "file", mode: 0o644, size: 1 }]],
    ["a hash that is not hex", [dir("Contents"), file("Contents/a", { sha256: "Z".repeat(64) })]],
    ["a negative size", [dir("Contents"), file("Contents/a", { size: -1 })]],
    ["a fractional size", [dir("Contents"), file("Contents/a", { size: 1.5 })]],
    ["a size as text", [dir("Contents"), file("Contents/a", { size: "3" })]],
    ["setuid mode", [dir("Contents"), file("Contents/a", { mode: 0o4755 })]],
    ["world-writable mode", [dir("Contents"), file("Contents/a", { mode: 0o777 })]],
    ["a dir with a mode", [{ ...dir("Contents"), mode: 0o777 }]],
    ["a link with a size", [dir("Contents"), { ...link("Contents/l", "x"), size: 1 }]],
  ])("refuses %s", (_n, entries) => {
    refused(entries);
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["parent traversal", "../outside"],
    ["traversal in the middle", "Contents/../../outside"],
    ["a dot component", "Contents/./a"],
    ["an empty component", "Contents//a"],
    ["a trailing slash", "Contents/a/"],
    ["a backslash", "Contents\\a"],
    ["NUL", "Contents/a\0b"],
    ["a newline", "Contents/a\nb"],
    ["a colon (old Mac path separator)", "Contents/a:b"],
    ["non-ASCII (two Unicode forms could name one file)", "Contents/İçerik"],
    ["a combining mark", "Contents/á"],
    ["a component that is too long", `Contents/${"a".repeat(129)}`],
    ["a tilde", "~/Library/x"],
    ["a quote", 'Contents/a"b'],
    ["a dollar sign", "Contents/$HOME"],
  ])("refuses a path with %s", (_n, path) => {
    expect(refused(withExtra(file(path)))).toMatch(/yol|üst klasör|kayıt biçimi/);
  });

  it("refuses the same path twice — also when only the case differs (one file on a Mac's disk)", () => {
    expect(refused(withExtra(file("Contents/Info.plist")))).toContain("iki kez");
    expect(refused(withExtra(file("Contents/info.PLIST")))).toContain("iki kez");
    expect(refused(withExtra(dir("contents")))).toContain("iki kez");
  });

  it("refuses a record whose parent is missing, listed later, not a directory, or spelled in another case", () => {
    expect(refused([file("Contents/a")])).toContain("üst klasör");
    expect(refused([dir("Contents/MacOS"), dir("Contents")])).toContain("üst klasör");
    expect(refused(withExtra(file("Contents/Info.plist/inside")))).toContain("üst klasör");
    expect(refused(withExtra(file("contents/x")))).toContain("üst klasör");
  });

  it("refuses anything created INSIDE a link (it would be written wherever the link points)", () => {
    expect(refused(withExtra(link("Contents/out", "Resources"), file("Contents/out/evil")))).toContain("üst klasör");
    expect(refused(withExtra(link("Contents/Out", "Resources"), file("Contents/out/evil")))).toContain("üst klasör");
  });

  it.each([
    ["an absolute target", "/etc/hosts"],
    ["a target above the bundle", "../../outside"],
    ["a target that climbs out and comes back", "../../Kokpit.app/Contents"],
    ["just the root's parent", ".."],
    ["a dangling target", "nowhere"],
    ["a target in another case than listed", "resources"],
    ["a target through a file", "Info.plist/x"],
    ["a target with a backslash", "Resources\\x"],
    ["a target with a dot component", "./Resources"],
    ["an empty component", "Resources//x"],
  ])("refuses a link with %s", (_n, target) => {
    expect(refused(withExtra(link("Contents/l", target)))).toContain("bağlantı");
  });

  it("refuses a link that leaves the bundle only THROUGH another link, and link loops", () => {
    // `up` stays inside by itself (it names the root's child), `out` climbs out through it.
    expect(refused(withExtra(link("Contents/up", "Frameworks"), link("Contents/out", "up/../../..")))).toContain("bağlantı");
    expect(refused(withExtra(link("Contents/a", "b"), link("Contents/b", "a")))).toContain("bağlantı");
    expect(refused(withExtra(link("Contents/self", "self")))).toContain("bağlantı");
    // A chain that stays inside is fine, however it winds.
    expect(() => check(withExtra(link("Contents/one", "Frameworks"), link("Contents/two", "one/Electron Framework.framework/Resources")))).not.toThrow();
  });

  it("bounds the work of checking links: their number and how complex a target may be — and stays fast", () => {
    const many = [dir("C"), dir("C/d"), ...Array.from({ length: 11 }, (_x, i) => link(`C/l${i}`, "d"))];
    expect(refused(many)).toContain("çok fazla bağlantı");
    expect(refused(withExtra(link("Contents/deep", Array(17).fill("Frameworks").join("/"))))).toContain("karmaşık");
    expect(refused(withExtra(link("Contents/long", `${"a".repeat(257)}`)))).toContain("kayıt biçimi");
    // The reviewer's case: 20 000 entries, link-heavy targets through a chain — refused, quickly.
    const list: unknown[] = [dir("C"), dir("C/d")];
    for (let i = 0; i < 3; i++) list.push(link(`C/l${i}`, i === 0 ? "d" : `l${i - 1}`));
    const target = ("l2/../".repeat(2) + "d/../".repeat(190) + "d").slice(0, 1000);
    for (let i = 0; list.length < 20000; i++) list.push(link(`C/x${i}`, target));
    const started = performance.now();
    expect(() => validateBundleEntries(list, { maxEntries: 20000, maxLinks: 1024, maxFileBytes: 1 << 30, maxTotalBytes: 2 ** 31 })).toThrow(BundleFormatError);
    expect(performance.now() - started).toBeLessThan(50);
    // The most that can pass: 1024 links, each a 16-part target through chains of links — still bounded.
    const worst: unknown[] = [dir("C"), dir("C/d")];
    for (let i = 0; i < 6; i++) worst.push(link(`C/c${i}`, i === 0 ? "d" : `c${i - 1}`));
    for (let i = 0; worst.length < 1024 + 2; i++) worst.push(link(`C/w${i}`, "../C/c5"));
    const t2 = performance.now();
    validateBundleEntries(worst, { maxEntries: 20000, maxLinks: 1024, maxFileBytes: 1 << 30, maxTotalBytes: 2 ** 31 });
    expect(performance.now() - t2).toBeLessThan(200);
  });

  it("enforces the caps: entry count, one file's size, the total", () => {
    expect(refused(Array.from({ length: 101 }, (_x, i) => dir(`d${i}`)))).toContain("çok fazla");
    expect(refused(withExtra(file("Contents/big", { size: 1001 })))).toContain("dosya çok büyük");
    expect(refused(withExtra(file("Contents/b1", { size: 1000 }), file("Contents/b2", { size: 1000 })))).toContain("toplam");
  });

  it("an error names the rule and the record's index, never the record's content", () => {
    const message = refused(withExtra(file("../../Library/LaunchAgents/evil.plist")));
    expect(message).not.toContain("LaunchAgents");
    expect(message).toContain(`kayıt ${GOOD.length}`);
  });

  it("random lists never get through with a path or target that could leave the bundle", () => {
    const parts = ["Contents", "A", "a", "..", ".", "", "/", "\\", "x.txt", "İ", "\0", " ", "Resources", "MacOS"];
    let seed = 20261118;
    const rnd = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const path = (): string => Array.from({ length: 1 + rnd(4) }, () => parts[rnd(parts.length)]).join(rnd(8) === 0 ? "\\" : "/");
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      const list = Array.from({ length: 1 + rnd(6) }, () => {
        const kind = rnd(3);
        return kind === 0 ? dir(path()) : kind === 1 ? file(path()) : link(path(), path());
      });
      let ok: BundleEntry[];
      try {
        ok = check(list);
      } catch (err) {
        expect(err).toBeInstanceOf(BundleFormatError);
        continue;
      }
      accepted++;
      const seen = new Set<string>();
      for (const e of ok) {
        expect(e.path).toMatch(/^[A-Za-z0-9 ._+@()-]+(\/[A-Za-z0-9 ._+@()-]+)*$/);
        expect(e.path.split("/")).not.toContain("..");
        expect(e.path.split("/")).not.toContain(".");
        expect(seen.has(e.path.toLowerCase())).toBe(false);
        seen.add(e.path.toLowerCase());
        if (e.type === "symlink") {
          // Resolved lexically from the link's folder, the target never rises above the root.
          let depth = e.path.split("/").length - 1;
          for (const p of e.target.split("/")) {
            depth += p === ".." ? -1 : 1;
            expect(depth).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("isBundleName", () => {
  it("is one plain component ending in .app", () => {
    expect(isBundleName("Kokpit.app")).toBe(true);
    for (const bad of [".app", "Kokpit", "a/b.app", "../x.app", "Kökpit.app", "x.app/", ""]) expect(isBundleName(bad)).toBe(false);
  });
});
