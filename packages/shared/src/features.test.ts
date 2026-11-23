import { describe, expect, it } from "vitest";
import { BUILD_FEATURES, createFeatureSet, featuresFromEnv, FEATURES_ENV, parseFeatureFile } from "./features.ts";

const FILE = {
  features: {
    alpha: { enabled: true, methodPrefixes: ["alpha."] },
    beta: { enabled: true, methodPrefixes: ["beta.", "betaExtra."], requires: ["alpha"] },
    gamma: { enabled: false, methodPrefixes: ["gamma."] },
  },
};

describe("feature set", () => {
  it("knows which features are on, off and unknown (unknown = off)", () => {
    const f = createFeatureSet(parseFeatureFile(FILE));
    expect(f.isEnabled("alpha")).toBe(true);
    expect(f.isEnabled("gamma")).toBe(false);
    expect(f.isEnabled("nope")).toBe(false);
    expect(f.enabled()).toEqual(["alpha", "beta"]);
    expect(f.known()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("maps a method to the feature owning it by prefix; core methods belong to none", () => {
    const f = createFeatureSet(parseFeatureFile(FILE));
    expect(f.featureOfMethod("alpha.info")).toBe("alpha");
    expect(f.featureOfMethod("betaExtra.x")).toBe("beta");
    expect(f.featureOfMethod("projects.list")).toBeUndefined();
    expect(f.isMethodEnabled("projects.list")).toBe(true);
    expect(f.isMethodEnabled("alpha.info")).toBe(true);
    expect(f.isMethodEnabled("gamma.info")).toBe(false);
  });

  it("an empty feature file (the public edition) has every method of the core and no feature", () => {
    const f = createFeatureSet(parseFeatureFile({ features: {} }));
    expect(f.enabled()).toEqual([]);
    expect(f.isMethodEnabled("projects.list")).toBe(true);
  });

  it("refuses a feature that is on while one it requires is off", () => {
    const file = parseFeatureFile({ features: { ...FILE.features, alpha: { enabled: false, methodPrefixes: ["alpha."] } } });
    expect(() => createFeatureSet(file)).toThrow(/beta.*alpha/);
  });

  it("refuses a malformed file (unknown key, bad prefix, requirement on an unknown feature)", () => {
    expect(() => parseFeatureFile({ features: { a: { enabled: true, extra: 1 } } })).toThrow();
    expect(() => parseFeatureFile({ features: { a: { enabled: true, methodPrefixes: [""] } } })).toThrow();
    expect(() => parseFeatureFile({ features: { a: { enabled: "yes" } } })).toThrow();
    expect(() => createFeatureSet(parseFeatureFile({ features: { a: { enabled: true, requires: ["zzz"] } } }))).toThrow(/zzz/);
    expect(() => parseFeatureFile(null)).toThrow();
  });

  it("the same prefix may not belong to two features", () => {
    expect(() =>
      createFeatureSet(parseFeatureFile({ features: { a: { enabled: true, methodPrefixes: ["x."] }, b: { enabled: true, methodPrefixes: ["x."] } } })),
    ).toThrow(/x\./);
  });
});

describe(`${FEATURES_ENV} override`, () => {
  const file = parseFeatureFile(FILE);

  it("absent → the file's own choice", () => {
    expect(featuresFromEnv(file, {}).enabled()).toEqual(["alpha", "beta"]);
  });

  it("a comma list → exactly those features on, the rest off", () => {
    expect(featuresFromEnv(file, { [FEATURES_ENV]: "alpha, gamma" }).enabled()).toEqual(["alpha", "gamma"]);
  });

  it("empty → every feature off (the public edition's behaviour)", () => {
    const f = featuresFromEnv(file, { [FEATURES_ENV]: "" });
    expect(f.enabled()).toEqual([]);
    expect(f.isMethodEnabled("alpha.info")).toBe(false);
  });

  it("an unknown name or a broken requirement is an error, never silently ignored", () => {
    expect(() => featuresFromEnv(file, { [FEATURES_ENV]: "alpha,typo" })).toThrow(/typo/);
    expect(() => featuresFromEnv(file, { [FEATURES_ENV]: "beta" })).toThrow(/alpha/);
  });
});

describe("the build's feature file", () => {
  it("parses and is internally consistent", () => {
    expect(() => BUILD_FEATURES.enabled()).not.toThrow();
    for (const id of BUILD_FEATURES.enabled()) expect(BUILD_FEATURES.isEnabled(id)).toBe(true);
  });
});
