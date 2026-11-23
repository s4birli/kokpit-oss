// Kopyalama — the canvases of the streamed panels (Tarayıcı, …). The Düzen menu's Kopyala / Kes /
// Yapıştır (also reached by their key equivalents) and the context menu's roles end in the browser's `copy` / `cut` /
// `paste` events. Chromium aims those at the element of the current TEXT SELECTION — or at <body> when nothing is
// selected — never at the focused canvas. So they are caught on the document, and belong to the panel whenever its
// canvas has the keyboard focus. They are then cancelled and stopped: a stale selection somewhere else in the app
// (a file preview, say) is not what gets copied, and no other listener handles them a second time.
export interface CanvasClipboardHandlers {
  copy(): void;
  cut(): void;
  /** The clipboard's plain text ("" = none). */
  paste(text: string): void;
}

const ACTIONS = ["copy", "cut", "paste"] as const;
/** Chromium offers copy / cut / paste on a non-editable element only when its `before…` event is cancelled. */
const BEFORE = ["beforecopy", "beforecut", "beforepaste"] as const;

/** Returns the function that removes the listeners. */
export function attachCanvasClipboard(canvas: HTMLCanvasElement, handlers: CanvasClipboardHandlers): () => void {
  const doc = canvas.ownerDocument;
  const mine = (): boolean => doc.activeElement === canvas;

  const onAction = (e: Event): void => {
    if (!mine()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "copy") handlers.copy();
    else if (e.type === "cut") handlers.cut();
    else handlers.paste((e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "");
  };
  const onBefore = (e: Event): void => {
    if (mine()) e.preventDefault();
  };

  for (const name of ACTIONS) doc.addEventListener(name, onAction, true);
  for (const name of BEFORE) doc.addEventListener(name, onBefore, true);
  return () => {
    for (const name of ACTIONS) doc.removeEventListener(name, onAction, true);
    for (const name of BEFORE) doc.removeEventListener(name, onBefore, true);
  };
}
