// i18n: the engine's tests run in the private (Turkish) configuration — the language its existing assertions were
// written in. In-process code gets the locale here; engines started as child processes inherit KOKPIT_LANGUAGE.
// A test about another language sets it explicitly.
import { setLocale } from "@kokpit/shared/i18n";

const TEST_LANGUAGE = "tr";
process.env.KOKPIT_LANGUAGE ??= TEST_LANGUAGE;
setLocale(TEST_LANGUAGE);
