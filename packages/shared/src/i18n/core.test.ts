import { describe, expect, it } from "vitest";
import {
  catalogProblems,
  DEFAULT_LOCALE,
  getLocale,
  intlTag,
  isLocale,
  LOCALES,
  onLocaleChange,
  placeholders,
  leafKeys,
  setLocale,
  translate,
  type Catalog,
} from "./core.ts";

const en: Catalog = {
  hello: "Hello {name}",
  nested: { deep: "Deep" },
  terminals: { count_one: "{count} terminal", count_other: "{count} terminals", count_zero: "No terminals" },
};
const tr: Catalog = {
  hello: "Merhaba {name}",
  nested: { deep: "Derin" },
  terminals: { count_one: "{count} terminal", count_other: "{count} terminal", count_zero: "Terminal yok" },
};

describe("i18n core", () => {
  it("knows its locales and default", () => {
    expect(LOCALES).toEqual(["en", "tr"]);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("tr")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale({})).toBe(false);
    expect(isLocale(DEFAULT_LOCALE)).toBe(true);
    expect(intlTag("tr")).toMatch(/^tr/);
    expect(intlTag("en")).toMatch(/^en/);
  });

  it("looks up dotted keys and fills {params}", () => {
    expect(translate(en, "en", "hello", { name: "Ada" })).toBe("Hello Ada");
    expect(translate(tr, "tr", "nested.deep")).toBe("Derin");
  });

  it("leaves an unknown placeholder visible and ignores extra params", () => {
    expect(translate(en, "en", "hello")).toBe("Hello {name}");
    expect(translate(en, "en", "nested.deep", { x: 1 })).toBe("Deep");
  });

  it("returns undefined for a missing key, a branch, or a hostile key", () => {
    expect(translate(en, "en", "nope")).toBeUndefined();
    expect(translate(en, "en", "nested")).toBeUndefined();
    expect(translate(en, "en", "__proto__")).toBeUndefined();
    expect(translate(en, "en", "constructor.name")).toBeUndefined();
    expect(translate(en, "en", "hello.toString")).toBeUndefined();
    expect(translate(en, "en", "")).toBeUndefined();
  });

  it("selects plural forms with Intl.PluralRules (and an explicit zero)", () => {
    expect(translate(en, "en", "terminals.count", { count: 1 })).toBe("1 terminal");
    expect(translate(en, "en", "terminals.count", { count: 3 })).toBe("3 terminals");
    expect(translate(en, "en", "terminals.count", { count: 0 })).toBe("No terminals");
    expect(translate(tr, "tr", "terminals.count", { count: 3 })).toBe("3 terminal");
    // No count: the "other" form.
    expect(translate(en, "en", "terminals.count")).toBe("{count} terminals");
  });

  it("does not interpret replacement patterns in params", () => {
    expect(translate(en, "en", "hello", { name: "$& $1 {name}" })).toBe("Hello $& $1 {name}");
  });

  it("lists placeholders and leaf keys", () => {
    expect(placeholders("a {x} b {y} {x}")).toEqual(["x", "y"]);
    expect(placeholders("none")).toEqual([]);
    expect(leafKeys(en)).toEqual(["hello", "nested.deep", "terminals.count_one", "terminals.count_other", "terminals.count_zero"]);
  });

  it("keeps one current locale per process and tells listeners", () => {
    const before = getLocale();
    const seen: string[] = [];
    const off = onLocaleChange(() => seen.push(getLocale()));
    setLocale("en");
    setLocale("tr");
    setLocale("tr"); // no change, no event
    off();
    setLocale("en");
    expect(seen).toEqual(before === "en" ? ["tr"] : ["en", "tr"]);
    expect(() => setLocale("xx" as never)).toThrow();
    setLocale(before);
  });
});

describe("catalogProblems", () => {
  it("is empty for catalogs in parity", () => {
    expect(catalogProblems(en, tr)).toEqual([]);
  });
  it("names missing, extra and placeholder differences", () => {
    const other: Catalog = { hello: "Merhaba {who}", nested: {}, extra: "x", terminals: tr.terminals! };
    expect(catalogProblems(en, other)).toEqual(["missing: nested.deep", "extra: extra", "placeholders differ: hello {name} vs {who}"]);
  });
});
