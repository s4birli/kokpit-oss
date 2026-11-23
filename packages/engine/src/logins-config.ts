// Girişler: the `logins` block of the engine config. Values live in config.defaults.json (and the user's
// engine.json, merged key by key); config.ts validates them with this schema.
import { LOGIN_LIMITS } from "@kokpit/shared";
import { z } from "zod";

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/**
 * `security -i` reads one command per line into a fixed buffer: measured on macOS 14 (with `help` only), a line of
 * more than 4095 characters is cut and the rest is read as the NEXT command. A command line is never longer.
 */
export const SECURITY_LINE_MAX_CHARS = 4095;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LOGINS = 10_000;
const MAX_FRAME_DEPTH = 32;
const int = (min: number, max: number) => z.number().int().min(min).max(max);

/**
 * Text that is written into a `security` command line as one word, unquoted: service names, account names, the
 * secret's prefix. Letters, digits and a few separators only — nothing the tool's line parser treats specially
 * (whitespace, quotes, backslash), and never a leading "-" (an option).
 */
export const KEYCHAIN_WORD = /^[A-Za-z0-9_][A-Za-z0-9._:@/-]*$/;
const Word = (max: number) => z.string().min(1).max(max).regex(KEYCHAIN_WORD, "expected letters, digits and . _ : @ / - only");
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected an environment variable name").max(100);
/**
 * Who may read a stored password without asking the user:
 *   "confirm" — nobody. Items are created with an EMPTY trusted-application list (`security … -T ""`), so every read
 *               — the engine's own fill included — shows macOS's Keychain dialog on the engine Mac and waits for the
 *               user's click. Other programs running as the same user (AI agents in terminals among them) cannot
 *               read a password silently with `security find-generic-password -w`.
 *   "silent"  — the creating tool (`/usr/bin/security`) stays trusted: fills need no dialog, and ANY program running
 *               as this user can read the items the same way. Protected at rest (disk, backups) only.
 */
export const KEYCHAIN_ACCESS = ["confirm", "silent"] as const;
export type KeychainAccess = (typeof KEYCHAIN_ACCESS)[number];

const ErrorRule = z
  .object({
    /** Exit statuses of `security` that mean this (the low byte of the OSStatus). */
    exitCodes: z.array(int(1, 255)).max(20),
    /** Case-insensitive pieces of its stderr that mean this. */
    patterns: z.array(z.string().min(3).max(200)).max(20),
  })
  .strict();

const LoginsFields = z
  .object({
    /** The macOS `security` tool (absolute path; never looked up on PATH). */
    securityPath: z.string().min(1).max(4096).refine((p) => p.startsWith("/"), "must be an absolute path"),
    /** Keychain item service name = `<servicePrefix><projectId>`. */
    servicePrefix: Word(100),
    /** Keychain item account name; `{loginId}` is the login's id. */
    accountFormat: z
      .string()
      .max(100)
      .refine((f) => f.includes("{loginId}"), "must contain {loginId}")
      .refine((f) => KEYCHAIN_WORD.test(f.replaceAll("{loginId}", "x")), "expected letters, digits and . _ : @ / - around {loginId}"),
    /**
     * The stored secret is `<secretPrefix><base64url(UTF-8 password)>`: plain ASCII without spaces, so it passes
     * `security`'s line parser and comes back from `find-generic-password -w` unchanged whatever the password
     * holds. An ENCODING, not protection — the protection is the Keychain.
     */
    secretPrefix: Word(32),
    /** Environment of the `security` process: exactly these… */
    env: z.record(EnvName, z.string().max(4096)),
    /** …plus these variables copied from the engine's own environment when set (never the engine's key). */
    envPassthrough: z.array(EnvName).max(32),
    /** See KEYCHAIN_ACCESS. Applies to items saved from then on (a save recreates the item with the current policy). */
    keychainAccess: z.enum(KEYCHAIN_ACCESS),
    /**
     * "confirm" only: how long a READ waits for the user to answer the Keychain dialog on the engine Mac's screen.
     * The app waits a little longer than this.
     */
    confirmTimeoutMs: int(100, MAX_DURATION_MS),
    /** After a read was denied or nobody answered, the same login is not read again for this long (no dialog spam). */
    denyCooldownMs: int(0, MAX_DURATION_MS),
    /**
     * How long one `security` call may take. Long enough for the user to answer a Keychain dialog on the engine
     * Mac's screen; the app waits a little longer than this.
     */
    timeoutMs: int(100, MAX_DURATION_MS),
    /** Largest password (UTF-8 bytes) that is stored. Must fit one command line (see `maxCommandChars`). */
    maxSecretBytes: int(1, LOGIN_LIMITS.maxPasswordChars * 3),
    /** Longest command line sent to `security -i`. */
    maxCommandChars: int(200, SECURITY_LINE_MAX_CHARS),
    /** Most stdout / stderr bytes read from one call. */
    maxOutputBytes: int(256, MAX_OUTPUT_BYTES),
    maxPerProject: int(1, MAX_LOGINS),
    /** At most `fillRateMax` fills per project in any `fillRateWindowMs`. */
    fillRateMax: int(1, 10_000),
    fillRateWindowMs: int(1, MAX_DURATION_MS),
    /** Name of the isolated JavaScript world the fill runs in (the page's own scripts cannot reach into it). */
    fillWorldName: Word(64),
    /** Same-origin frames followed inward when looking for the fields. */
    fillFrameDepth: int(0, MAX_FRAME_DEPTH),
    /** How a failed `security` call is told apart. Checked in this order: interaction, denied, unavailable, notFound. */
    errors: z.object({ interaction: ErrorRule, denied: ErrorRule, unavailable: ErrorRule, notFound: ErrorRule }).strict(),
  })
  .strict();

export const LoginsConfigSchema = LoginsFields.refine(
  // base64 grows 4/3; the rest of the line is the command, the account and the service (ids are at most 200 chars).
  (c) => Math.ceil((c.maxSecretBytes * 4) / 3) + c.secretPrefix.length + 600 <= c.maxCommandChars,
  { path: ["maxSecretBytes"], message: "does not fit one command line (maxCommandChars)" },
);
export type LoginsConfig = z.infer<typeof LoginsConfigSchema>;
/** The `logins` block of a config FILE: any subset of the fields. */
export const LoginsFileSchema = LoginsFields.partial().strict();
