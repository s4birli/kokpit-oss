// Every tunable of the engine client lives here, with its default.
import { accessKeyRule, isStrongAccessKey, type Method } from "@kokpit/shared";
import type { BackoffPolicy } from "./backoff.ts";
import type { EngineSettings } from "./types.ts";
import { t } from "../../i18n/index.ts";

export interface ClientOptions {
  /** Reconnect backoff after a lost connection. */
  backoff: BackoffPolicy;
  /** Max time from socket creation to `hello.ok`; past it the attempt is abandoned and retried. */
  handshakeTimeoutMs: number;
  /** While open, a liveness probe (`projects.list`) is sent this often. */
  heartbeatIntervalMs: number;
  /** A probe unanswered for this long force-closes the socket (dead Tailscale link) and reconnects. */
  heartbeatTimeoutMs: number;
  /** Default timeout of `request()`. */
  requestTimeoutMs: number;
  /** Per-method timeouts for requests that legitimately take long (e.g. a GitHub clone). */
  methodTimeoutsMs: Partial<Record<Method, number>>;
  /**
   * Max UTF-16 code units of terminal input per `input` frame. Large pastes are split so that even
   * worst-case JSON escaping (6x) stays well under the protocol's MAX_MESSAGE_BYTES.
   */
  inputChunkSize: number;
}

/**
 * Girişler: the engine waits up to its `logins.timeoutMs` (default 45 s) for the Keychain — the user may have to
 * answer a dialog on the engine Mac's screen — so the client outwaits it and the engine's own message arrives.
 */
const KEYCHAIN_REQUEST_TIMEOUT_MS = 60_000;
/**
 * A fill may wait for the user's click in the Keychain dialog on the engine Mac (engine `logins.confirmTimeoutMs`,
 * default 120 s): the client outwaits that too.
 */
const KEYCHAIN_CONFIRM_REQUEST_TIMEOUT_MS = 150_000;

export const DEFAULT_CLIENT_OPTIONS: ClientOptions = {
  backoff: { initialMs: 500, maxMs: 15_000, multiplier: 2, jitter: 0.3 },
  handshakeTimeoutMs: 10_000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  methodTimeoutsMs: {
    "projects.create": 10 * 60_000,
    "tools.check": 60_000,
    "logins.save": KEYCHAIN_REQUEST_TIMEOUT_MS,
    "logins.fill": KEYCHAIN_CONFIRM_REQUEST_TIMEOUT_MS,
    "logins.delete": KEYCHAIN_REQUEST_TIMEOUT_MS,
  },
  inputChunkSize: 64 * 1024,
};

export function resolveClientOptions(overrides: Partial<ClientOptions> = {}): ClientOptions {
  return {
    ...DEFAULT_CLIENT_OPTIONS,
    ...overrides,
    backoff: { ...DEFAULT_CLIENT_OPTIONS.backoff, ...overrides.backoff },
    methodTimeoutsMs: { ...DEFAULT_CLIENT_OPTIONS.methodTimeoutsMs, ...overrides.methodTimeoutsMs },
  };
}

/** Bounds shared by the connect form and the main-process settings validation. */
export const SETTINGS_LIMITS = {
  maxUrlLength: 2048,
  /** Matches the engine's `hello.key` limit in the shared protocol. */
  maxKeyLength: 1000,
} as const;

/** IPC channels between preload (SettingsBridge) and main (settings-store). */
export const SETTINGS_IPC = {
  load: "settings:load",
  save: "settings:save",
  clear: "settings:clear",
  /** Kendini güncelleme: "settings are stored but their key cannot be read" → the stored address. */
  locked: "settings:locked",
} as const;

/** The transport gate in front of the key's handshake (main: connection-gate.ts). */
export const CONNECTION_IPC = {
  check: "connection:check",
  insecureAllowed: "connection:insecureAllowed",
  setInsecure: "connection:setInsecure",
} as const;

/** Wire shape of every settings IPC reply; preload turns `ok: false` into a thrown Error. */
export type SettingsIpcReply<T> = { ok: true; value: T } | { ok: false; error: string };

const ALLOWED_PROTOCOLS = new Set(["ws:", "wss:"]);

export type SettingsValidation =
  | { ok: true; value: EngineSettings }
  | { ok: false; errors: Partial<Record<keyof EngineSettings, string>> };

/** Pure validation used by both the connect form and the main process (which must not trust IPC input). */
export function validateEngineSettings(input: unknown): SettingsValidation {
  const errors: Partial<Record<keyof EngineSettings, string>> = {};
  const obj = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const url = typeof obj.url === "string" ? obj.url.trim() : "";
  const key = typeof obj.key === "string" ? obj.key : "";

  if (url.length === 0) errors.url = t("connect.validation.urlRequired");
  else if (url.length > SETTINGS_LIMITS.maxUrlLength) errors.url = t("connect.validation.urlTooLong");
  else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || !ALLOWED_PROTOCOLS.has(parsed.protocol) || parsed.hostname.length === 0) {
      errors.url = t("connect.validation.urlScheme");
    }
  }

  if (key.trim().length === 0) errors.key = t("connect.validation.keyRequired");
  else if (key.length > SETTINGS_LIMITS.maxKeyLength) errors.key = t("connect.validation.keyTooLong");

  if (errors.url || errors.key) return { ok: false, errors };
  return { ok: true, value: { url, key } };
}

/**
 * What may be SAVED: valid settings whose key is at least 32 random bytes (a weaker key could be guessed offline
 * from one captured handshake proof). Loading stays lenient — the engine refuses a weak key anyway.
 */
export function validateNewEngineSettings(input: unknown): SettingsValidation {
  const v = validateEngineSettings(input);
  if (!v.ok) return v;
  if (!isStrongAccessKey(v.value.key)) return { ok: false, errors: { key: accessKeyRule() } };
  return v;
}
