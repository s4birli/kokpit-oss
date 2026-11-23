// i18n: unit tests run in the private (Turkish) configuration — the language their assertions were written in. A
// test about another language switches explicitly and switches back.
import { setLocale } from "@kokpit/shared/i18n";

setLocale("tr");
