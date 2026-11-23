// İş C (Adım 8) — Rehber: Claude Code slash commands, CLI flags and subcommands with Turkish descriptions, shipped
// as data (claude-guide.json, curated from `claude --help` of `cliVersion`), plus the search every Claude tab uses.
import { getLocale, LOCALES, type Locale } from "../../../i18n/index.ts";
import raw from "./claude-guide.json" with { type: "json" };

export interface GuideEntry {
  name: string;
  description: string;
}
export interface GuideSection {
  id: string;
  title: string;
  entries: GuideEntry[];
}
export interface ClaudeGuide {
  /** `claude --version` the data was taken from. */
  cliVersion: string;
  source: string;
  sections: GuideSection[];
}

/** A text of the data: one string for every language (command names), or one per language. */
export type GuideText = string | Readonly<Record<Locale, string>>;
export interface LocalizedGuide {
  cliVersion: string;
  source: GuideText;
  sections: { id: string; title: GuideText; entries: { name: GuideText; description: GuideText }[] }[];
}

const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`claude-guide: ${what} metin olmalı`);
  return v;
};
/** A plain text, or an object with a non-empty text for every language. */
const localized = (v: unknown, what: string): GuideText => {
  if (typeof v === "string") return text(v, what);
  const o = obj(v, what);
  const out = {} as Record<Locale, string>;
  for (const l of LOCALES) out[l] = text(o[l], `${what}.${l}`);
  return out;
};
const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`claude-guide: ${what} liste olmalı`);
  return v;
};
const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`claude-guide: ${what} nesne olmalı`);
  return v as Record<string, unknown>;
};

/** Validates guide data (throws on anything malformed). */
export function parseGuide(data: unknown): LocalizedGuide {
  const g = obj(data, "kök");
  return {
    cliVersion: text(g.cliVersion, "cliVersion"),
    source: localized(g.source, "source"),
    sections: list(g.sections, "sections").map((sv, i) => {
      const s = obj(sv, `sections[${i}]`);
      return {
        id: text(s.id, "id"),
        title: localized(s.title, "title"),
        entries: list(s.entries, "entries").map((ev, j) => {
          const e = obj(ev, `entries[${j}]`);
          return { name: localized(e.name, "name"), description: localized(e.description, "description") };
        }),
      };
    }),
  };
}

const GUIDE: LocalizedGuide = parseGuide(raw);

const pick = (v: GuideText, locale: Locale): string => (typeof v === "string" ? v : v[locale]);

/** The guide in one language. */
export function localizeGuide(guide: LocalizedGuide, locale: Locale): ClaudeGuide {
  return {
    cliVersion: guide.cliVersion,
    source: pick(guide.source, locale),
    sections: guide.sections.map((s) => ({
      id: s.id,
      title: pick(s.title, locale),
      entries: s.entries.map((e) => ({ name: pick(e.name, locale), description: pick(e.description, locale) })),
    })),
  };
}

const byLocale = new Map<Locale, ClaudeGuide>();
/** The shipped guide in `locale` (default: the app's language). */
export function claudeGuide(locale: Locale = getLocale()): ClaudeGuide {
  let g = byLocale.get(locale);
  if (!g) byLocale.set(locale, (g = localizeGuide(GUIDE, locale)));
  return g;
}

/** Lower case without diacritics; Turkish dotted/dotless i both become "i". */
export function foldSearch(s: string): string {
  return s
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .replace(/ı/g, "i")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** True when every word of `query` occurs in one of `fields`. An empty query matches everything. */
export function matches(fields: readonly (string | undefined)[], query: string): boolean {
  const words = foldSearch(query).split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return true;
  const hay = foldSearch(fields.filter((f): f is string => f !== undefined).join("\n"));
  return words.every((w) => hay.includes(w));
}

export function filterGuide(guide: ClaudeGuide, query: string): GuideSection[] {
  return guide.sections
    .map((s) => ({ ...s, entries: s.entries.filter((e) => matches([e.name, e.description], query)) }))
    .filter((s) => s.entries.length > 0);
}
