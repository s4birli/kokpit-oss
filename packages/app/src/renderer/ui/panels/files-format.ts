// İş F — Dosyalar: small pure helpers of the panel.
import { intlLocale } from "../../../i18n/index.ts";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const STEP = 1024;

/** "1,5 KB" style size in the UI locale (the active one unless `locale` is given). */
export function formatBytes(n: number, locale: string = intlLocale()): string {
  let value = n;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit++;
  }
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  return `${num} ${UNITS[unit]}`;
}

/** Path of `name` inside folder `dir` ("" = root), as the engine expects it. */
export function childPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** "1\n2\n…" for the gutter: one number per line, a final newline does not open a new line. */
export function lineNumbers(text: string): string {
  const lines = text.split("\n");
  const count = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return Array.from({ length: count }, (_, i) => String(i + 1)).join("\n");
}

const encoder = new TextEncoder();
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}
