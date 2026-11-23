// Internationalisation core, shared by the engine, the app's main process and its renderer: the supported locales,
// the process's current locale, and a tiny translator over JSON catalogs.
//
// Catalog format: nested JSON objects whose leaves are strings. A key is the dotted path to a leaf
// ("settings.language.title"). `{name}` in a string is replaced by the param `name`. Plural forms are sibling leaves
// with a CLDR suffix (`count_one`, `count_other`, optionally `count_zero` for an explicit zero): `t("x.count",
// { count })` picks one with Intl.PluralRules of the locale, falling back to `_other`.
import defaults from "./i18n.defaults.json" with { type: "json" };

export const LOCALES = ["en", "tr"] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

if (defaults.locales.length !== LOCALES.length || !defaults.locales.every(isLocale)) throw new Error("i18n.defaults.json: locales differ from LOCALES");
if (!isLocale(defaults.defaultLocale)) throw new Error("i18n.defaults.json: defaultLocale is not a supported locale");

/** The locale a process starts in when nothing (config, the user's choice) says otherwise. */
export const DEFAULT_LOCALE = defaults.defaultLocale as Locale;

/** BCP 47 tag for Intl (dates, numbers, plural rules) of a locale. */
export function intlTag(locale: Locale): string {
  return defaults.intlTags[locale];
}

/** A locale's own name ("Türkçe"), as shown in a language picker. */
export function localeName(locale: Locale): string {
  return defaults.names[locale];
}

export type Catalog = { readonly [key: string]: string | Catalog };
export type Params = Readonly<Record<string, string | number>>;

export const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"] as const;
type PluralSuffix = (typeof PLURAL_SUFFIXES)[number];
type StripPlural<K extends string> = K extends `${infer Base}_${PluralSuffix}` ? Base : K;

/** Every key of a catalog type, plural leaves folded into their base ("count_one" | "count_other" → "count"). */
export type KeysOf<T> = {
  [K in keyof T & string]: T[K] extends string ? StripPlural<K> : `${K}.${KeysOf<T[K]>}`;
}[keyof T & string];

// ---------- the process's current locale ----------

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/** Switches the process's locale; listeners run only on a real change. */
export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) throw new Error(`unsupported locale: ${String(locale)}`);
  if (locale === current) return;
  current = locale;
  for (const l of [...listeners]) l();
}

/** Subscribes to locale changes; returns the unsubscribe function (fits React's useSyncExternalStore). */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------- lookup ----------

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function node(catalog: Catalog, path: readonly string[]): string | Catalog | undefined {
  let at: string | Catalog = catalog;
  for (const part of path) {
    if (typeof at === "string" || !own(at, part)) return undefined;
    at = at[part]!;
  }
  return at;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
function pluralOf(locale: Locale, count: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(intlTag(locale))));
  return rules.select(count);
}

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(text: string, params: Params | undefined): string {
  if (!params) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => (own(params, name) ? String(params[name]) : whole));
}

/**
 * The text of `key` in `catalog` (of `locale`), params filled in; undefined when the catalog has no such leaf.
 * A key that names a plural group picks the form for `params.count`.
 */
export function translate(catalog: Catalog, locale: Locale, key: string, params?: Params): string | undefined {
  if (key === "") return undefined;
  const path = key.split(".");
  const leaf = node(catalog, path);
  if (typeof leaf === "string") return fill(leaf, params);
  if (leaf !== undefined) return undefined;
  const parent = node(catalog, path.slice(0, -1));
  if (parent === undefined || typeof parent === "string") return undefined;
  const base = path[path.length - 1]!;
  const count = params?.count;
  const forms: string[] = [];
  if (typeof count === "number") {
    if (count === 0) forms.push(`${base}_zero`);
    forms.push(`${base}_${pluralOf(locale, count)}`);
  }
  forms.push(`${base}_other`);
  for (const f of forms) {
    if (own(parent, f) && typeof parent[f] === "string") return fill(parent[f], params);
  }
  return undefined;
}

/** The distinct `{name}` placeholders of a text, in order of first use. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Every leaf key of a catalog, dotted, plural suffixes kept, sorted. */
export function leafKeys(catalog: Catalog, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(catalog)) {
    const key = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "string") out.push(key);
    else out.push(...leafKeys(v, key));
  }
  return out.sort();
}

/** The leaf at a dotted key (plural suffix included), or undefined. */
export function leafAt(catalog: Catalog, key: string): string | undefined {
  const v = node(catalog, key.split("."));
  return typeof v === "string" ? v : undefined;
}

/** A translator bound to catalogs per locale and the process's current locale; typed by the English catalog. */
export interface Translator<C> {
  (key: KeysOf<C>, params?: Params): string;
  /** For keys that arrive at runtime (an engine error's key): undefined when unknown. */
  maybe(key: string, params?: Params): string | undefined;
  /** The same, in a given locale. */
  in(locale: Locale, key: KeysOf<C>, params?: Params): string;
}

export function createTranslator<C extends Catalog>(catalogs: Readonly<Record<Locale, C>>): Translator<C> {
  const lookup = (locale: Locale, key: string, params?: Params): string | undefined =>
    translate(catalogs[locale], locale, key, params) ?? translate(catalogs[DEFAULT_LOCALE], DEFAULT_LOCALE, key, params);
  // A key the type system accepted but no catalog holds (a bad cast) shows itself rather than nothing.
  const t = ((key: string, params?: Params) => lookup(current, key, params) ?? key) as unknown as Translator<C>;
  t.maybe = (key, params) => lookup(current, key, params);
  t.in = (locale, key, params) => lookup(locale, key as string, params) ?? (key as string);
  return t;
}

/**
 * Differences between two catalogs that must hold the same texts: keys only in one of them, and keys whose
 * `{placeholders}` differ. Empty = in parity.
 */
export function catalogProblems(reference: Catalog, other: Catalog): string[] {
  const a = leafKeys(reference);
  const b = leafKeys(other);
  const inA = new Set(a);
  const inB = new Set(b);
  const problems = [...a.filter((k) => !inB.has(k)).map((k) => `missing: ${k}`), ...b.filter((k) => !inA.has(k)).map((k) => `extra: ${k}`)];
  for (const k of a) {
    if (!inB.has(k)) continue;
    const pa = placeholders(leafAt(reference, k)!).sort().join(",");
    const pb = placeholders(leafAt(other, k)!).sort().join(",");
    if (pa !== pb) problems.push(`placeholders differ: ${k} {${pa}} vs {${pb}}`);
  }
  return problems;
}
