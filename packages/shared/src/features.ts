// Optional feature modules: which are built in and on, and which request methods each one owns.
//
// The list lives in `kokpit.features.json` at the repository root — never in code — so a build that leaves a module
// out (the public edition ships `{ "features": {} }`) names nothing about it. Code of a module asks
// `isEnabled("<id>")`; the engine answers UNKNOWN_METHOD for a method whose owning feature is off.
import { z } from "zod";
import buildFile from "../../../kokpit.features.json" with { type: "json" };

/** Engine-only run-time override: comma list of the features to turn on (others off); empty = none. */
export const FEATURES_ENV = "KOKPIT_FEATURES";

const FeatureId = z.string().regex(/^[a-z][a-z0-9-]*$/, "feature id: lower-case letters, digits, dashes");
const FeatureSpecSchema = z
  .object({
    enabled: z.boolean(),
    methodPrefixes: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*\.$/, "method prefix like `name.`")).optional(),
    requires: z.array(FeatureId).optional(),
  })
  .strict();
const FeatureFileSchema = z.object({ $comment: z.string().optional(), features: z.record(FeatureId, FeatureSpecSchema) }).strict();

export type FeatureSpec = z.infer<typeof FeatureSpecSchema>;
export type FeatureFile = z.infer<typeof FeatureFileSchema>;

export interface FeatureSet {
  isEnabled(id: string): boolean;
  /** Enabled feature ids, in file order. */
  enabled(): string[];
  /** Every feature the build knows, enabled or not, in file order. */
  known(): string[];
  /** The feature owning a request method (by prefix), or undefined for a core method. */
  featureOfMethod(method: string): string | undefined;
  /** False only for a method owned by a feature that is off. */
  isMethodEnabled(method: string): boolean;
}

export function parseFeatureFile(raw: unknown): FeatureFile {
  const parsed = FeatureFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`feature file: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function createFeatureSet(file: FeatureFile): FeatureSet {
  const entries = Object.entries(file.features);
  const ids = entries.map(([id]) => id);
  const on = new Set(entries.filter(([, spec]) => spec.enabled).map(([id]) => id));
  const owner = new Map<string, string>();
  for (const [id, spec] of entries) {
    for (const prefix of spec.methodPrefixes ?? []) {
      const prev = owner.get(prefix);
      if (prev !== undefined) throw new Error(`feature file: method prefix ${prefix} belongs to both ${prev} and ${id}`);
      owner.set(prefix, id);
    }
    for (const need of spec.requires ?? []) {
      if (!ids.includes(need)) throw new Error(`feature file: ${id} requires unknown feature ${need}`);
      if (on.has(id) && !on.has(need)) throw new Error(`feature ${id} is on but requires ${need}, which is off`);
    }
  }
  const featureOfMethod = (method: string): string | undefined => {
    for (const [prefix, id] of owner) if (method.startsWith(prefix)) return id;
    return undefined;
  };
  return {
    isEnabled: (id) => on.has(id),
    enabled: () => ids.filter((id) => on.has(id)),
    known: () => [...ids],
    featureOfMethod,
    isMethodEnabled: (method) => {
      const id = featureOfMethod(method);
      return id === undefined || on.has(id);
    },
  };
}

/** The file's feature set, narrowed by `KOKPIT_FEATURES` when that is set (unknown names are an error). */
export function featuresFromEnv(file: FeatureFile, env: Record<string, string | undefined>): FeatureSet {
  const raw = env[FEATURES_ENV];
  if (raw === undefined) return createFeatureSet(file);
  const wanted = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const unknown = wanted.filter((id) => !(id in file.features));
  if (unknown.length > 0) throw new Error(`${FEATURES_ENV}: unknown feature ${unknown.join(", ")}`);
  const features = Object.fromEntries(Object.entries(file.features).map(([id, spec]) => [id, { ...spec, enabled: wanted.includes(id) }]));
  return createFeatureSet({ features });
}

/** The parsed build-time feature file (`kokpit.features.json`). */
export const BUILD_FEATURE_FILE: FeatureFile = parseFeatureFile(buildFile);
/** The build-time feature set — what the app was built with; the engine may narrow it with `KOKPIT_FEATURES`. */
export const BUILD_FEATURES: FeatureSet = createFeatureSet(BUILD_FEATURE_FILE);
