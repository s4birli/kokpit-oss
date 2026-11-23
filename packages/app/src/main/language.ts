// i18n: the app's language setting — per machine, a small JSON file in userData. Untrusted input from IPC: only a
// supported locale is ever stored.
import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@kokpit/shared/i18n";

/**
 * Test-only: the default language of an unpackaged run (the e2e suite runs the private, Turkish configuration;
 * the English smoke test asks for "en"). Ignored by a packaged app.
 */
export const LANGUAGE_TEST_ENV = "KOKPIT_TEST_LANGUAGE";

const FILE_MODE = 0o600;
/** The file holds one short field; anything bigger is not ours. */
const MAX_FILE_BYTES = 1024;

/** Set by electron.vite.config.ts from env KOKPIT_DEFAULT_LANGUAGE at build time (deploy:local: engine.json `language`). */
declare const __KOKPIT_DEFAULT_LANGUAGE__: string | undefined;

/** The build's default language ("" when the build named none). */
export const COMPILED_LANGUAGE: string = typeof __KOKPIT_DEFAULT_LANGUAGE__ !== "undefined" ? __KOKPIT_DEFAULT_LANGUAGE__ : "";

/** The language used until the user picks one: the test switch (unpackaged), else the build's, else the shared default. */
export function defaultLanguage(o: { compiled: string; env: NodeJS.ProcessEnv; isPackaged: boolean }): Locale {
  const test = o.isPackaged ? undefined : o.env[LANGUAGE_TEST_ENV];
  if (isLocale(test)) return test;
  return isLocale(o.compiled) ? o.compiled : DEFAULT_LOCALE;
}

export interface LanguageStore {
  /** The stored choice, or the fallback when there is none (or it is unreadable). Synchronous: needed before the menu and window. */
  load(): Locale;
  /** Throws for anything but a supported locale. */
  save(input: unknown): Promise<void>;
}

export class LanguageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguageError";
  }
}

export function createLanguageStore({ filePath, fallback }: { filePath: string; fallback: Locale }): LanguageStore {
  return {
    load() {
      try {
        if (statSync(filePath).size > MAX_FILE_BYTES) return fallback;
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
        const language = Object.prototype.hasOwnProperty.call(parsed, "language") ? (parsed as { language: unknown }).language : undefined;
        return isLocale(language) ? language : fallback;
      } catch {
        return fallback;
      }
    },

    async save(input) {
      if (!isLocale(input)) throw new LanguageError(`unsupported language`);
      await mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ language: input }), { mode: FILE_MODE });
      await rename(tmp, filePath);
    },
  };
}
