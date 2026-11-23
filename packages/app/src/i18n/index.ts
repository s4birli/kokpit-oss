// i18n of the app (main process and renderer alike): `t(key, params)` over the app's catalogs in the process's
// current locale, a React hook that re-renders on a switch, Intl formatting in the active locale, and the
// renderer's link to the language setting main keeps (LanguageBridge).
//
//   const t = useT();                      // in a component: re-renders when the language changes
//   t("settings.language.title")
//   t("terminal.count", { count: 3 })      // plural forms count_one / count_other
//
// Outside components, the module-level `t` reads the current locale at call time.
import { useMemo, useSyncExternalStore } from "react";
import { createTranslator, getLocale, intlTag, isLocale, onLocaleChange, setLocale, type Locale, type Params } from "@kokpit/shared/i18n";
import type { LanguageBridge } from "../renderer/engine/i18n-ipc.ts";
import { appEn, appTr, type MessageKey } from "./catalog.ts";

export type { Locale, Params } from "@kokpit/shared/i18n";
export type { MessageKey } from "./catalog.ts";
export { getLocale, isLocale, LOCALES, localeName, onLocaleChange } from "@kokpit/shared/i18n";

const translator = createTranslator({ en: appEn, tr: appTr });

export type Translate = (key: MessageKey, params?: Params) => string;

/** The text of `key` in the current locale. */
export const t: Translate = (key, params) => translator(key, params);

/** For keys that arrive at runtime (an engine error's key): undefined when this build has no such text. */
export function maybeT(key: string, params?: Params): string | undefined {
  return translator.maybe(key, params);
}

/** An engine error's text: its key translated when this build knows it, else the engine's own message. */
export function translateErrorText(e: { key?: string; params?: Params; message: string }): string {
  return (e.key !== undefined ? maybeT(e.key, e.params) : undefined) ?? e.message;
}

/** The current locale, re-rendering the component when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

/** `t` bound to the current locale; a new function after each switch, so memoized values recompute. */
export function useT(): Translate {
  const locale = useLocale();
  return useMemo<Translate>(() => (key, params) => translator.in(locale, key, params), [locale]);
}

// ---------- Intl in the active locale ----------

/** BCP 47 tag of the current locale, for Intl and toLocale*String. */
export function intlLocale(locale: Locale = getLocale()): string {
  return intlTag(locale);
}

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(), options).format(n);
}

export function formatDateTime(d: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(), options).format(d);
}

// ---------- the language setting (renderer) ----------

let bridge: LanguageBridge | undefined;
let unsubscribe: (() => void) | undefined;

/**
 * Connects the renderer to main's language setting: applies the window's starting language and every change main
 * announces. `undefined` disconnects (tests).
 */
export function installLanguageBridge(next: LanguageBridge | undefined): void {
  unsubscribe?.();
  unsubscribe = undefined;
  bridge = next;
  if (!next) return;
  if (isLocale(next.initial)) setLocale(next.initial);
  unsubscribe = next.onChanged((locale) => {
    if (isLocale(locale)) setLocale(locale);
  });
}

/** Switches the language now and asks main to keep it (per machine). */
export async function setLanguage(locale: Locale): Promise<void> {
  if (!isLocale(locale)) throw new Error(`unsupported language: ${String(locale)}`);
  setLocale(locale);
  await bridge?.set(locale);
}
