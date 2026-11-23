// Yollar — local file paths a program printed in a terminal ("open ~/Documents/rapor/index.html"): how they are
// found in a line of text. Finding is text-only; whether a path exists and what it opens as is the engine's call.
import { describe, expect, it } from "vitest";
import { findPaths, isWebPagePath, PATH_LIMITS, pathExtension } from "./local-path.ts";

const pathsIn = (text: string): string[] => findPaths(text).map((p) => p.path);
const one = (text: string) => {
  const found = findPaths(text);
  expect(found, text).toHaveLength(1);
  return found[0]!;
};

describe("findPaths: the forms that are paths", () => {
  it.each([
    // The user's case: the last line of a Claude Code session.
    ["open ~/Documents/Acme-ux-2026-11-05/index.html", "~/Documents/Acme-ux-2026-11-05/index.html"],
    ["Görmek için: open ~/Documents/Acme-ux-2026-11-05/index.html", "~/Documents/Acme-ux-2026-11-05/index.html"],
    ["/Users/ada/proje/rapor/index.html", "/Users/ada/proje/rapor/index.html"],
    ["wrote ./dist/index.html (12 kB)", "./dist/index.html"],
    ["see ../ortak/logo.png", "../ortak/logo.png"],
    ["src/app/main.ts", "src/app/main.ts"],
    ["packages/app/src/renderer/ui/Rail.tsx değişti", "packages/app/src/renderer/ui/Rail.tsx"],
    ["$HOME/raporlar/a.pdf", "$HOME/raporlar/a.pdf"],
    ["~/notlar", "~/notlar"],
    ["/tmp/kokpit/çıktı.html hazır", "/tmp/kokpit/çıktı.html"],
    [".github/workflows/ci.yml", ".github/workflows/ci.yml"],
    ["app/[id]/page.tsx", "app/[id]/page.tsx"],
    ["app/(grup)/sayfa.tsx", "app/(grup)/sayfa.tsx"],
  ])("%s → %s", (text, path) => expect(pathsIn(text)).toEqual([path]));

  it("reports where the path is written, as written", () => {
    const text = "Rapor: open ~/Belgeler/a.html — bitti";
    const p = one(text);
    expect(text.slice(p.start, p.end)).toBe("~/Belgeler/a.html");
    expect(p.text).toBe("~/Belgeler/a.html");
    expect(p.open).toBe(true);
    expect(one("bak: ~/Belgeler/a.html").open).toBe(false);
  });

  it.each([
    ['open "~/Belgeler/Yeni Klasör/index.html"', "~/Belgeler/Yeni Klasör/index.html"],
    ["open '/Volumes/Main Disk/rapor/index.html'", "/Volumes/Main Disk/rapor/index.html"],
    ['"/Volumes/Main Disk/rapor/index.html" yazıldı', "/Volumes/Main Disk/rapor/index.html"],
    ["`./çıktı klasörü/a.png`", "./çıktı klasörü/a.png"],
    ['"docs/kabul testleri/rapor.md"', "docs/kabul testleri/rapor.md"],
    ["it's in '~/a b/c.html' now", "~/a b/c.html"],
    ["open ~/Yeni\\ Klasör/index.html", "~/Yeni Klasör/index.html"],
    ["open index.html", "index.html"],
    ["open rapor.htm", "rapor.htm"],
  ])("quotes, spaces and the open form: %s → %s", (text, path) => expect(pathsIn(text)).toEqual([path]));

  it("a quoted command line is not one path: the path inside it is found", () => {
    // What a shell echoes when a program is started with such an argument.
    expect(findPaths("node tui.mjs 'open ~/Documents/rapor/index.html' 'bkz. notlar/okuma.md dosyası'").map((p) => [p.path, p.open])).toEqual([
      ["~/Documents/rapor/index.html", true],
      ["notlar/okuma.md", false],
    ]);
    expect(pathsIn('"cd proje && cat src/a.ts"')).toEqual(["src/a.ts"]);
  });

  it("the range of a quoted path is the path, without its quotes", () => {
    const text = 'open "~/a b/index.html" ile';
    const p = one(text);
    expect(text.slice(p.start, p.end)).toBe("~/a b/index.html");
    expect(p.open).toBe(true);
  });

  it("an escaped space is part of the range and not of the path", () => {
    const text = "open ~/a\\ b/index.html";
    const p = one(text);
    expect(p.text).toBe("~/a\\ b/index.html");
    expect(p.path).toBe("~/a b/index.html");
  });

  it.each([
    ["Bitti: ~/rapor/index.html.", "~/rapor/index.html"],
    ["(bkz. src/a.ts)", "src/a.ts"],
    ["[src/a.ts]", "src/a.ts"],
    ["src/a.ts:12:5 hata", "src/a.ts"],
    ["~/a/b.html, ~/c/d.html; ve ./e/f.css!", "~/a/b.html|~/c/d.html|./e/f.css"],
    ["dosya: /tmp/x/y.txt?", "/tmp/x/y.txt"],
    ["«~/a/b.html»", "~/a/b.html"],
    ["│ ~/a/b.html │", "~/a/b.html"],
  ])("punctuation around a path stays outside: %s", (text, paths) => expect(pathsIn(text)).toEqual(paths.split("|")));

  it.each([
    ["打开~/报告/index.html查看", "~/报告/index.html"],
    ["レポートは/tmp/rapor/a.htmlです", "/tmp/rapor/a.html"],
    ["查看src/app.ts文件", "src/app.ts"],
    ["Çıktı şurada:~/çıktı/ölçüm.html", "~/çıktı/ölçüm.html"],
    ["Dosyayı açmak için ~/İş/Şema/göster.html yazın", "~/İş/Şema/göster.html"],
  ])("Turkish and CJK text around a path: %s → %s", (text, path) => expect(pathsIn(text)).toEqual([path]));

  it("offers the rest of the line for an unquoted path that may go on after a space", () => {
    // As text it is two things; the first carries what follows it, and the engine looks for the longer path.
    const p = findPaths("yazıldı: /Volumes/Main Disk/kokpit/docs/rapor.html (3 kB)")[0]!;
    expect(p.path).toBe("/Volumes/Main");
    expect(p.tail).toBe(" Disk/kokpit/docs/rapor.html (3 kB)");
    expect(one('"/Volumes/Main Disk/a.html" x').tail).toBe("");
    expect(one("~/a/b.html").tail).toBe("");
    expect(findPaths("/tmp/Yeni Klasör/a.html      ")[0]!.tail).toBe(" Klasör/a.html");
  });
});

describe("findPaths: what is not a path", () => {
  it.each([
    "",
    "merhaba dünya",
    "and/or, I/O, km/h, 10/12/2026, 1/2.5",
    "/help ve /compact komutları",
    "/",
    "~",
    "open the door",
    "open -a Safari index.html",
    "open -R",
    "C:\\Users\\ada\\rapor\\index.html",
    "C:/Users/ada/rapor/index.html",
    "\\\\sunucu\\paylasim\\a.html",
    "https://example.com/a/b/index.html",
    "http://localhost:3000/src/app.ts",
    "localhost:3000/a/b.html",
    "file:///Users/ada/a.html",
    "git@github.com:ada/repo.git",
    "s3://kova/anahtar.txt",
    "kullanici@example.com",
    "--config=/etc/x/y.conf",
    "PATH=/usr/local/bin:/usr/bin",
    "a//b",
    "100%/50%",
  ])("%j has none", (text) => expect(pathsIn(text)).toEqual([]));

  it("an address is never also a path, and a path next to an address is still found", () => {
    expect(pathsIn("http://localhost:5173/src/a.ts ve src/b.ts")).toEqual(["src/b.ts"]);
    expect(pathsIn("open https://example.com/index.html")).toEqual([]);
    expect(pathsIn("open http://localhost:3000")).toEqual([]);
  });

  it("option flags make it another command: nothing after `open -…` is taken as the open form", () => {
    const found = findPaths("open -a Safari ~/a/b.html");
    // The path itself is still a path; it is just not "what open would show".
    expect(found.map((p) => [p.path, p.open])).toEqual([["~/a/b.html", false]]);
  });

  it("control characters and overlong text never make a path", () => {
    // A terminal's text has no raw escape; if it had, the path ends before it.
    expect(pathsIn("~/a/\u001b[31mb.html")).toEqual(["~/a/"]);
    expect(pathsIn(`~/${"a".repeat(PATH_LIMITS.maxPathChars + 1)}`)).toEqual([]);
    // A direction-changing character is never inside a path: the text is cut there.
    expect(pathsIn('"~/a\u202e/b.html"')).toEqual(["~/a", "/b.html"]);
  });
});

describe("pathExtension / isWebPagePath", () => {
  it.each([
    ["~/a/index.html", "html"],
    ["/x/Y.HTM", "htm"],
    ["a/b.tar.gz", "gz"],
    ["a/.env", ""],
    ["a/b", ""],
    ["a.b/c", ""],
    ["a/b.", ""],
  ])("%s → %j", (path, ext) => expect(pathExtension(path)).toBe(ext));

  it("only .html and .htm are web pages", () => {
    expect(isWebPagePath("~/a/index.html")).toBe(true);
    expect(isWebPagePath("a/B.HTM")).toBe(true);
    expect(isWebPagePath("a/b.xhtml")).toBe(false);
    expect(isWebPagePath("a/html")).toBe(false);
    expect(isWebPagePath("a/b.html.txt")).toBe(false);
  });
});

describe("findPaths: maymun testi", () => {
  const PIECES = [
    "open ", "~/", "./", "../", "/", "$HOME/", "a", "b.html", "ç", "ğ", "İ", "报告", "です", " ", "  ", '"', "'", "`", "\\ ", "\\", ".", ",", ":", ";", "(", ")", "[", "]",
    "http://", "localhost:3000", "C:", "-a", "\t", "\u001b[0m", "\u202e", "│", "index", ".png", "/tmp/x", "src/a.ts", "\n", "%", "#", "@", "=", "?", "*", "!",
  ];
  // A small deterministic generator: the same lines on every run.
  let seed = 0x5eed;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  it("never throws; every range is the path as written; ranges are ordered and do not overlap", () => {
    for (let round = 0; round < 3000; round++) {
      let line = "";
      for (let i = next(24); i >= 0; i--) line += PIECES[next(PIECES.length)];
      const found = findPaths(line);
      let last = 0;
      for (const p of found) {
        expect(p.start, line).toBeGreaterThanOrEqual(last);
        expect(p.end, line).toBeGreaterThan(p.start);
        expect(line.slice(p.start, p.end), line).toBe(p.text);
        expect(p.path.length, line).toBeGreaterThan(0);
        expect(p.path.length, line).toBeLessThanOrEqual(PATH_LIMITS.maxPathChars);
        // Nothing a terminal could not show, and nothing that changes how the text reads.
        expect(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(p.path), JSON.stringify(line)).toBe(false);
        expect(line.slice(p.end).startsWith(p.tail), line).toBe(true);
        last = p.end;
      }
      expect(found.length).toBeLessThanOrEqual(PATH_LIMITS.maxPathsPerLine);
    }
  });

  it.each([null, undefined, 42, {}, []])("non-text input %j has no paths", (raw) => expect(findPaths(raw as unknown as string)).toEqual([]));

  it("looks at a bounded part of a very long line", () => {
    const line = `${"x ".repeat(PATH_LIMITS.maxLineChars)} ~/a/b.html`;
    expect(findPaths(line)).toEqual([]);
  });
});
