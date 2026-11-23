// İş M: the native menu bar. Rebuilt from the pure template whenever the renderer reports a new Görünüm state or the
// site list changes; clicks travel to the renderer as MenuCommands.
import { Menu } from "electron";
import { parseViewMenuState, type MenuCommand, type ViewMenuState } from "../renderer/engine/menu-ipc.ts";
import type { WebSite } from "../renderer/engine/web-ipc.ts";
import { buildMenuTemplate } from "./menu-template.ts";
import { WebError } from "./web-policy.ts";
import { t } from "../i18n/index.ts";

export interface AppMenuDeps {
  appName: string;
  isMac: boolean;
  devTools: boolean;
  sites(): readonly WebSite[];
  send(c: MenuCommand): void;
}

export function createAppMenu(deps: AppMenuDeps) {
  let view: ViewMenuState = { panels: [] };
  const apply = (): void => {
    const template = buildMenuTemplate({ appName: deps.appName, isMac: deps.isMac, devTools: deps.devTools, view, sites: deps.sites() }, deps.send);
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
  return {
    /** Görünüm as the renderer sees it (untrusted IPC input). */
    setView(raw: unknown): void {
      const parsed = parseViewMenuState(raw);
      if (!parsed) throw new WebError(t("main.menu.invalidState"));
      view = parsed;
      apply();
    },
    refresh: apply,
  };
}
