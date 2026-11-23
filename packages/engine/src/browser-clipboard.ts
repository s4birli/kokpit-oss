// Kopyalama — Tarayıcı: the remote page's SELECTION for the app's clipboard, and what the app's right-click menu
// needs to know about a point of the page. Both are read with one `Runtime.evaluate` in the active tab.
//
// What these scripts may read is deliberately narrow: the text the user selected (in the document, in the focused
// input / textarea, in same-origin frames) and the link under one point. Never a password field's content, never
// "the whole page", and nothing from the request is ever written into the script except numbers and booleans.
// Cross-origin frames live in other processes and are not reached.
//
// The answers are untrusted: a page can redefine everything the scripts call. They are parsed here and can at worst
// make "copy" copy something else — which a page's own `copy` handler can do in any browser.
import { BROWSER_LIMITS, type BrowserContextInfo } from "@kokpit/shared";
import { z } from "zod";
import { engineError } from "./contracts.ts";

/** Frames followed inward from the focused / hit element (same-origin only). */
const MAX_FRAME_DEPTH = 8;

/**
 * Shared page code: `find(document, 0)` → `{ doc, active, text }` — the innermost same-origin document that has the
 * focus, its focused element (through open shadow roots) and the selected text there.
 */
const PRELUDE = `
  const DEPTH = ${MAX_FRAME_DEPTH};
  const isFrame = (el) => !!el && (el.tagName === "IFRAME" || el.tagName === "FRAME");
  const inner = (el) => { try { return el.contentDocument || null; } catch (e) { return null; } };
  const isField = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
  const isSecret = (el) => !!el && el.tagName === "INPUT" && String(el.type).toLowerCase() === "password";
  const deepActive = (doc) => {
    let a = doc.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const find = (doc, depth) => {
    const active = deepActive(doc);
    if (isFrame(active)) {
      const d = depth < DEPTH ? inner(active) : null;
      return d ? find(d, depth + 1) : { doc, active, text: "" };
    }
    if (isSecret(active)) return { doc, active, text: "" };
    if (isField(active)) {
      let s = null, e = null;
      try { s = active.selectionStart; e = active.selectionEnd; } catch (err) {}
      if (typeof s === "number" && typeof e === "number" && e > s) return { doc, active, text: String(active.value).slice(s, e) };
    }
    const sel = doc.getSelection ? doc.getSelection() : null;
    return { doc, active, text: sel ? String(sel) : "" };
  };
`;

function finite(n: number, what: "engine.browserClipboard.badLimit" | "engine.browserClipboard.badCoordinate"): number {
  if (!Number.isFinite(n)) throw engineError("INVALID", what);
  return n;
}

/**
 * Page expression → `{ text }` (the selection, "" = none) or `{ tooLarge: true }`. With `cut`, an editable
 * selection is also deleted — through the editor (`delete` command: undoable, `input` events fire), without touching
 * the engine machine's clipboard.
 */
export function selectionScript(opts: { maxChars: number; cut: boolean }): string {
  const max = Math.floor(finite(opts.maxChars, "engine.browserClipboard.badLimit"));
  return `(() => {${PRELUDE}
  const hit = find(document, 0);
  if (hit.text.length > ${max}) return { tooLarge: true };
  if (${opts.cut === true} && hit.text !== "") { try { hit.doc.execCommand("delete"); } catch (e) {} }
  return { text: hit.text };
})()`;
}

/** Page expression → `{ hasSelection, editable, linkUrl }` for the page point `x`,`y` (CSS px of the viewport). */
export function contextScript(opts: { x: number; y: number; maxUrlLength: number }): string {
  const x = finite(opts.x, "engine.browserClipboard.badCoordinate");
  const y = finite(opts.y, "engine.browserClipboard.badCoordinate");
  const maxUrl = Math.floor(finite(opts.maxUrlLength, "engine.browserClipboard.badLimit"));
  return `(() => {${PRELUDE}
  const hit = find(document, 0);
  const a = hit.active;
  const editable = isField(a) || (!!a && a.isContentEditable === true);
  let doc = document, x = ${x}, y = ${y};
  let el = doc.elementFromPoint(x, y);
  for (let i = 0; i < DEPTH && isFrame(el); i++) {
    const d = inner(el);
    if (!d) break;
    const r = el.getBoundingClientRect();
    x -= r.left + el.clientLeft;
    y -= r.top + el.clientTop;
    doc = d;
    el = doc.elementFromPoint(x, y);
  }
  const link = el && el.closest ? el.closest("a[href]") : null;
  const href = link ? String(link.href) : "";
  return { hasSelection: hit.text !== "", editable, linkUrl: href.length <= ${maxUrl} ? href : "" };
})()`;
}

const SelectionSchema = z.union([z.object({ tooLarge: z.literal(true) }), z.object({ text: z.string() })]);

/** The selection script's answer → the text to copy ("" = nothing). Over `maxChars`: INVALID, never truncated. */
export function parseSelection(value: unknown, maxChars: number): string {
  const r = SelectionSchema.safeParse(value);
  if (!r.success) return "";
  if ("tooLarge" in r.data || r.data.text.length > maxChars) {
    throw engineError("INVALID", "engine.browserClipboard.selectionTooLarge", { max: maxChars });
  }
  return r.data.text;
}

const ContextSchema = z.object({ hasSelection: z.boolean(), editable: z.boolean(), linkUrl: z.unknown().optional() });

function httpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "" || raw.length > BROWSER_LIMITS.maxUrlLength) return undefined;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** The context script's answer → what the app may know; anything unexpected means "nothing here". */
export function parseContext(value: unknown): BrowserContextInfo {
  const r = ContextSchema.safeParse(value);
  if (!r.success) return { hasSelection: false, editable: false };
  const linkUrl = httpUrl(r.data.linkUrl);
  return { hasSelection: r.data.hasSelection, editable: r.data.editable, ...(linkUrl !== undefined ? { linkUrl } : {}) };
}
