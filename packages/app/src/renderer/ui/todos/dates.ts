// Calendar arithmetic on YYYY-MM-DD keys. Keys are calendar days (the engine decides which one is
// "today"), so all maths is done in UTC to stay clear of the viewer's time zone and DST.
import { intlLocale, t } from "../../../i18n/index.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toUtc(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day `days` after `key` (negative = before). */
export function shiftDate(key: string, days: number): string {
  return fromUtc(toUtc(key) + days * MS_PER_DAY);
}

/** Whole days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / MS_PER_DAY);
}

/** "Bugün" / "Dün" / "Yarın" relative to `today`, else null. */
export function relativeDayName(key: string, today: string): string | null {
  switch (daysBetween(today, key)) {
    case 0:
      return t("todos.day.today");
    case -1:
      return t("todos.day.yesterday");
    case 1:
      return t("todos.day.tomorrow");
    default:
      return null;
  }
}

/** Long date, e.g. "16 Kasım 2026 Pazartesi", in the active locale unless `locale` is given. */
export function formatDay(key: string, locale: string = intlLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
    weekday: "long",
  }).format(new Date(toUtc(key)));
}
