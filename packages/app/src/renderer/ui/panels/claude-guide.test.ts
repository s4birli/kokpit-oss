// İş C (Adım 8) — the Rehber data shipped with the app and the search shared by every Claude panel tab.
import { describe, expect, it } from "vitest";
import { claudeGuide, filterGuide, foldSearch, matches, parseGuide } from "./claude-guide.ts";

describe("Claude rehberi verisi", () => {
  it("is valid, names its CLI version and has the three sections", () => {
    expect(claudeGuide().cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(claudeGuide().sections.map((s) => s.id)).toEqual(["slash", "flags", "subcommands"]);
    for (const s of claudeGuide().sections) {
      expect(s.entries.length).toBeGreaterThan(5);
      const names = s.entries.map((e) => e.name);
      expect(new Set(names).size).toBe(names.length);
      for (const e of s.entries) expect(e.description.trim()).not.toBe("");
    }
    const slash = claudeGuide().sections[0]!.entries.map((e) => e.name);
    for (const n of ["/help", "/clear", "/compact", "/model", "/init", "/resume"]) expect(slash).toContain(n);
    expect(slash.every((n) => n.startsWith("/"))).toBe(true);
    const flags = claudeGuide().sections[1]!.entries.map((e) => e.name);
    expect(flags.every((n) => n.startsWith("-"))).toBe(true);
  });

  it("has every text in English too, with the same commands", () => {
    const en = claudeGuide("en");
    const tr = claudeGuide("tr");
    expect(en.sections.map((s) => [s.id, s.entries.length])).toEqual(tr.sections.map((s) => [s.id, s.entries.length]));
    const texts = [en.source, ...en.sections.flatMap((s) => [s.title, ...s.entries.flatMap((e) => [e.name, e.description])])];
    for (const x of texts) expect(x).not.toMatch(/[çğıöşüİÇĞÖŞÜ]/);
    en.sections.forEach((s, i) => s.entries.forEach((e, j) => expect(e.name.split(" ")[0]).toBe(tr.sections[i]!.entries[j]!.name.split(" ")[0])));
  });

  it("rejects malformed guide data", () => {
    expect(() => parseGuide({})).toThrow();
    expect(() => parseGuide({ cliVersion: "1.0.0", source: "x", sections: [{ id: "a", title: "A", entries: [{ name: 1 }] }] })).toThrow();
    expect(() => parseGuide({ cliVersion: "1.0.0", source: { en: "x" }, sections: [] })).toThrow();
  });
});

describe("arama", () => {
  it("folds case, Turkish letters and diacritics", () => {
    expect(foldSearch("İZİN Şema ĞÜÇ ı")).toBe(foldSearch("izin sema guc i"));
    expect(matches(["Konuşmayı temizler"], "TEMİZ")).toBe(true);
    expect(matches(["/clear"], "")).toBe(true);
    expect(matches(["/clear", "Konuşmayı temizler"], "model")).toBe(false);
  });

  it("every word must match somewhere", () => {
    expect(matches(["--model <model>", "Oturumun modeli"], "model oturum")).toBe(true);
    expect(matches(["--model <model>", "Oturumun modeli"], "model izin")).toBe(false);
  });

  it("filters sections and drops empty ones", () => {
    const r = filterGuide(claudeGuide(), "worktree");
    expect(r.map((s) => s.id)).toEqual(["flags", "subcommands"]);
    expect(r.flatMap((s) => s.entries).every((e) => /worktree/i.test(e.name + e.description))).toBe(true);
    expect(filterGuide(claudeGuide(), "")).toHaveLength(3);
    expect(filterGuide(claudeGuide(), "qqqzzz")).toEqual([]);
  });

  it("monkey: odd queries never throw", () => {
    for (const q of ["(", "[", "\\", "*", "?", "$^", "\u0000", "🙂", " ".repeat(500), "a".repeat(10_000)]) {
      expect(() => filterGuide(claudeGuide(), q)).not.toThrow();
    }
  });
});
