// Girişler: the page side of "Doldur" — two functions the engine calls in the active tab over CDP, and the parsing
// of their answers.
//
// Where they run: in an ISOLATED WORLD of the tab's main frame (`Page.createIsolatedWorld`, see browser-isolated.ts).
// An isolated world shares the page's DOM but has its own JavaScript globals, so nothing the page's scripts
// redefined (`querySelectorAll`, `HTMLInputElement.prototype`, `origin`…) is used here, and the page cannot call
// into it. The world belongs to one document: if the tab navigates in between, the call fails instead of running
// in the new page.
//
// The anti-phishing rule lives INSIDE the fill function: it compares the document's origin with the login's and
// does nothing else when they differ. Check and fill are one synchronous call in one document — there is no moment
// between them in which the page could change. Exact string equality of `scheme://host:port`; a subdomain is
// another site.
//
// The username and password reach the page as ARGUMENTS of `Runtime.callFunctionOn`; they are never written into
// script text. The functions return which fields were filled — never a value.
//
// Which fields (v1):
//   - the focused field first: a focused password field is the password field; a focused text / e-mail field is the
//     username field when a password field follows it (or it is clearly a username field);
//   - otherwise the visible, enabled password field of a group (form, or the form-less fields of a document) that
//     has exactly ONE password field and is not marked `autocomplete=new-password`; failing that, one marked
//     `current-password`. A page that only has sign-up / change-password groups (two or more password fields) is
//     ambiguous: nothing is filled until the user clicks the field they mean;
//   - username = the field marked `autocomplete=username` in the password's group, else the closest visible
//     text / e-mail / tel field before it; on a page without any password field (first step of a two-step login)
//     the single field marked `autocomplete=username` or of type e-mail;
//   - same-origin frames are searched too (`fillFrameDepth` levels); cross-origin frames and closed shadow roots
//     are not reached, and fields inside open shadow roots are only found when focused.
// Values are set with the native `value` setter followed by `input` and `change` events — what React, Vue and
// Angular listen to. Nothing is submitted.
import { LOGIN_FILL_FIELDS, LOGIN_LIMITS, type LoginFillField } from "@kokpit/shared";
import { st } from "@kokpit/shared/i18n";
import { z } from "zod";
import { EngineError, engineError } from "./contracts.ts";

/** `function () → { origin }`: the origin of the tab's top-level document. Takes no arguments. */
export const LOGIN_PROBE_FUNCTION = `function () { return { origin: String(self.origin) }; }`;

/**
 * `function (origin, username, password, maxDepth) → { status, … }`:
 *   `{ status: "origin", origin }`  the page is another site — nothing was looked at;
 *   `{ status: "nofields" }`        nothing to fill;
 *   `{ status: "ambiguous" }`       only groups with several password fields, and none is focused;
 *   `{ status: "ok", filled }`      the names of the fields that now hold the values.
 */
export const LOGIN_FILL_FUNCTION = `function (expectedOrigin, username, password, maxDepth) {
  const pageOrigin = String(self.origin);
  if (pageOrigin !== expectedOrigin) return { status: "origin", origin: pageOrigin };

  const frameDoc = (el) => {
    try {
      const d = el.contentDocument, w = el.contentWindow;
      return d && w && String(w.origin) === expectedOrigin ? d : null;
    } catch (e) { return null; }
  };
  const docs = [];
  const walk = (doc, depth) => {
    docs.push(doc);
    if (depth >= maxDepth) return;
    for (const f of doc.querySelectorAll("iframe, frame")) {
      const d = frameDoc(f);
      if (d) walk(d, depth + 1);
    }
  };
  walk(document, 0);

  const isInput = (el) => !!el && el.tagName === "INPUT";
  const kind = (el) => String(el.type || "text").toLowerCase();
  const isPassword = (el) => isInput(el) && kind(el) === "password";
  const isText = (el) => isInput(el) && ["text", "email", "tel"].includes(kind(el));
  const tokens = (el) => String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
  const marked = (el, token) => tokens(el).includes(token);
  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  /** The fields that belong together: a form's, or the form-less ones of the same document / shadow root. */
  const group = (el) => {
    if (el.form) return Array.from(el.form.elements).filter(isInput);
    const root = el.getRootNode();
    return Array.from(root.querySelectorAll("input")).filter((x) => !x.form);
  };
  const groupKey = (el) => el.form || el.getRootNode();

  const deepActive = (doc, depth) => {
    let a = doc.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (a && (a.tagName === "IFRAME" || a.tagName === "FRAME") && depth < maxDepth) {
      const d = frameDoc(a);
      return d ? deepActive(d, depth + 1) : null;
    }
    return a;
  };
  const usernameFor = (pw) => {
    const fields = group(pw);
    const before = fields.slice(0, fields.indexOf(pw)).filter((x) => isText(x) && visible(x));
    return fields.find((x) => isText(x) && visible(x) && marked(x, "username")) || before[before.length - 1] || null;
  };

  let user = null, pw = null;
  const active = deepActive(document, 0);
  if (isPassword(active) && visible(active)) {
    pw = active;
  } else if (isText(active) && visible(active)) {
    const fields = group(active);
    const next = fields.slice(fields.indexOf(active) + 1).find((x) => isPassword(x) && visible(x)) || null;
    if (next) { user = active; pw = next; }
    else if (!fields.some((x) => isPassword(x) && visible(x)) && (marked(active, "username") || kind(active) === "email")) user = active;
  }
  if (!user && !pw) {
    const all = [];
    for (const d of docs) for (const el of d.querySelectorAll("input")) if (isPassword(el) && visible(el)) all.push(el);
    const sizes = new Map();
    for (const el of all) sizes.set(groupKey(el), (sizes.get(groupKey(el)) || 0) + 1);
    pw = all.find((el) => sizes.get(groupKey(el)) === 1 && !marked(el, "new-password")) || all.find((el) => marked(el, "current-password")) || null;
    if (!pw && all.length > 0) return { status: "ambiguous" };
    if (!pw) {
      const names = [];
      for (const d of docs) for (const el of d.querySelectorAll("input")) if (isText(el) && visible(el) && (marked(el, "username") || kind(el) === "email")) names.push(el);
      if (names.length !== 1) return { status: "nofields" };
      user = names[0];
    }
  }
  if (pw && !user) user = usernameFor(pw);

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const put = (el, value) => {
    try { el.focus(); } catch (e) {}
    setter.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === value;
  };
  const filled = [];
  if (user && put(user, username)) filled.push("username");
  if (pw && put(pw, password)) filled.push("password");
  return { status: "ok", filled };
}`;

const ProbeSchema = z.object({ origin: z.string().max(LOGIN_LIMITS.maxOriginChars * 4) });
const FillSchema = z.union([
  z.object({ status: z.literal("origin"), origin: z.string().max(LOGIN_LIMITS.maxOriginChars * 4) }),
  z.object({ status: z.literal("nofields") }),
  z.object({ status: z.literal("ambiguous") }),
  z.object({ status: z.literal("ok"), filled: z.array(z.enum(LOGIN_FILL_FIELDS)).max(LOGIN_FILL_FIELDS.length) }),
]);

export const LOGIN_FILL_TEXT = {
  noAnswer: "engine.browserLoginFill.noAnswer",
  noFields: "engine.browserLoginFill.noFields",
  ambiguous: "engine.browserLoginFill.ambiguous",
  notFilled: "engine.browserLoginFill.notFilled",
} as const;

/** A page origin for a message: only what can be an origin is shown (the text comes from the page's process). */
function shownOrigin(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9.\-[\]:]+$/.test(raw) && raw.length <= LOGIN_LIMITS.maxOriginChars ? raw : st("engine.browserLoginFill.nonHttpPage");
}

/** The anti-phishing refusal. Names both sites, so the user sees which one is open. */
export function originMismatch(saved: string, page: string): EngineError {
  return engineError("INVALID", "engine.browserLoginFill.originMismatch", { saved, page: shownOrigin(page) });
}

/**
 * Saving is refused unless the site being saved is the one open in the project's browser: a stale or forged client
 * cannot bind credentials to a site the user is not looking at.
 */
export function saveOriginMismatch(requested: string, page: string): EngineError {
  return engineError("INVALID", "engine.browserLoginFill.saveOriginMismatch", { requested, page: shownOrigin(page) });
}

/** The probe's answer → the open page's origin (untrusted text, compared by equality only). */
export function parseProbe(value: unknown): string {
  const r = ProbeSchema.safeParse(value);
  if (!r.success) throw engineError("INVALID", LOGIN_FILL_TEXT.noAnswer);
  return r.data.origin;
}

/** The fill function's answer → the filled fields, or the refusal as an EngineError. Never carries a value. */
export function parseFill(value: unknown, savedOrigin: string): LoginFillField[] {
  const r = FillSchema.safeParse(value);
  if (!r.success) throw engineError("INVALID", LOGIN_FILL_TEXT.noAnswer);
  const d = r.data;
  if (d.status === "origin") throw originMismatch(savedOrigin, d.origin);
  if (d.status === "nofields") throw engineError("INVALID", LOGIN_FILL_TEXT.noFields);
  if (d.status === "ambiguous") throw engineError("INVALID", LOGIN_FILL_TEXT.ambiguous);
  const filled = LOGIN_FILL_FIELDS.filter((f) => d.filled.includes(f));
  if (filled.length === 0) throw engineError("INVALID", LOGIN_FILL_TEXT.notFilled);
  return filled;
}
