// i18n: a zod message option whose text is looked up when the check fails, so it is in the process's locale at that
// moment (a literal would be frozen at import). zod 4: `.refine(fn, zm(key))`, `.regex(re, zm(key))`.
import { st, type SharedKey } from "./i18n/catalog.ts";

export const zm = (key: SharedKey): { error: () => string } => ({ error: () => st(key) });
