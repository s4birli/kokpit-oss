// Bağlantılar — contract between the renderer, the preload and Electron main for links a program printed in a
// terminal (plain URLs, OSC 8 hyperlinks), plus the values of the feature (links.defaults.json).
//
// A link is opened only as the direct result of the user's gesture on it — never because output arrived:
//   - ⌘ click (also while the program tracks the mouse) or a plain click (when it does not): the link opens in the
//     terminal's PROJECT browser — the project's Chrome on the engine machine (`browser.openUrl`), or this
//     machine's profile Chrome for projects whose browser runs here; SSH (and app-only) projects use the default browser;
//   - ⌥⌘ click, or the right-click menu: the default browser of this machine.
// Only http(s) is ever opened (`parseLinkTarget` in @kokpit/shared); main validates every address again, opens the
// normalized one, and limits how often. Nothing here lets the page start another URL scheme's handler.
import defaults from "./links.defaults.json" with { type: "json" };

export const LINKS_IPC = {
  /** renderer → main: open an http(s) address in this machine's default browser. */
  openExternal: "links:openExternal",
  /** renderer → main: show the native right-click menu of a link; resolves with what the user chose. */
  menu: "links:menu",
} as const;

/** What the user picked in a link's right-click menu. "copy" was already done by main. */
export type LinkMenuChoice = "browser" | "external" | "files" | "copy";
const MENU_CHOICES: readonly LinkMenuChoice[] = ["browser", "external", "files", "copy"];

export function parseLinkMenuChoice(raw: unknown): LinkMenuChoice | null {
  return MENU_CHOICES.find((c) => c === raw) ?? null;
}

export interface LinkMenuRequest {
  /** The link's real target, as the program wrote it. */
  url: string;
  /** Offer "Tarayıcıda aç" (the project has a browser of its own to open it in). */
  browser: boolean;
}

/** Yollar: the right-click menu of a local file path a program printed. */
export interface PathMenuRequest {
  /** What is shown (disabled first line) and copied: the file's path on the engine machine, else as written. */
  path: string;
  /** Offer "Tarayıcıda aç": the engine can show it in the project's browser. */
  browser: boolean;
  /** Offer "Dosyalar'da göster": it is inside the project's (card's) folder. */
  files: boolean;
}

/** Exposed as `window.kokpit.links`. */
export interface LinksBridge {
  openExternal(url: string): Promise<void>;
  menu(request: LinkMenuRequest | PathMenuRequest): Promise<LinkMenuChoice | null>;
}

export interface LinksConfig {
  /** A plain click opens a link while the program does not track the mouse (⌘ click always does). */
  plainClickOpens: boolean;
  /** Yollar: the same for a local file path (false = paths open with ⌘ click and from the menu only). */
  pathPlainClickOpens: boolean;
  /** A press that moved further than this before the release is a drag (a selection), not a click. */
  clickMaxMovePx: number;
  /** How long the pointer rests on a link before its tooltip shows. */
  tooltipDelayMs: number;
  /** Longer addresses are shortened in the middle in the tooltip and the confirmation. */
  tooltipMaxChars: number;
  /** Distance of the tooltip from the pointer. */
  tooltipOffsetPx: number;
  /** The "this link goes elsewhere" question goes away by itself after this long. */
  confirmMs: number;
  /** How long "could not open" stays on screen. */
  noticeMs: number;
  /** Most soft-wrapped terminal rows joined into one line when looking for links. */
  maxWrappedRows: number;
  /** Characters of the real target shown as the menu's first (disabled) line. */
  menuTargetMaxChars: number;
  /** After a menu closed, how long main waits for the chosen item's click before answering "nothing chosen". */
  menuCloseGraceMs: number;
  /** Opens allowed (per window of the app and, separately, in main). */
  rate: { max: number; windowMs: number; minIntervalMs: number };
  /** Yollar: what the engine said a path points at is asked again only after this long. */
  pathCacheMs: number;
}

export const linksConfig: LinksConfig = defaults;

/** `text` with `{name}` replaced from `values`. */
export function fillText(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** An address short enough for one line: the beginning (scheme and host) and the end are kept. */
export function shortenUrl(url: string, maxChars: number): string {
  if (url.length <= maxChars || maxChars < 8) return url;
  const tail = Math.floor(maxChars / 4);
  return `${url.slice(0, maxChars - tail - 1)}…${url.slice(-tail)}`;
}
