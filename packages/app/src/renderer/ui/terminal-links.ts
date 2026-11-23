// Bağlantılar — links in a terminal: addresses a program printed as plain text (Claude Code's answers, a dev
// server's "Local: http://localhost:3000") and OSC 8 hyperlinks. A link opens in the terminal's PROJECT browser, and
// only as the direct result of the user's gesture on it — nothing here reacts to output by opening something.
//
//   ⌘ click            opens the link — also while the program tracks the mouse (Claude Code does): the click is
//                      taken here, in the capture phase, and never reaches xterm or the program.
//   plain click        opens it only when the program does NOT track the mouse (links.defaults.json
//                      `plainClickOpens`); otherwise the click is the program's, as before.
//   ⌥⌘ click           the default browser of this machine.
//   right click        native menu: Tarayıcıda aç / Varsayılan tarayıcıda aç / Bağlantıyı kopyala (main process).
//   hover              tooltip with the REAL target and where it will open; the underline shows when a click
//                      would open it (⌘ held, or no mouse tracking).
//
// xterm's part: its Linkifier asks the provider below for the links of the row under the pointer and calls their
// `hover` / `leave`; for OSC 8 it calls `options.linkHandler`. Both only tell this module which link is under the
// pointer. Activation is decided here (link-actions.ts), so xterm's own `activate` — which for OSC 8 showed an
// English confirm() and then opened nothing — does nothing.
// OSC 8 can show one text and point elsewhere: the tooltip and the menu always show the target, and a link whose
// text reads like another host's address is opened only after the user confirmed it, with both shown.
//
// Yollar: local file paths in the output ("open ~/Documents/rapor/index.html", "src/a.ts") are links too, with the
// same gestures. What a path points at is asked from the engine only when the user rests on it or acts on it — never
// per mouse move; a page opens in the project's browser, a file of the project in Dosyalar (link-actions.ts).
// Kept apart from xterm-view.ts so it runs against a minimal terminal in unit tests.
import { deceptiveLinkText, findLinks, findPaths, parseLinkTarget, type FoundPath, type LinkTarget } from "@kokpit/shared";
import { t } from "../../i18n/index.ts";
import { shortenUrl, type LinksConfig } from "../engine/links-ipc.ts";
import { errorMessage } from "./errors.ts";
import { linkGesture, linkTooltip, pathTooltip, type LinkGesture, type LinkTooltip } from "./link-actions.ts";
import type { PathLinkRef, TerminalLinkHost } from "./link-opener.ts";

const PRIMARY_BUTTON = 0;
const SECONDARY_BUTTON = 2;
const TIP_CLASS = "kp-term__linktip";
const CONFIRM_CLASS = "kp-term__linkconfirm";
const NOTE_CLASS = "kp-term__linknote";

/** 1-based, inclusive — xterm's IBufferRange. */
export interface LinkRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}
interface LinkDecorations {
  underline: boolean;
  pointerCursor: boolean;
}
/** xterm's ILink. */
export interface ProvidedLink {
  range: LinkRange;
  text: string;
  decorations?: LinkDecorations;
  activate(event: MouseEvent, text: string): void;
  hover?(event: MouseEvent, text: string): void;
  leave?(event: MouseEvent, text: string): void;
}
export interface LinkProvider {
  provideLinks(bufferLineNumber: number, callback: (links: ProvidedLink[] | undefined) => void): void;
}
/** xterm's ILinkHandler (OSC 8). */
export interface OscLinkHandler {
  activate(event: MouseEvent, text: string, range: LinkRange): void;
  hover?(event: MouseEvent, text: string, range: LinkRange): void;
  leave?(event: MouseEvent, text: string, range: LinkRange): void;
  allowNonHttpProtocols?: boolean;
}
interface LinkBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}
/** The part of xterm's `Terminal` used here. */
export interface LinkTerm {
  readonly cols: number;
  buffer: { active: { getLine(y: number): LinkBufferLine | undefined } };
  modes: { readonly mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any" };
  options: { linkHandler?: OscLinkHandler | null };
  registerLinkProvider(provider: LinkProvider): { dispose(): void };
  hasSelection(): boolean;
}

export interface TerminalLinksDeps {
  host: TerminalLinkHost;
  config: LinksConfig;
  isMac: boolean;
}

/** The link under the pointer. */
interface Hovered {
  /** Same link, same place (survives xterm re-rendering the row). */
  key: string;
  /** The target as the program wrote it. */
  url: string;
  target: LinkTarget;
  /** OSC 8: the address the link's text reads as, when that is another host's. */
  shown: string | null;
  /** A plain-text link: its decorations follow the modifier keys. */
  link: ProvidedLink | undefined;
  /** Yollar: set when the link is a local file path (then `url` is the path as written, and `target` is unused). */
  path?: PathLinkRef;
  /** The request comes from the link's menu (the item names what to do), not from a click. */
  viaMenu?: boolean;
  clientX: number;
  clientY: number;
}

const keyOf = (url: string, r: LinkRange): string => `${r.start.y}:${r.start.x}-${r.end.y}:${r.end.x} ${url}`;

/** Something found in a row's text: UTF-16 offsets into the joined line. */
interface Span {
  start: number;
  end: number;
}

/**
 * What `find` finds in the (soft-wrapped) line that buffer row `y` (1-based) belongs to, as xterm link ranges.
 * `onFound` builds the link object for each. Undefined when there is no such row.
 */
function foundInRow<F extends Span, T>(term: Pick<LinkTerm, "cols" | "buffer">, y: number, maxRows: number, find: (text: string) => F[], onFound: (found: F, range: LinkRange) => T): T[] | undefined {
  const buffer = term.buffer.active;
  const row = y - 1;
  if (!Number.isInteger(row) || row < 0 || !buffer.getLine(row)) return undefined;
  let first = row;
  let last = row;
  let rows = 1;
  while (first > 0 && rows < maxRows && buffer.getLine(first)?.isWrapped === true) {
    first--;
    rows++;
  }
  while (rows < maxRows && buffer.getLine(last + 1)?.isWrapped === true) {
    last++;
    rows++;
  }
  // The line goes on beyond what is joined: an address touching that edge may be only a part of one.
  const cutStart = buffer.getLine(first)?.isWrapped === true && first > 0;
  const cutEnd = buffer.getLine(last + 1)?.isWrapped === true;

  let text = "";
  /** For every UTF-16 unit of `text`: the cell it is drawn in. */
  const cells: { x: number; y: number; width: number }[] = [];
  for (let r = first; r <= last; r++) {
    const line = buffer.getLine(r);
    if (!line) break;
    const width = Math.min(line.length, term.cols);
    for (let x = 0; x < width; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      const cellWidth = cell.getWidth();
      // The second half of a wide character.
      if (cellWidth === 0) continue;
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) cells.push({ x, y: r, width: cellWidth });
      text += chars;
    }
  }
  const end = text.trimEnd().length;
  const out: T[] = [];
  for (const found of find(text)) {
    if ((cutStart && found.start === 0) || (cutEnd && found.end === end)) continue;
    const a = cells[found.start];
    const b = cells[found.end - 1];
    if (!a || !b) continue;
    out.push(onFound(found, { start: { x: a.x + 1, y: a.y + 1 }, end: { x: b.x + b.width, y: b.y + 1 } }));
  }
  return out;
}

/**
 * The plain-text links of the (soft-wrapped) line that buffer row `y` (1-based) belongs to, as xterm link ranges.
 * `onLink` builds the link object for each.
 */
export function linksOfRow<T>(term: Pick<LinkTerm, "cols" | "buffer">, y: number, maxRows: number, onLink: (url: string, range: LinkRange) => T): T[] | undefined {
  return foundInRow(term, y, maxRows, findLinks, (found, range) => onLink(found.url, range));
}

/** Yollar: the same for the local file paths of that line (never text that is part of an address). */
export function pathsOfRow<T>(term: Pick<LinkTerm, "cols" | "buffer">, y: number, maxRows: number, onPath: (found: FoundPath, range: LinkRange) => T): T[] | undefined {
  return foundInRow(term, y, maxRows, findPaths, onPath);
}

export function attachTerminalLinks(term: LinkTerm, container: HTMLElement, deps: TerminalLinksDeps): { dispose(): void } {
  const { config, host } = deps;
  const doc = container.ownerDocument;
  const tracking = (): boolean => term.modes.mouseTrackingMode !== "none";
  /** Whether a plain click opens this kind of link at all (links.defaults.json). */
  const plainOpens = (h: Pick<Hovered, "path"> | null): boolean => (h?.path ? config.pathPlainClickOpens : config.plainClickOpens);
  const gestureOf = (e: MouseEvent): LinkGesture => linkGesture(e, { tracking: tracking(), plainClickOpens: plainOpens(hovered), isMac: deps.isMac });
  const isAccel = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => (deps.isMac ? e.metaKey : e.ctrlKey);

  let hovered: Hovered | null = null;
  /** ⌘ (Ctrl elsewhere) is held, as far as the last key or mouse event said. */
  let accelDown = false;
  let down: { key: string; x: number; y: number; gesture: LinkGesture; accel: boolean } | null = null;

  // ---- what the user sees: underline, tooltip, confirmation, notice ----

  /** A plain-text link is underlined exactly when a click would open it now. */
  const clickOpens = (path = hovered?.path !== undefined): boolean => accelDown || ((path ? config.pathPlainClickOpens : config.plainClickOpens) && !tracking());
  const applyDecorations = (): void => {
    const decorations = hovered?.link?.decorations;
    if (!decorations) return;
    const on = clickOpens(hovered?.path !== undefined);
    if (decorations.underline !== on) decorations.underline = on;
    if (decorations.pointerCursor !== on) decorations.pointerCursor = on;
  };
  const setAccel = (on: boolean): void => {
    if (accelDown === on) return;
    accelDown = on;
    applyDecorations();
  };

  let tip: HTMLElement | undefined;
  /** The link the tooltip is shown — or about to be shown — for. */
  let tipKey: string | undefined;
  let tipTimer: ReturnType<typeof setTimeout> | undefined;
  let tipHide: ReturnType<typeof setTimeout> | undefined;
  const hideTip = (): void => {
    if (tipTimer !== undefined) clearTimeout(tipTimer);
    if (tipHide !== undefined) clearTimeout(tipHide);
    tipTimer = tipHide = undefined;
    tipKey = undefined;
    tip?.remove();
    tip = undefined;
  };
  /** What the tooltip of a path says now; when the engine has not been asked yet, it is — and the tooltip follows. */
  const pathTip = (h: Hovered, ref: PathLinkRef): LinkTooltip => {
    const paths = host.path;
    const known = paths?.peek(ref);
    if (paths && !known && host.destination() !== "external") {
      void paths.resolve(ref).then(() => {
        // Still resting on the same path, with its tooltip up: say what was found.
        if (tip && tipKey === h.key && hovered?.key === h.key) showTip(hovered);
      });
    }
    return pathTooltip(h.url, known ?? { status: "pending" }, host.destination(), { tracking: tracking(), plainClickOpens: config.pathPlainClickOpens, machineName: host.machineName() }, config);
  };
  const showTip = (h: Hovered): void => {
    tip?.remove();
    const content = h.path
      ? pathTip(h, h.path)
      : linkTooltip(h.target, host.destination(), { tracking: tracking(), plainClickOpens: config.plainClickOpens, machineName: host.machineName(), shown: h.shown }, config, h.url);
    const el = doc.createElement("div");
    // `xterm-hover`: xterm's Linkifier ignores pointer moves over such an element.
    el.className = `${TIP_CLASS} xterm-hover`;
    el.setAttribute("role", "tooltip");
    if (!content.openable) el.dataset.refused = "true";
    if (content.url !== "") {
      const url = doc.createElement("span");
      url.className = `${TIP_CLASS}-url`;
      url.textContent = content.url;
      el.append(url);
    }
    for (const line of content.lines) {
      const row = doc.createElement("span");
      row.className = `${TIP_CLASS}-line`;
      row.textContent = line;
      el.append(row);
    }
    container.append(el);
    // Under the pointer, inside the terminal: flipped above it near the bottom edge, pulled in at the right edge.
    const box = container.getBoundingClientRect();
    const left = Math.max(0, Math.min(h.clientX - box.left, box.width - el.offsetWidth));
    const below = h.clientY - box.top + config.tooltipOffsetPx;
    const top = below + el.offsetHeight > box.height ? Math.max(0, h.clientY - box.top - config.tooltipOffsetPx - el.offsetHeight) : below;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    tip = el;
  };

  let note: HTMLElement | undefined;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const removeNote = (): void => {
    if (noteTimer !== undefined) clearTimeout(noteTimer);
    noteTimer = undefined;
    note?.remove();
    note = undefined;
  };
  const showNote = (message: string): void => {
    removeNote();
    note = doc.createElement("p");
    note.className = NOTE_CLASS;
    note.setAttribute("role", "status");
    note.textContent = message;
    container.append(note);
    noteTimer = setTimeout(removeNote, config.noticeMs);
  };

  const open = (url: string, where: "project" | "external"): void => {
    host.open(url, where).catch((err: unknown) => showNote(errorMessage(err)));
  };

  let confirm: HTMLElement | undefined;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const removeConfirm = (): void => {
    if (confirmTimer !== undefined) clearTimeout(confirmTimer);
    confirmTimer = undefined;
    confirm?.remove();
    confirm = undefined;
  };
  /** The link's text reads like another host's address: both are shown, and the user decides. */
  const askConfirm = (url: string, target: string, shown: string, where: "project" | "external"): void => {
    removeConfirm();
    const el = doc.createElement("div");
    el.className = CONFIRM_CLASS;
    el.setAttribute("role", "alertdialog");
    el.setAttribute("aria-label", t("links.text.confirmTitle"));
    const line = (label: string, value: string, kind: string): HTMLElement => {
      const row = doc.createElement("p");
      row.className = `${CONFIRM_CLASS}-row`;
      row.dataset.kind = kind;
      const name = doc.createElement("span");
      name.textContent = `${label}: `;
      const address = doc.createElement("strong");
      address.textContent = shortenUrl(value, config.tooltipMaxChars);
      row.append(name, address);
      return row;
    };
    const title = doc.createElement("p");
    title.className = `${CONFIRM_CLASS}-title`;
    title.textContent = t("links.text.confirmTitle");
    const button = (label: string, className: string, onClick: () => void): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = className;
      b.textContent = label;
      b.addEventListener("click", onClick);
      return b;
    };
    const actions = doc.createElement("div");
    actions.className = `${CONFIRM_CLASS}-actions`;
    actions.append(
      button(t("links.text.confirmCancel"), "kp-btn", removeConfirm),
      button(t("links.text.confirmOpen"), "kp-btn kp-btn--danger", () => {
        removeConfirm();
        open(url, where);
      }),
    );
    el.append(title, line(t("links.text.confirmShown"), shown, "shown"), line(t("links.text.confirmTarget"), target, "target"), actions);
    container.append(el);
    confirm = el;
    confirmTimer = setTimeout(removeConfirm, config.confirmMs);
  };

  /** The user asked for this link — by a click, or from its menu. */
  const activate = (h: Hovered, where: "project" | "external" | "files"): void => {
    hideTip();
    if (h.path) {
      // A path has no "default browser": every click is the same request; the menu names its choice.
      host.path?.open(h.path, where === "files" ? "files" : where === "project" && h.viaMenu ? "browser" : "auto").catch((err: unknown) => showNote(errorMessage(err)));
      return;
    }
    if (where === "files") return;
    // Never opened; the tooltip said why.
    if (h.target.kind !== "web") return;
    if (h.shown !== null) askConfirm(h.url, h.target.url, h.shown, where);
    else open(h.url, where);
  };

  // ---- which link is under the pointer (told by xterm) ----

  const enter = (e: MouseEvent, info: Pick<Hovered, "key" | "url" | "shown" | "link" | "path">): void => {
    if (tipHide !== undefined) clearTimeout(tipHide);
    tipHide = undefined;
    hovered = { ...info, target: parseLinkTarget(info.url), clientX: e.clientX, clientY: e.clientY };
    setAccel(isAccel(e));
    // xterm swaps the link's `decorations` for its own tracked object right after this callback returns.
    queueMicrotask(applyDecorations);
    // xterm re-renders a row by leaving and re-entering its link (a program that keeps redrawing does so all the
    // time): the tooltip — shown or still waiting — carries on.
    if (tipKey === info.key && (tip !== undefined || tipTimer !== undefined)) return;
    hideTip();
    const key = info.key;
    tipKey = key;
    tipTimer = setTimeout(() => {
      tipTimer = undefined;
      if (hovered?.key === key) showTip(hovered);
      else tipKey = undefined;
    }, config.tooltipDelayMs);
  };
  const leave = (key: string): void => {
    if (hovered?.key !== key) return;
    hovered = null;
    // Not at once: see `enter`.
    if (tip && tipHide === undefined) tipHide = setTimeout(hideTip, 0);
  };

  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      let links: ProvidedLink[] | undefined;
      try {
        links = linksOfRow(term, y, config.maxWrappedRows, (url, range) => {
          const key = keyOf(url, range);
          const on = clickOpens();
          const link: ProvidedLink = {
            range,
            text: url,
            decorations: { underline: on, pointerCursor: on },
            // Decided by the mouse handlers below, not by xterm.
            activate: () => {},
            hover: (e) => enter(e, { key, url, shown: null, link }),
            leave: () => leave(key),
          };
          return link;
        });
        // Yollar: only where the host can act on them (it knows the terminal).
        const paths = host.path
          ? pathsOfRow(term, y, config.maxWrappedRows, (found, range) => {
              const key = keyOf(`path:${found.path}`, range);
              const on = clickOpens(true);
              const link: ProvidedLink = {
                range,
                text: found.text,
                decorations: { underline: on, pointerCursor: on },
                activate: () => {},
                hover: (e) => enter(e, { key, url: found.path, shown: null, link, path: { path: found.path, tail: found.tail } }),
                leave: () => leave(key),
              };
              return link;
            })
          : undefined;
        if (paths && paths.length > 0) links = [...(links ?? []), ...paths];
      } catch {
        links = undefined;
      }
      callback(links);
    },
  });

  /** The text an OSC 8 link shows on this row. */
  const visibleText = (range: LinkRange): string => {
    try {
      return term.buffer.active.getLine(range.start.y - 1)?.translateToString(false, range.start.x - 1, range.end.x) ?? "";
    } catch {
      return "";
    }
  };
  const previousHandler = term.options.linkHandler;
  term.options.linkHandler = {
    // Every scheme arrives, so a refused one can say so (and be copied); none of them is opened by xterm.
    allowNonHttpProtocols: true,
    activate: () => {},
    hover: (e, uri, range) => enter(e, { key: keyOf(uri, range), url: uri, shown: deceptiveLinkText(visibleText(range), uri), link: undefined }),
    leave: (_e, uri, range) => leave(keyOf(uri, range)),
  };

  // ---- the gestures; capture phase: before xterm's own listeners (they sit on elements inside the container) ----

  const ownUi = (target: EventTarget | null): boolean =>
    target instanceof Node && ((tip?.contains(target) ?? false) || (confirm?.contains(target) ?? false) || (note?.contains(target) ?? false));

  const onMouseDown = (e: MouseEvent): void => {
    if (ownUi(e.target)) return;
    setAccel(isAccel(e));
    down = null;
    if (!hovered) return;
    hideTip();
    // The menu comes with `contextmenu` (also ⌃ click on macOS): the program does not get this press.
    if (e.button === SECONDARY_BUTTON || (deps.isMac && e.button === PRIMARY_BUTTON && e.ctrlKey)) {
      e.stopImmediatePropagation();
      return;
    }
    const gesture = gestureOf(e);
    if (gesture === "none") return;
    down = { key: hovered.key, x: e.clientX, y: e.clientY, gesture, accel: isAccel(e) };
    if (down.accel) {
      // ⌘ click on a link is the user's, not the program's: xterm neither reports nor selects. No default either,
      // so the keyboard focus stays where it is.
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };
  const onMouseUp = (e: MouseEvent): void => {
    if (ownUi(e.target)) return;
    const press = down;
    down = null;
    if (hovered && (e.button === SECONDARY_BUTTON || (deps.isMac && e.button === PRIMARY_BUTTON && e.ctrlKey))) {
      e.stopImmediatePropagation();
      return;
    }
    if (!press || e.button !== PRIMARY_BUTTON) return;
    // Its press never reached xterm either.
    if (press.accel) e.stopImmediatePropagation();
    if (!hovered || hovered.key !== press.key) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > config.clickMaxMovePx) return;
    // A plain click that ended a selection (or made one) selects; it does not open.
    if (!press.accel && term.hasSelection()) return;
    activate(hovered, press.gesture === "external" ? "external" : "project");
  };
  const onMouseMove = (e: MouseEvent): void => setAccel(isAccel(e));
  const onContextMenu = (e: MouseEvent): void => {
    if (ownUi(e.target) || !hovered) return;
    // Kokpit's link menu instead of the terminal's Kes / Kopyala / Yapıştır one; xterm does not select the word.
    e.preventDefault();
    e.stopImmediatePropagation();
    hideTip();
    const h: Hovered = { ...hovered, viaMenu: true };
    (h.path ? (host.path?.menu(h.path) ?? Promise.resolve(null)) : host.menu(h.url)).then(
      (choice) => {
        if (choice === "browser") activate(h, "project");
        else if (choice === "external") activate(h, "external");
        else if (choice === "files") activate(h, "files");
      },
      (err: unknown) => showNote(errorMessage(err)),
    );
  };
  const accelKey = deps.isMac ? "Meta" : "Control";
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === accelKey) setAccel(e.type === "keydown");
    if (e.type === "keydown" && e.key === "Escape" && confirm) {
      e.stopImmediatePropagation();
      e.preventDefault();
      removeConfirm();
    }
  };
  const onBlur = (): void => setAccel(false);

  container.addEventListener("mousedown", onMouseDown, true);
  container.addEventListener("mouseup", onMouseUp, true);
  container.addEventListener("mousemove", onMouseMove, true);
  container.addEventListener("contextmenu", onContextMenu, true);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("keyup", onKey, true);
  doc.defaultView?.addEventListener("blur", onBlur);

  return {
    dispose(): void {
      container.removeEventListener("mousedown", onMouseDown, true);
      container.removeEventListener("mouseup", onMouseUp, true);
      container.removeEventListener("mousemove", onMouseMove, true);
      container.removeEventListener("contextmenu", onContextMenu, true);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("keyup", onKey, true);
      doc.defaultView?.removeEventListener("blur", onBlur);
      hovered = null;
      down = null;
      hideTip();
      removeConfirm();
      removeNote();
      provider.dispose();
      term.options.linkHandler = previousHandler ?? null;
    },
  };
}
