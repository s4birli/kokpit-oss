// Yollar — local file paths a program printed in a terminal: "open ~/Documents/rapor/index.html" at the end of a
// Claude Code session, a build's "wrote ./dist/index.html", a compiler's "src/a.ts:12:5". This module only FINDS
// them in a line of text; it never touches a file system. What a path points at, whether it exists and what a click
// does with it is decided by the engine, on the machine the file is on, when the user activates the link.
//
// What counts as a path (anything else in running text is left alone):
//   - `~/…`, `$HOME/…`, `./…`, `../…`;
//   - an absolute path with at least two segments or an extension (`/tmp/a/b`, `/tmp/a.txt` — not `/help`);
//   - a relative path with a slash that ends in an extension (`src/app/main.ts` — not `and/or`, `10/12/2026`);
//   - any of these in quotes or backticks, where it may hold spaces;
//   - the argument of `open <path>` / `open "<path>"`, which may also be a bare file name with an extension.
// Never part of an http(s) address (those are links), never after a drive letter or a scheme (`C:/…`, `s3://…`).
import { findLinks, INVISIBLE_CHARS, LINK_LIMITS, trimTrailing } from "./link-url.ts";

/** Sanity bounds (not settings). */
export const PATH_LIMITS = {
  /** Longest path that is offered; also the protocol's limit. */
  maxPathChars: 4096,
  /** Characters of one (joined) terminal line that are searched. */
  maxLineChars: LINK_LIMITS.maxLineChars,
  maxPathsPerLine: 64,
  /** Characters after an unquoted path that are offered as its possible continuation (a folder name with a space). */
  maxTailChars: 512,
} as const;

export interface FoundPath {
  /** UTF-16 offsets into the searched text: `text.slice(start, end)` is the path as written (without quotes). */
  start: number;
  end: number;
  /** The path as written (an escaped space still escaped). */
  text: string;
  /** The path itself: what the engine resolves (`~`, `$HOME` and relative paths are resolved there). */
  path: string;
  /** Written as the argument of `open`: "what the program asks the user to look at". */
  open: boolean;
  /**
   * Unquoted paths only: the text that follows on the line when the path is followed by one space. An unquoted
   * `/Volumes/Main Disk/a.html` reads as `/Volumes/Main`; the engine may find the longer one. "" otherwise.
   */
  tail: string;
}

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
/** A letter or digit of a script written with spaces between words. */
const WORD = String.raw`(?:(?![${CJK}])[\p{L}\p{N}\p{M}])`;
/** What an unquoted path is written with; `\ ` is an escaped space. Brackets are balanced afterwards. */
const PCHAR = String.raw`(?:\\ |[\p{L}\p{N}\p{M}\-_.~+@%=()\[\]/])`;
/** The same for a relative path, which runs into CJK text without a space in between. */
const RCHAR = String.raw`(?:${WORD}|[\-_.~+@%=()\[\]/])`;
/** Not the continuation of a word, an option or another path. */
const NOT_AFTER_WORD = String.raw`(?<![A-Za-z0-9_~/\\$.\-])(?<!${WORD})`;
/** …nor of an address, a drive letter or an assignment. */
const NOT_AFTER_ADDRESS = String.raw`(?<![A-Za-z0-9_~/\\$.\-:@#%&+=])(?<!${WORD})`;

const QUOTED = String.raw`(?<![\p{L}\p{N}])(?<quote>["'\x60])(?<quoted>(?:(?!\k<quote>)[^\n\r])+)\k<quote>`;
const HOME_FORM = String.raw`${NOT_AFTER_WORD}(?<home>(?:~|\$HOME)/${PCHAR}*)`;
const DOT_FORM = String.raw`${NOT_AFTER_ADDRESS}(?<dot>\.\.?/${PCHAR}+)`;
const ABSOLUTE_FORM = String.raw`${NOT_AFTER_ADDRESS}(?<absolute>/${PCHAR}+)`;
const RELATIVE_FORM = String.raw`${NOT_AFTER_ADDRESS}(?<relative>(?:${WORD}|[_@.])${RCHAR}*)`;
const PATH_RE = new RegExp(`${QUOTED}|${HOME_FORM}|${DOT_FORM}|${ABSOLUTE_FORM}|${RELATIVE_FORM}`, "gu");
/** `open` as a command word, then the start of its first argument. */
const OPEN_BEFORE = /(?<![\p{L}\p{N}_./\\-])open[ \t]+["'`]?$/u;
/** Characters before a match that are looked at for `open`. */
const OPEN_LOOKBACK = 64;
/** The first extension that CJK text follows directly: the path ends there (`a.htmlです`). */
const CJK_AFTER_EXTENSION = new RegExp(String.raw`\.[A-Za-z0-9]{1,10}(?=[${CJK}])`, "u");
const EXPLICIT_START = /^(?:~\/|\$HOME\/|\.\.?\/|\/)/;
const EXTENSION = /^[a-z0-9]{1,10}$/;
/** Ends the offered continuation of an unquoted path. */
const TAIL_END = /["'`\n\r]/;

/** The lower-case extension of a path's last segment, without the dot; "" when it has none (`.env`, `Makefile`). */
export function pathExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION.test(ext) ? ext : "";
}

/** Extensions that are a web page: opened in a browser, together with the files next to it. */
export const WEB_PAGE_EXTENSIONS: readonly string[] = ["html", "htm"];

export function isWebPagePath(path: string): boolean {
  return WEB_PAGE_EXTENSIONS.includes(pathExtension(path));
}

/** An extension with a letter in it: `a.ts`, `b.mp4` — not `1/2.5`. */
const hasWordExtension = (path: string): boolean => /[a-z]/.test(pathExtension(path));

/** Whether `path` (already unescaped) is one of the accepted forms. `bare`: a lone file name is enough (open form). */
function acceptable(path: string, bare: boolean): boolean {
  if (path.length === 0 || path.length > PATH_LIMITS.maxPathChars) return false;
  if (INVISIBLE_CHARS.test(path) || path !== path.trim()) return false;
  // An address, or a path glued to one.
  if (path.includes("//")) return false;
  if (/^(?:~|\$HOME)\//.test(path)) return path.length > path.indexOf("/") + 1;
  if (/^\.\.?\//.test(path)) return /[^./]/.test(path);
  if (path.startsWith("/")) return path.slice(1).replace(/\/+$/, "").includes("/") || hasWordExtension(path);
  if (path.startsWith("-")) return false;
  if (!path.includes("/")) return bare && hasWordExtension(path);
  // Quoted words that END in a path (`'open ~/a/b.html'`, a whole command line) are not one relative path.
  if (/\s/.test(path.slice(0, path.indexOf("/")))) return false;
  return hasWordExtension(path);
}

/**
 * The local paths written in a line of text, in order. Never throws; looks at no more than
 * `PATH_LIMITS.maxLineChars` characters. Text that is (part of) an http(s) address is never a path.
 */
export function findPaths(text: string): FoundPath[] {
  if (typeof text !== "string" || text === "") return [];
  const cut = text.length > PATH_LIMITS.maxLineChars;
  const searched = cut ? text.slice(0, PATH_LIMITS.maxLineChars) : text;
  const links = findLinks(searched);
  const inLink = (start: number, end: number): boolean => links.some((l) => start < l.end && end > l.start);
  const found: FoundPath[] = [];
  PATH_RE.lastIndex = 0;
  for (let m = PATH_RE.exec(searched); m !== null && found.length < PATH_LIMITS.maxPathsPerLine; m = PATH_RE.exec(searched)) {
    const g = m.groups ?? {};
    const quoted = g.quoted !== undefined;
    const start = m.index + (quoted ? 1 : 0);
    let written = g.quoted ?? g.home ?? g.dot ?? g.absolute ?? g.relative ?? "";
    if (!quoted) {
      const cjk = EXPLICIT_START.test(written) ? CJK_AFTER_EXTENSION.exec(written) : null;
      if (cjk) written = written.slice(0, cjk.index + cjk[0].length);
      written = trimTrailing(written);
      // What was trimmed is searched again: `a.html,~/b.html` are two paths.
      PATH_RE.lastIndex = start + Math.max(written.length, 1);
    }
    const end = start + written.length;
    // A path running into the end of the searched part may go on beyond it.
    if (cut && end >= searched.length) break;
    const path = quoted ? written : written.replace(/\\ /g, " ");
    const open = OPEN_BEFORE.test(searched.slice(Math.max(0, start - OPEN_LOOKBACK), start));
    if (!acceptable(path, open) || inLink(start, end)) {
      // Quotes that hold no path may still have one inside (`"bkz. src/a.ts"`), or be an apostrophe.
      if (quoted) PATH_RE.lastIndex = m.index + 1;
      continue;
    }
    let tail = "";
    if (!quoted && EXPLICIT_START.test(path) && /^ \S/.test(searched.slice(end, end + 2))) {
      const rest = searched.slice(end, end + PATH_LIMITS.maxTailChars);
      const stop = rest.search(TAIL_END);
      // A terminal row is padded with blanks to its width.
      tail = (stop < 0 ? rest : rest.slice(0, stop)).trimEnd();
      if (INVISIBLE_CHARS.test(tail)) tail = "";
    }
    found.push({ start, end, text: written, path, open, tail });
  }
  return found;
}
