import { describe, expect, it } from "vitest";
import { catalogProblems, LOCALES } from "./core.ts";
import { engineParts, sharedEn, sharedTr } from "./catalog.ts";

describe("shared catalogs", () => {
  it("tr has exactly the keys and placeholders of en", () => {
    expect(catalogProblems(sharedEn, sharedTr)).toEqual([]);
  });

  it("the engine catalog's two files never share a top-level key", () => {
    for (const locale of LOCALES) {
      const [a, b] = engineParts[locale];
      const overlap = Object.keys(a).filter((k) => Object.prototype.hasOwnProperty.call(b, k));
      expect(overlap, locale).toEqual([]);
    }
  });
});
