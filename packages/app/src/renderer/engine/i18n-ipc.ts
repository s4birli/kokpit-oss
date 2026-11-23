// i18n: contract between Electron main (the language setting, per machine, in userData), the preload and the
// renderer. Main owns the choice: the renderer asks to change it, main stores it, switches its own menus and
// dialogs, and tells every window.
import type { Locale } from "@kokpit/shared/i18n";

export const I18N_IPC = {
  /** renderer → main: store and apply a language (validated in main). */
  set: "i18n:set",
  /** main → renderer event: the language now in force. */
  changed: "i18n:changed",
} as const;

/** The window's starting language travels as a process argument, so the first paint is already in it. */
export const LANGUAGE_ARG_PREFIX = "--kokpit-language=";

export interface LanguageBridge {
  /** The language the window was opened in. */
  readonly initial: Locale;
  set(locale: Locale): Promise<void>;
  /** Returns the unsubscribe function. */
  onChanged(listener: (locale: Locale) => void): () => void;
}
