// İş M — Menüler: contract between Electron main's native menu bar (Görünüm, Git, Yardım), the preload and the
// renderer. Main never decides layout: a menu click becomes a MenuCommand event the renderer acts on, and the renderer
// reports what Görünüm should show (panels, checked/enabled), so the two stay in sync both ways.

export const MENU_IPC = {
  /** main → renderer event: a MenuCommand. */
  command: "menu:command",
  /** renderer → main: the Görünüm panel list (ViewMenuState). */
  viewState: "menu:viewState",
} as const;

/** Commands without arguments. Owners: layout (İş M), terminal font / browser zoom (İş Z), Claude rehberi (İş C). */
export const SIMPLE_MENU_COMMANDS = [
  "layout.reset",
  "terminal.font.smaller",
  "terminal.font.larger",
  "terminal.font.reset",
  "browser.zoom.out",
  "browser.zoom.in",
  "browser.zoom.reset",
  "claude.help",
] as const;
export type SimpleMenuCommand = (typeof SIMPLE_MENU_COMMANDS)[number];

export type MenuCommand =
  | { type: SimpleMenuCommand }
  /** Görünüm › <panel>: open it when closed, close it when open. */
  | { type: "panel.toggle"; panelId: string }
  /** Git › <site>: open (or show) the site's tab in the Web panel. */
  | { type: "site.open"; siteId: string }
  /** Ayarlar… (optionally on a tab, e.g. Git › Siteleri düzenle… → "sites"). */
  | { type: "settings.open"; tab?: string };

export type MenuCommandType = MenuCommand["type"];

export interface ViewMenuItem {
  id: string;
  title: string;
  /** The panel is in the layout. */
  checked: boolean;
  /** It can be toggled for the current selection. */
  enabled: boolean;
}

export interface ViewMenuState {
  panels: ViewMenuItem[];
}

/** Exposed as `window.kokpit.menu`. */
export interface MenuBridge {
  onCommand(listener: (c: MenuCommand) => void): () => void;
  setViewState(state: ViewMenuState): Promise<void>;
}

/** Ids and tab names that may travel in a command (panel ids, site ids, settings tabs). */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_TITLE = 100;
const MAX_PANELS = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isToken = (v: unknown): v is string => typeof v === "string" && TOKEN.test(v);

/** Anything from IPC → a known command, or null. */
export function parseMenuCommand(raw: unknown): MenuCommand | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  const type = raw.type;
  if ((SIMPLE_MENU_COMMANDS as readonly string[]).includes(type)) return { type: type as SimpleMenuCommand };
  if (type === "panel.toggle") return isToken(raw.panelId) ? { type, panelId: raw.panelId } : null;
  if (type === "site.open") return isToken(raw.siteId) ? { type, siteId: raw.siteId } : null;
  if (type === "settings.open") {
    if (raw.tab === undefined) return { type };
    return isToken(raw.tab) ? { type, tab: raw.tab } : null;
  }
  return null;
}

/** Anything from IPC → a ViewMenuState (bad items dropped), or null. */
export function parseViewMenuState(raw: unknown): ViewMenuState | null {
  if (!isRecord(raw) || !Array.isArray(raw.panels)) return null;
  const panels: ViewMenuItem[] = [];
  for (const p of raw.panels.slice(0, MAX_PANELS)) {
    if (!isRecord(p) || !isToken(p.id) || typeof p.title !== "string" || p.title.length === 0 || p.title.length > MAX_TITLE) continue;
    if (panels.some((q) => q.id === p.id)) continue;
    panels.push({ id: p.id, title: p.title, checked: p.checked === true, enabled: p.enabled === true });
  }
  return { panels };
}
