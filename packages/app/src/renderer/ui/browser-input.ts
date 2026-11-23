// İş B: pure helpers of the Tarayıcı panel — coordinate scaling, DOM event → protocol event, URL input.
import {
  BROWSER_LIMITS,
  BrowserUrlSchema,
  type BrowserFrameMetadata,
  type BrowserInputEvent,
  type BrowserModifiers,
} from "@kokpit/shared";
import { t as translate } from "../../i18n/index.ts";

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}

const finite = (n: number) => Number.isFinite(n);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * A point on the canvas (CSS px, relative to its box) → page CSS px for CDP input.
 * canvas CSS px → frame image px (canvasCssSize vs frameImageSize) → page px (image vs metadata.device*),
 * minus metadata.offsetTop, clamped into the page. Null when the sizes are not measurable.
 */
export function toPagePoint(p: Point, canvasCssSize: Size, frameImageSize: Size, m: BrowserFrameMetadata): Point | null {
  const nums = [p.x, p.y, canvasCssSize.width, canvasCssSize.height, frameImageSize.width, frameImageSize.height, m.deviceWidth, m.deviceHeight];
  if (!nums.every(finite)) return null;
  if (canvasCssSize.width <= 0 || canvasCssSize.height <= 0 || frameImageSize.width <= 0 || frameImageSize.height <= 0) return null;
  if (m.deviceWidth <= 0 || m.deviceHeight <= 0) return null;
  const imgX = (p.x * frameImageSize.width) / canvasCssSize.width;
  const imgY = (p.y * frameImageSize.height) / canvasCssSize.height;
  const offsetTop = finite(m.offsetTop) ? m.offsetTop : 0;
  const maxX = Math.min(m.deviceWidth, BROWSER_LIMITS.maxCoord);
  const maxY = Math.min(m.deviceHeight, BROWSER_LIMITS.maxCoord);
  const x = clamp((imgX * m.deviceWidth) / frameImageSize.width, 0, maxX);
  const y = clamp((imgY * m.deviceHeight) / frameImageSize.height - offsetTop, 0, maxY);
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

interface ModifierKeys {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function modifiersOf(e: ModifierKeys): Required<BrowserModifiers> {
  return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
}

export interface KeyLike extends ModifierKeys {
  key: string;
  code: string;
  keyCode: number;
  location: number;
  repeat: boolean;
}

// ---- Kopyalama ----

export type ClipboardAction = "copy" | "cut" | "paste";
const CLIPBOARD_KEYS: Readonly<Record<string, ClipboardAction>> = { c: "copy", x: "cut", v: "paste" };

/**
 * The system's copy / cut / paste shortcut: Cmd on macOS, Ctrl elsewhere — and nothing else held (Shift is allowed
 * for paste: "paste and match style" is still a paste of text here). Ctrl+C on macOS is NOT a copy: it is the
 * page's own key (a web terminal's ^C). These keys are not sent to the remote page; the browser's own
 * `copy` / `cut` / `paste` event, which the panel handles, follows them.
 */
export function clipboardShortcut(e: ModifierKeys & { key: string }, isMac: boolean): ClipboardAction | null {
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.altKey) return null;
  const action = CLIPBOARD_KEYS[e.key.toLowerCase()];
  if (action === undefined) return null;
  return e.shiftKey && action !== "paste" ? null : action;
}

/** True on Apple platforms (where Cmd, not Ctrl, is the shortcut modifier). */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
}

/** A right click with this modifier held belongs to the remote page, not to Kokpit's menu. */
export function rightClickGoesToPage(e: ModifierKeys, modifier: "alt" | "shift"): boolean {
  return modifier === "alt" ? e.altKey : e.shiftKey;
}

/** DOM keydown/keyup → protocol key event; null when the protocol would refuse it. */
export function keyEventFrom(e: KeyLike, action: "down" | "up"): BrowserInputEvent | null {
  if (e.key.length === 0 || e.key.length > BROWSER_LIMITS.maxKeyLength) return null;
  return {
    type: "key",
    action,
    key: e.key,
    code: e.code.slice(0, BROWSER_LIMITS.maxKeyLength),
    ...(Number.isInteger(e.keyCode) && e.keyCode >= 0 && e.keyCode <= 1000 ? { keyCode: e.keyCode } : {}),
    ...(Number.isInteger(e.location) && e.location >= 0 && e.location <= 3 ? { location: e.location } : {}),
    ...(e.repeat ? { repeat: true } : {}),
    modifiers: modifiersOf(e),
  };
}

export interface WheelLike extends ModifierKeys {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode: number;
}

/** Wheel deltas in pixels, clamped to the protocol's range. */
export function wheelEventFrom(at: Point, e: WheelLike, units: { lineHeight: number; pageHeight: number }): BrowserInputEvent {
  const factor = e.deltaMode === 1 ? units.lineHeight : e.deltaMode === 2 ? units.pageHeight : 1;
  const d = (v: number) => (finite(v) ? clamp(v * factor, -BROWSER_LIMITS.maxWheelDelta, BROWSER_LIMITS.maxWheelDelta) : 0);
  return { type: "wheel", x: at.x, y: at.y, deltaX: d(e.deltaX), deltaY: d(e.deltaY), modifiers: modifiersOf(e) };
}

// ---- İş Z: address bar ----

export type AddressResult = { ok: true; url: string } | { ok: false; error: string };

/** `scheme:` at the start of input without whitespace; `host:1234` is a port, not a scheme. */
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i;
const WEB_SCHEMES = new Set(["http", "https"]);
/** host[:port] followed by an optional path/query/fragment. */
const HOST_PORT = /^(\[[0-9a-f:.]+\]|[^\s/?#:[\]]+)(?::(\d{1,5}))?(?:[/?#]|$)/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** Dotted host name: labels on both sides of every dot. */
const DOTTED = /^[^\s.]+(\.[^\s.]+)+$/;
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

function webUrl(url: string): AddressResult {
  return BrowserUrlSchema.safeParse(url).success && /^https?:/i.test(url)
    ? { ok: true, url }
    : { ok: false, error: translate("browser.address.invalid") };
}

/**
 * What the user typed in the address bar → the http(s) URL to open.
 * - A scheme → used as is; only http/https are allowed.
 * - Looks like a host (a dotted name without spaces, localhost[:port], an IP[:port]) → `https://` prepended,
 *   `http://` for localhost / loopback.
 * - Anything else → a search with `searchUrl` (`%s` = the URL-encoded text).
 */
export function resolveAddress(input: string, searchUrl: string): AddressResult {
  const t = input.trim();
  if (t === "") return { ok: false, error: translate("browser.address.empty") };
  const spaced = /\s/.test(t);
  if (!spaced) {
    const scheme = SCHEME.exec(t);
    if (scheme) {
      if (!WEB_SCHEMES.has(scheme[1]!.toLowerCase())) return { ok: false, error: translate("browser.address.onlyWeb") };
      return webUrl(t);
    }
    const hp = HOST_PORT.exec(t);
    if (hp) {
      const host = hp[1]!;
      const port = hp[2];
      const portOk = port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
      if (portOk && LOOPBACK_HOST.test(host)) return webUrl(`http://${t}`);
      if (portOk && (IPV4.test(host) || DOTTED.test(host))) {
        const r = webUrl(`https://${t}`);
        if (r.ok) return r;
      }
    }
  }
  return searchFor(t, searchUrl);
}

function searchFor(text: string, searchUrl: string): AddressResult {
  if (!searchUrl.includes("%s") || !/^https?:\/\//i.test(searchUrl)) {
    return { ok: false, error: translate("browser.address.badSearchEngine") };
  }
  const url = searchUrl.split("%s").join(encodeURIComponent(text));
  const r = webUrl(url);
  return r.ok ? r : { ok: false, error: translate("browser.address.searchTooLong") };
}

/** Screencast bounds for a viewer box: device pixels, rounded, clamped to [1, max]. */
export function screencastSize(box: Size, devicePixelRatio: number, max: number): { maxWidth: number; maxHeight: number } {
  const dpr = finite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const px = (v: number) => (finite(v) ? clamp(Math.round(v * dpr), 1, max) : 1);
  return { maxWidth: px(box.width), maxHeight: px(box.height) };
}

/**
 * The picture area of the panel as the engine wants it (whole CSS px within the protocol's range), or null while
 * it is hidden or too small to be of use (narrower/shorter than `min`): a hidden panel never pushes a size.
 */
export function panelViewport(box: Size, min: number): Size | null {
  const floor = Math.max(finite(min) ? min : 0, BROWSER_LIMITS.minViewportDim);
  if (!finite(box.width) || !finite(box.height) || box.width < floor || box.height < floor) return null;
  const px = (v: number) => clamp(Math.floor(v), BROWSER_LIMITS.minViewportDim, BROWSER_LIMITS.maxViewportDim);
  return { width: px(box.width), height: px(box.height) };
}
