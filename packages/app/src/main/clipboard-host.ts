// Kopyalama — main side: the only place that writes the system clipboard for the page, and the native context menus
// (Kes / Kopyala / Yapıştır / Tümünü seç). Everything arriving here is untrusted IPC input.
import type { MenuItemConstructorOptions } from "electron";
import { utf8Bytes, type ClipboardConfig, type PageMenuRequest } from "../renderer/engine/clipboard-ipc.ts";
import { t } from "../i18n/index.ts";

export class ClipboardError extends Error {}

type Item = MenuItemConstructorOptions;

export interface ClipboardHostDeps {
  config: ClipboardConfig;
  /** Electron `clipboard.writeText`. */
  write(text: string): void;
  /** Shows a native context menu over the app window. */
  popup(template: Item[]): void;
  /** This machine's clipboard holds text (enables Yapıştır). Absent = assume it does. The text itself never leaves main. */
  hasText?(): boolean;
}

/** What Electron's `context-menu` event says about the place that was right-clicked. */
export interface ContextMenuTarget {
  isEditable: boolean;
  selectionText: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

/** The "Kopyala" menu for one value (a path, a command, an id) that is awkward to select. */
export function copyMenuTemplate(cfg: ClipboardConfig, click: () => void): Item[] {
  return [{ label: t("main.contextMenu.copy"), click }];
}

/**
 * Right click on selected text, an input or the terminal (xterm puts its hidden textarea under the pointer).
 * The roles act on whatever has focus, like the Edit menu's. Nothing to copy or edit → no menu.
 */
export function contextMenuTemplate(target: ContextMenuTarget, cfg: ClipboardConfig): Item[] {
  const { editFlags } = target;
  if (target.isEditable) {
    return [
      { role: "cut", label: t("main.contextMenu.cut"), enabled: editFlags.canCut },
      { role: "copy", label: t("main.contextMenu.copy"), enabled: editFlags.canCopy },
      { role: "paste", label: t("main.contextMenu.paste"), enabled: editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: t("main.contextMenu.selectAll"), enabled: editFlags.canSelectAll },
    ];
  }
  if (target.selectionText.trim() !== "") return [{ role: "copy", label: t("main.contextMenu.copy"), enabled: editFlags.canCopy }];
  return [];
}

/** An http(s) address short enough to copy, or undefined. */
function pageUrl(raw: unknown, cfg: ClipboardConfig): string | undefined {
  if (typeof raw !== "string" || raw === "" || raw.length > cfg.pageUrlMaxChars) return undefined;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Right click on the streamed browser page (Tarayıcı panel). Kes / Kopyala / Yapıştır are roles: they reach the
 * focused canvas as `cut` / `copy` / `paste` events, the same path as the Edit menu and the shortcuts. Kes is listed
 * only for an editable selection. The addresses are written here, in main.
 */
export function pageMenuTemplate(req: PageMenuRequest, cfg: ClipboardConfig, env: { hasText: boolean; write(text: string): void }): Item[] {
  const items: Item[] = [
    ...(req.canCut ? [{ role: "cut", label: t("main.contextMenu.cut"), enabled: true } satisfies Item] : []),
    { role: "copy", label: t("main.contextMenu.copy"), enabled: req.canCopy },
    { role: "paste", label: t("main.contextMenu.paste"), enabled: req.canPaste && env.hasText },
  ];
  const link = pageUrl(req.linkUrl, cfg);
  const page = pageUrl(req.pageUrl, cfg);
  if (link !== undefined || page !== undefined) items.push({ type: "separator" });
  if (link !== undefined) items.push({ label: t("main.contextMenu.copyLink"), click: () => env.write(link) });
  if (page !== undefined) items.push({ label: t("main.contextMenu.copyAddress"), click: () => env.write(page) });
  return items;
}

/** Anything from IPC → a PageMenuRequest; the three flags must be real booleans. */
function parsePageMenu(raw: unknown): PageMenuRequest {
  const r = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!r || typeof r.canCopy !== "boolean" || typeof r.canCut !== "boolean" || typeof r.canPaste !== "boolean") {
    throw new ClipboardError(t("main.clipboard.invalidMenuRequest"));
  }
  return {
    canCopy: r.canCopy,
    canCut: r.canCut,
    canPaste: r.canPaste,
    linkUrl: typeof r.linkUrl === "string" ? r.linkUrl : undefined,
    pageUrl: typeof r.pageUrl === "string" ? r.pageUrl : undefined,
  };
}

export function createClipboardHost(deps: ClipboardHostDeps) {
  const { config } = deps;
  const text = (raw: unknown): string => {
    if (typeof raw !== "string" || raw === "") throw new ClipboardError(t("main.clipboard.nothingToCopy"));
    return raw;
  };
  return {
    /** OSC 52 writes of the terminals. */
    writeText(raw: unknown): void {
      const value = text(raw);
      // Cheap bound first: a string longer than the byte cap cannot fit.
      if (value.length > config.osc52MaxBytes || utf8Bytes(value) > config.osc52MaxBytes) throw new ClipboardError(t("main.clipboard.tooLarge"));
      deps.write(value);
    },
    copyMenu(raw: unknown): void {
      const value = text(raw);
      if (value.length > config.copyValueMaxChars) throw new ClipboardError(t("main.clipboard.tooLarge"));
      deps.popup(copyMenuTemplate(config, () => deps.write(value)));
    },
    /** Right click on the streamed browser page. */
    pageMenu(raw: unknown): void {
      const req = parsePageMenu(raw);
      deps.popup(pageMenuTemplate(req, config, { hasText: deps.hasText?.() ?? true, write: (value) => deps.write(value) }));
    },
  };
}
