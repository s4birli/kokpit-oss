// Kopyalama — values that are awkward to select (a file's path in the tree, a terminal's command, an agent's id:
// they sit inside buttons, tabs and draggable rows, which stay non-selectable so clicking and dragging keep working).
// Such a row carries its value in `data-copy`; a right click on it opens the native "Kopyala" menu (main process).
// No button, no extra row. Selected text and inputs keep the ordinary native menu (clipboard-host.ts).
import { clipboardConfig, type ClipboardBridge, type ClipboardConfig } from "../engine/clipboard-ipc.ts";

export const COPY_ATTR = "data-copy";
const EDITABLE = "input, textarea, [contenteditable]:not([contenteditable='false'])";

/** Props for the element whose right click offers "Kopyala" for `value`: `<li {...copyValue(path)}>`. */
export function copyValue(value: string | undefined | null): { [COPY_ATTR]?: string } {
  return value ? { [COPY_ATTR]: value } : {};
}

/** Listens for right clicks on `[data-copy]` rows. Returns the function that removes the listener. */
export function installCopyMenu(doc: Document, bridge: Pick<ClipboardBridge, "copyMenu"> | undefined, config: ClipboardConfig = clipboardConfig): () => void {
  if (!bridge) return () => {};
  const onContextMenu = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest(EDITABLE)) return;
    const value = target.closest(`[${COPY_ATTR}]`)?.getAttribute(COPY_ATTR) ?? "";
    if (value === "" || value.length > config.copyValueMaxChars) return;
    // The user selected something: the native menu copies exactly that.
    if ((doc.getSelection()?.toString() ?? "") !== "") return;
    e.preventDefault();
    bridge.copyMenu(value).catch(() => {});
  };
  doc.addEventListener("contextmenu", onContextMenu);
  return () => doc.removeEventListener("contextmenu", onContextMenu);
}
