// Links printed in a terminal (Claude Code's output, a dev server's "Local: http://localhost:3000", OSC 8
// hyperlinks). One rule for the app's renderer, its main process and the engine:
//   - only http: and https: are ever OPENED (in a project's browser, or in the default browser);
//   - file: is recognised but never opened (it can only be copied);
//   - every other scheme (javascript:, vscode:, mailto:, custom handlers…) is refused: what a program prints must
//     not be able to start an arbitrary URL handler on the user's machine;
//   - what is opened and shown to the user is the address as the URL parser normalizes it, never the text as written.

/** Sanity bounds (not settings). */
export const LINK_LIMITS = {
  /** Longest address that is opened; also the browser protocol's limit. */
  maxUrlLength: 8192,
  /** Characters of one (joined) terminal line that are searched for links. */
  maxLineChars: 32_768,
  maxLinksPerLine: 64,
} as const;

export type LinkRefusal = "empty" | "too-long" | "control" | "malformed" | "scheme" | "credentials";

export type LinkTarget =
  /** http(s): `url` is the normalized address, `host` its real host (with the port, if any). */
  | { kind: "web"; url: string; host: string }
  /** A file: address — shown and copied, never opened. */
  | { kind: "file"; url: string }
  | { kind: "refused"; reason: LinkRefusal; scheme?: string };

const WEB_PROTOCOLS = new Set(["http:", "https:"]);
/**
 * Whitespace, C0/C1 controls, and invisible or direction-changing format characters: none of them belongs in an
 * address, and each can make an address look like another one.
 */
/** The same without whitespace: a file name may hold a space, never one of these. */
export const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;

/** What a link points at, and whether it may be opened. Never throws. */
export function parseLinkTarget(raw: unknown): LinkTarget {
  if (typeof raw !== "string" || raw === "") return { kind: "refused", reason: "empty" };
  if (raw.length > LINK_LIMITS.maxUrlLength) return { kind: "refused", reason: "too-long" };
  if (UNSAFE_CHARS.test(raw)) return { kind: "refused", reason: "control" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "refused", reason: "malformed" };
  }
  if (WEB_PROTOCOLS.has(url.protocol)) {
    if (url.hostname === "") return { kind: "refused", reason: "malformed" };
    // `https://bank.example@evil.example/` reads like the first host and goes to the second.
    if (url.username !== "" || url.password !== "") return { kind: "refused", reason: "credentials" };
    if (url.href.length > LINK_LIMITS.maxUrlLength) return { kind: "refused", reason: "too-long" };
    return { kind: "web", url: url.href, host: url.host };
  }
  if (url.protocol === "file:") return { kind: "file", url: url.href };
  return { kind: "refused", reason: "scheme", scheme: url.protocol };
}

/** The normalized http(s) address of `raw`, or null when it is not one that may be opened. */
export function webLinkUrl(raw: unknown): string | null {
  const target = parseLinkTarget(raw);
  return target.kind === "web" ? target.url : null;
}

export interface FoundLink {
  /** UTF-16 offsets into the searched text: `text.slice(start, end)` is the link as written. */
  start: number;
  end: number;
  /** The link as written. */
  text: string;
  /** What to open: the text, with `http://` in front of a bare local address (`localhost:3000`). */
  url: string;
}

// Characters an address may be written with: printable ASCII except the ones that end it in running text
// (space, quotes, angle brackets, backtick, backslash, braces, pipe, caret), and letters / digits / marks of other
// alphabets (Türkçe, IDN hosts). CJK and Hangul letters end it: in those texts an address is followed by words
// without a space in between. Punctuation and symbols beyond ASCII (box-drawing borders of a TUI, 。）…) end it too.
const URL_CHAR = String.raw`(?:[!#-&(-;=?-\[\]_a-z~']|(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}\p{M}])`;
/** Hosts that are an address even without a scheme — only together with a port (`localhost:3000`). */
const BARE_HOST = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=:\d)`;
const LINK_RE = new RegExp(String.raw`(?<![A-Za-z0-9+.@/_-])(?:(https?:\/\/)|${BARE_HOST})${URL_CHAR}*`, "giu");
/** Never the last character of an address in running text. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", "*"]);
const BRACKETS: ReadonlyArray<readonly [open: string, close: string]> = [
  ["(", ")"],
  ["[", "]"],
];

function count(text: string, ch: string): number {
  let n = 0;
  for (let i = text.indexOf(ch); i >= 0; i = text.indexOf(ch, i + 1)) n++;
  return n;
}

/** Drops sentence punctuation and closing brackets that have no opening one inside the address (or path). */
export function trimTrailing(candidate: string): string {
  let out = candidate;
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    if (TRAILING.has(last)) {
      out = out.slice(0, -1);
      continue;
    }
    const pair = BRACKETS.find(([, close]) => close === last);
    if (pair && count(out, pair[1]) > count(out, pair[0])) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

/**
 * The http(s) addresses written in a line of text, in order. Only addresses `parseLinkTarget` would open are
 * returned. Never throws; looks at no more than `LINK_LIMITS.maxLineChars` characters.
 */
export function findLinks(text: string): FoundLink[] {
  if (typeof text !== "string" || text === "") return [];
  const cut = text.length > LINK_LIMITS.maxLineChars;
  const searched = cut ? text.slice(0, LINK_LIMITS.maxLineChars) : text;
  const found: FoundLink[] = [];
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(searched); m !== null && found.length < LINK_LIMITS.maxLinksPerLine; m = LINK_RE.exec(searched)) {
    // An address running into the end of the searched part may go on beyond it: half an address is not a link.
    if (cut && m.index + m[0].length === searched.length) break;
    const written = trimTrailing(m[0]);
    if (written === "") continue;
    const url = m[1] === undefined ? `http://${written}` : written;
    if (parseLinkTarget(url).kind !== "web") continue;
    found.push({ start: m.index, end: m.index + written.length, text: written, url });
  }
  return found;
}

/** `ornek.example`, `www.ornek.example/yol`, `ornek.example:8443` — a host name written without a scheme. */
const BARE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/**
 * OSC 8 links show one text and go somewhere else. When the text itself reads like an address of ANOTHER host,
 * returns that address (normalized) so the user can be asked; null when the text is no address, names the same
 * host, or is a piece of the target (a long address shown over several rows, a file name at its end).
 */
export function deceptiveLinkText(visible: string, targetUrl: string): string | null {
  const target = parseLinkTarget(targetUrl);
  if (target.kind !== "web" || typeof visible !== "string") return null;
  const shown = visible.trim();
  if (shown === "") return null;
  const written = findLinks(shown)[0];
  const bare = written === undefined && BARE_DOMAIN.test(shown);
  if (written === undefined && !bare) return null;
  const candidate = parseLinkTarget(written ? written.url : `https://${shown}`);
  if (candidate.kind !== "web" || candidate.host === target.host) return null;
  const real = target.url.toLowerCase();
  const piece = (written ? written.text : shown).toLowerCase();
  // The beginning of the same address (cut by the row's end), or — for a bare name — its end ("README.md").
  if (written ? real.startsWith(piece) || targetUrl.toLowerCase().startsWith(piece) : pathOf(real).endsWith(piece)) return null;
  return candidate.url;
}

/** The address without its query and fragment. */
function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  return end < 0 ? url : url.slice(0, end);
}

export interface RateLimiterOptions {
  /** Most actions per `windowMs`. */
  max: number;
  windowMs: number;
  /** Shortest time between two actions (a double click is one). */
  minIntervalMs?: number;
  now?: () => number;
}

/** A sliding-window limiter for "open this link" requests. `allow()` counts the action only when it says yes. */
export function createRateLimiter(options: RateLimiterOptions): { allow(): boolean } {
  const now = options.now ?? Date.now;
  const minInterval = options.minIntervalMs ?? 0;
  let times: number[] = [];
  return {
    allow(): boolean {
      const t = now();
      times = times.filter((at) => t - at < options.windowMs);
      const last = times.at(-1);
      if (last !== undefined && t - last < minInterval) return false;
      if (times.length >= options.max) return false;
      times.push(t);
      return true;
    },
  };
}
