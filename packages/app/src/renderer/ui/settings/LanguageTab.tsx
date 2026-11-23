// i18n: Ayarlar › Dil — the app's language on this machine. Applies at once (every open screen re-renders) and is
// kept by main in userData; each language is listed by its own name.
import { useState } from "react";
import { LOCALES, localeName, setLanguage, useLocale, useT, type Locale } from "../../../i18n/index.ts";
import { ErrorText, SelectField } from "./parts.tsx";

export function LanguageTab() {
  const t = useT();
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const choose = (value: string): void => {
    setError(null);
    setLanguage(value as Locale).catch((err: unknown) => setError(err instanceof Error && err.message ? err.message : t("settings.language.saveFailed")));
  };
  return (
    <div className="kp-settings__tab">
      <SelectField label={t("settings.language.label")} hint={t("settings.language.hint")} value={locale} onChange={choose} options={LOCALES.map((l) => ({ value: l, label: localeName(l) }))} />
      <ErrorText error={error} />
    </div>
  );
}
