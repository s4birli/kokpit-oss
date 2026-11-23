// Client-side checks with Turkish messages, mirroring the protocol's rules in @kokpit/shared.
// After these pass, the params are also checked against the protocol schema itself, so the
// two can never silently disagree (the engine stays the final authority).
import {
  isHttpsUrl,
  RequestParams,
  type Method,
  type ParamsOf,
} from "@kokpit/shared";
import { t, type MessageKey } from "../../../i18n/index.ts";

export type FieldErrors<K extends string> = Partial<Record<K, string>>;
export type Checked<M extends Method, K extends string> =
  | { ok: true; params: ParamsOf<M> }
  | { ok: false; errors: FieldErrors<K>; message?: string };

/** Same token rule as the protocol's SAFE_TOKEN (hostnames, users). */
const SAFE_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9._@:+-]*$/;
const GIT_URL = [/^https:\/\/[^\s]+$/, /^git@[A-Za-z0-9.-]+:[^\s]+$/];
const LIMITS = { name: 100, command: 1000, path: 4096, url: 1000, token: 255 } as const;

export function checkName(v: string): string | undefined {
  const s = v.trim();
  if (s === "") return t("settings.validation.nameRequired");
  if (s.length > LIMITS.name) return t("settings.validation.maxChars", { max: LIMITS.name });
  return undefined;
}

export function checkAbsPath(v: string, what: string): string | undefined {
  if (!v.startsWith("/")) return t("settings.validation.mustStartWithSlash", { what });
  if (v.length > LIMITS.path) return t("settings.validation.tooLong", { what });
  return undefined;
}

export function checkGitUrl(v: string): string | undefined {
  const s = v.trim();
  if (s.length > LIMITS.url || !GIT_URL.some((re) => re.test(s))) return t("settings.validation.gitUrl");
  return undefined;
}

export function checkHttpsUrl(v: string): string | undefined {
  return isHttpsUrl(v.trim()) ? undefined : t("settings.validation.httpsUrl");
}


export function checkHostToken(v: string, required: boolean, what: string): string | undefined {
  if (v === "") return required ? t("settings.validation.required", { what }) : undefined;
  if (v.startsWith("-")) return t("settings.validation.noLeadingDash");
  if (/\s/.test(v)) return t("settings.validation.noSpaces");
  if (v.length > LIMITS.token || !SAFE_TOKEN.test(v)) return t("settings.validation.badChar");
  return undefined;
}

/** "" → undefined; otherwise an integer in 1–65535, or an error. */
export function parsePort(v: string): { ok: true; port: number | undefined } | { ok: false; error: string } {
  const s = v.trim();
  if (s === "") return { ok: true, port: undefined };
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isInteger(n) || n < 1 || n > 65535) {
    return { ok: false, error: t("settings.validation.port") };
  }
  return { ok: true, port: n };
}

export function checkCommand(v: string, required: boolean, what: string): string | undefined {
  const s = v.trim();
  if (s === "") return required ? t("settings.validation.required", { what }) : undefined;
  if (s.length > LIMITS.command) return t("settings.validation.maxChars", { max: LIMITS.command });
  return undefined;
}

/** Final guard: the exact params must satisfy the protocol schema. */
export function finish<M extends Method, K extends string>(
  method: M,
  params: ParamsOf<M>,
  errors: FieldErrors<K>,
): Checked<M, K> {
  if (Object.values(errors).some(Boolean)) return { ok: false, errors };
  const r = RequestParams[method].safeParse(params);
  if (!r.success) return { ok: false, errors: {}, message: t("settings.validation.invalidValue", { detail: r.error.issues[0]?.message ?? method }) };
  return { ok: true, params };
}

/** Drops undefined keys so optional fields are omitted, not sent as undefined. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---- İş A: bekleme kalıpları ----

/** Same bounds as the protocol's WaitingPatternsSchema. */
const PATTERN_LIMITS = { count: 50, length: 500 } as const;

/** Textarea → regex list: one per line, trimmed, blank lines dropped; the first bad line is named. */
export function parsePatterns(text: string): { ok: true; patterns: string[] } | { ok: false; error: string } {
  const patterns: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    if (line.length > PATTERN_LIMITS.length) return { ok: false, error: t("settings.validation.patternTooLong", { line: i + 1, max: PATTERN_LIMITS.length }) };
    try {
      new RegExp(line);
    } catch {
      return { ok: false, error: t("settings.validation.patternInvalid", { line: i + 1 }) };
    }
    patterns.push(line);
  }
  if (patterns.length > PATTERN_LIMITS.count) return { ok: false, error: t("settings.validation.tooManyPatterns", { max: PATTERN_LIMITS.count }) };
  return { ok: true, patterns };
}

