// İş M — the native menu bar as a pure template (app-menu.ts hands it to Electron). Görünüm shows what the renderer
// reported (ViewMenuState); every click becomes a MenuCommand sent to the renderer. Labels come from the catalogs
// (main.menu.*), accelerators from menu.defaults.json.
import type { MenuItemConstructorOptions } from "electron";
import defaults from "./menu.defaults.json" with { type: "json" };
import type { MenuCommand, SimpleMenuCommand, ViewMenuState } from "../renderer/engine/menu-ipc.ts";
import type { WebSite } from "../renderer/engine/web-ipc.ts";
import { t } from "../i18n/index.ts";

export type MenuConfig = typeof defaults;
export const menuConfig: MenuConfig = defaults;

export interface MenuInput {
  appName: string;
  isMac: boolean;
  /** Development build: Görünüm gets Geliştirici araçları. */
  devTools: boolean;
  view: ViewMenuState;
  sites: readonly WebSite[];
}

type Item = MenuItemConstructorOptions;
const SEPARATOR: Item = { type: "separator" };

/** i18n: the labels in the current language — read when the template is built, so a rebuild follows a switch. */
function menuLabels() {
  return {
    settings: t("main.menu.settings"),
    view: t("main.menu.view"),
    resetLayout: t("main.menu.resetLayout"),
    terminalSmaller: t("main.menu.terminalSmaller"),
    terminalLarger: t("main.menu.terminalLarger"),
    terminalReset: t("main.menu.terminalReset"),
    browserZoomOut: t("main.menu.browserZoomOut"),
    browserZoomIn: t("main.menu.browserZoomIn"),
    browserZoomReset: t("main.menu.browserZoomReset"),
    devTools: t("main.menu.devTools"),
    go: t("main.menu.go"),
    editSites: t("main.menu.editSites"),
    noSites: t("main.menu.noSites"),
    help: t("main.menu.help"),
    claudeHelp: t("main.menu.claudeHelp"),
  };
}

export function buildMenuTemplate(input: MenuInput, send: (c: MenuCommand) => void, cfg: MenuConfig = menuConfig): Item[] {
  const { accelerators } = cfg;
  const labels = menuLabels();
  const command = (label: keyof ReturnType<typeof menuLabels>, type: SimpleMenuCommand): Item => {
    const accelerator = (accelerators as Partial<Record<string, string>>)[label];
    return { label: labels[label], ...(accelerator !== undefined ? { accelerator } : {}), click: () => send({ type }) };
  };
  const settings: Item = { label: labels.settings, accelerator: accelerators.settings, click: () => send({ type: "settings.open" }) };

  const appMenu: Item = input.isMac
    ? {
        label: input.appName,
        submenu: [
          { role: "about" },
          SEPARATOR,
          settings,
          SEPARATOR,
          { role: "services" },
          SEPARATOR,
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          SEPARATOR,
          { role: "quit" },
        ],
      }
    : { label: input.appName, submenu: [settings, SEPARATOR, { role: "quit" }] };

  const view: Item = {
    label: labels.view,
    submenu: [
      ...input.view.panels.map<Item>((p) => ({
        label: p.title,
        type: "checkbox",
        checked: p.checked,
        enabled: p.enabled,
        click: () => send({ type: "panel.toggle", panelId: p.id }),
      })),
      SEPARATOR,
      { label: labels.resetLayout, click: () => send({ type: "layout.reset" }) },
      SEPARATOR,
      command("terminalSmaller", "terminal.font.smaller"),
      command("terminalLarger", "terminal.font.larger"),
      command("terminalReset", "terminal.font.reset"),
      SEPARATOR,
      command("browserZoomOut", "browser.zoom.out"),
      command("browserZoomIn", "browser.zoom.in"),
      command("browserZoomReset", "browser.zoom.reset"),
      ...(input.devTools ? [SEPARATOR, { label: labels.devTools, role: "toggleDevTools", accelerator: accelerators.devTools } satisfies Item] : []),
    ],
  };

  const sites: Item[] =
    input.sites.length > 0
      ? input.sites.map((s) => ({ label: s.title, click: () => send({ type: "site.open", siteId: s.id }) }))
      : [{ label: labels.noSites, enabled: false }];
  const go: Item = {
    label: labels.go,
    submenu: [...sites, SEPARATOR, { label: labels.editSites, click: () => send({ type: "settings.open", tab: cfg.sitesSettingsTab }) }],
  };

  const help: Item = { label: labels.help, role: "help", submenu: [command("claudeHelp", "claude.help")] };

  return [appMenu, { role: "editMenu" }, view, go, { role: "windowMenu" }, help];
}
