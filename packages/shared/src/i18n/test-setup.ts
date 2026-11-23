// i18n: tests run in the private (Turkish) configuration — the language their assertions were written in. A test
// about another language sets it explicitly (and restores it).
import { setLocale } from "./core.ts";

setLocale("tr");
