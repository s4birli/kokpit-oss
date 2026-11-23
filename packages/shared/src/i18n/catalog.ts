// The catalogs of text produced outside the app's own UI: by the engine (`engine.*`, sent as an error's
// key + params, or written by the engine in its configured language) and by the shared protocol's validation
// (`validation.*`, zod messages evaluated when a check fails, in the process's current locale).
// The app merges these into its own catalogs, so one key has one translation everywhere.
//
// `engine.*` is kept in two files (engine-a: modules a–l, engine-b: m–z and handlers/) so their sub-keys
// (engine.<module>.*) can be edited apart; their top-level keys must not overlap (catalog.test.ts).
import { createTranslator, type KeysOf } from "./core.ts";
import engineAEn from "./locales/en/engine-a.json" with { type: "json" };
import engineATr from "./locales/tr/engine-a.json" with { type: "json" };
import engineBEn from "./locales/en/engine-b.json" with { type: "json" };
import engineBTr from "./locales/tr/engine-b.json" with { type: "json" };
import validationEn from "./locales/en/validation.json" with { type: "json" };
import validationTr from "./locales/tr/validation.json" with { type: "json" };

/** The engine catalog's two files, per locale (for the overlap check). */
export const engineParts = { en: [engineAEn, engineBEn], tr: [engineATr, engineBTr] } as const;

/** English is the reference: every other locale must have exactly its keys (a missing one fails typecheck here). */
export const sharedEn = { engine: { ...engineAEn, ...engineBEn }, validation: validationEn };
export const sharedTr: typeof sharedEn = { engine: { ...engineATr, ...engineBTr }, validation: validationTr };

export type SharedKey = KeysOf<typeof sharedEn>;

/** Shared texts in the process's current locale (`setLocale`). */
export const st = createTranslator({ en: sharedEn, tr: sharedTr });
