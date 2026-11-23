// Exposes exactly one object to the renderer: window.kokpit (SettingsBridge + İş B's `browser` + İş L's `uiState`
// + İş M's `menu` and `web`, plus the bridges of optional modules).
import { contextBridge, ipcRenderer } from "electron";
import { CONNECTION_IPC, SETTINGS_IPC, type SettingsIpcReply } from "../renderer/engine/options.ts";
import { LOCAL_BROWSER_IPC, type LocalBrowserBridge } from "../renderer/engine/local-browser-ipc.ts";
import type { EngineSettings, SettingsBridge } from "../renderer/engine/types.ts";
import { UI_STATE_IPC, type UiStateBridge } from "../renderer/engine/ui-state-ipc.ts";
import { MENU_IPC, parseMenuCommand, type MenuBridge } from "../renderer/engine/menu-ipc.ts";
import { parseSites, WEB_IPC, type WebBridge, type WebStatusEvent } from "../renderer/engine/web-ipc.ts";
import { LOCAL_ENGINE_IPC, type LocalEngineBridge, type LocalEngineInfo } from "../renderer/engine/local-engine-ipc.ts"; // Yerel bağlantı
import { WINDOW_IPC, type WindowBridge } from "../renderer/engine/window-ipc.ts"; // Performans
import { CLIPBOARD_IPC, type ClipboardBridge } from "../renderer/engine/clipboard-ipc.ts"; // Kopyalama
import { LINKS_IPC, parseLinkMenuChoice, type LinksBridge } from "../renderer/engine/links-ipc.ts"; // Bağlantılar
import { UPDATE_IPC, parseUpdateStatus, type UpdateBridge, type UpdateStatus } from "../renderer/engine/update-ipc.ts"; // Kendini güncelleme
import { I18N_IPC, LANGUAGE_ARG_PREFIX, type LanguageBridge } from "../renderer/engine/i18n-ipc.ts"; // i18n
import { DEFAULT_LOCALE, isLocale, setLocale } from "@kokpit/shared/i18n";
import { t } from "../i18n/index.ts";

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply = (await ipcRenderer.invoke(channel, ...args)) as SettingsIpcReply<T>;
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}


// İş M: menu commands from the native menu bar; Görünüm state back to it.
const menu: MenuBridge = {
  onCommand: (listener) => {
    const fn = (_e: unknown, raw: unknown) => {
      const c = parseMenuCommand(raw);
      if (c) listener(c);
    };
    ipcRenderer.on(MENU_IPC.command, fn);
    return () => ipcRenderer.removeListener(MENU_IPC.command, fn);
  },
  setViewState: (state) =>
    call<void>(MENU_IPC.viewState, {
      panels: state.panels.map((p) => ({ id: String(p.id), title: String(p.title), checked: p.checked === true, enabled: p.enabled === true })),
    }),
};

// İş M: web site tabs. Only a site id and a rectangle go to main, never a URL to load.
const web: WebBridge = {
  show: (req) =>
    call<void>(WEB_IPC.show, {
      siteId: String(req.siteId),
      bounds: { x: Number(req.bounds.x), y: Number(req.bounds.y), width: Number(req.bounds.width), height: Number(req.bounds.height) },
    }),
  hide: (siteId) => call<void>(WEB_IPC.hide, String(siteId)),
  close: (siteId) => call<void>(WEB_IPC.close, String(siteId)),
  reload: (siteId) => call<void>(WEB_IPC.reload, String(siteId)),
  onStatus: (listener) => {
    const fn = (_e: unknown, ev: WebStatusEvent) => listener({ siteId: String(ev.siteId), status: ev.status });
    ipcRenderer.on(WEB_IPC.status, fn);
    return () => ipcRenderer.removeListener(WEB_IPC.status, fn);
  },
  sites: {
    load: async () => parseSites(await call<unknown>(WEB_IPC.loadSites)),
    save: (sites) => call<void>(WEB_IPC.saveSites, sites.map((s) => ({ id: String(s.id), title: String(s.title), url: String(s.url) }))),
    onChange: (listener) => {
      const fn = (_e: unknown, raw: unknown) => listener(parseSites(raw));
      ipcRenderer.on(WEB_IPC.sites, fn);
      return () => ipcRenderer.removeListener(WEB_IPC.sites, fn);
    },
  },
};


// Performans: whether this window can be seen (streamed panels stop asking for frames while it cannot).
const windowBridge: WindowBridge = {
  onShownChanged: (listener) => {
    const fn = (_e: unknown, shown: unknown) => listener(shown === true);
    ipcRenderer.on(WINDOW_IPC.shown, fn);
    return () => ipcRenderer.removeListener(WINDOW_IPC.shown, fn);
  },
};

// Kopyalama: write-only. The page can never read the clipboard through this bridge.
const clipboard: ClipboardBridge = {
  writeText: (text) => call<void>(CLIPBOARD_IPC.writeText, String(text)),
  copyMenu: (text) => call<void>(CLIPBOARD_IPC.copyMenu, String(text)),
  pageMenu: (request) =>
    call<void>(CLIPBOARD_IPC.pageMenu, {
      canCopy: request?.canCopy === true,
      canCut: request?.canCut === true,
      canPaste: request?.canPaste === true,
      ...(typeof request?.linkUrl === "string" ? { linkUrl: request.linkUrl } : {}),
      ...(typeof request?.pageUrl === "string" ? { pageUrl: request.pageUrl } : {}),
    }),
};

// Bağlantılar: only strings and one boolean go to main, which checks every address itself.
const links: LinksBridge = {
  openExternal: (url) => call<void>(LINKS_IPC.openExternal, String(url)),
  menu: async (request) =>
    parseLinkMenuChoice(
      await call<unknown>(
        LINKS_IPC.menu,
        request !== null && typeof request === "object" && "path" in request
          ? { path: String(request.path), browser: request.browser === true, files: request.files === true } // Yollar
          : { url: String(request?.url), browser: request?.browser === true },
      ),
    ),
};

// Kendini güncelleme: the page sees the updater's state and passes on the user's choices; it never names a file or URL.
const update: UpdateBridge = {
  status: async () => {
    const s = parseUpdateStatus(await call<unknown>(UPDATE_IPC.status));
    if (!s) throw new Error(t("main.preload.updateStatusUnreadable"));
    return s;
  },
  onStatus: (listener) => {
    const fn = (_e: unknown, raw: unknown) => {
      const s: UpdateStatus | null = parseUpdateStatus(raw);
      if (s) listener(s);
    };
    ipcRenderer.on(UPDATE_IPC.changed, fn);
    return () => ipcRenderer.removeListener(UPDATE_IPC.changed, fn);
  },
  check: () => call<void>(UPDATE_IPC.check),
  download: () => call<void>(UPDATE_IPC.download),
  apply: () => call<void>(UPDATE_IPC.apply),
  setAuto: (on) => call<void>(UPDATE_IPC.setAuto, on === true),
  rendererReady: () => call<void>(UPDATE_IPC.rendererReady),
  moveToApplications: () => call<void>(UPDATE_IPC.moveToApplications),
  dismiss: () => call<void>(UPDATE_IPC.dismiss),
  confirmDowngrade: (buildId) => call<void>(UPDATE_IPC.confirmDowngrade, String(buildId)),
  resetFloor: () => call<void>(UPDATE_IPC.resetFloor),
};

// i18n: the window's starting language (main's additionalArguments) and main's later changes.
const languageArg = process.argv.find((a) => a.startsWith(LANGUAGE_ARG_PREFIX))?.slice(LANGUAGE_ARG_PREFIX.length);
const i18n: LanguageBridge = {
  initial: isLocale(languageArg) ? languageArg : DEFAULT_LOCALE,
  set: (locale) => call<void>(I18N_IPC.set, String(locale)),
  onChanged: (listener) => {
    const fn = (_e: unknown, raw: unknown) => {
      if (isLocale(raw)) listener(raw);
    };
    ipcRenderer.on(I18N_IPC.changed, fn);
    return () => ipcRenderer.removeListener(I18N_IPC.changed, fn);
  },
};

// The preload's own texts (its error fallbacks) follow the window's language too.
setLocale(i18n.initial);
ipcRenderer.on(I18N_IPC.changed, (_e: unknown, raw: unknown) => {
  if (isLocale(raw)) setLocale(raw);
});

const bridge: SettingsBridge & { update: UpdateBridge; i18n: LanguageBridge } & { browser: LocalBrowserBridge; uiState: UiStateBridge; localEngine: LocalEngineBridge; menu: MenuBridge; web: WebBridge; window: WindowBridge; clipboard: ClipboardBridge; links: LinksBridge } = {
  load: () => call<EngineSettings | null>(SETTINGS_IPC.load),
  save: (settings) => call<void>(SETTINGS_IPC.save, { url: settings?.url, key: settings?.key }),
  clear: () => call<void>(SETTINGS_IPC.clear),
  connection: {
    check: async (url) => {
      const v = await call<{ ok?: unknown; message?: unknown }>(CONNECTION_IPC.check, String(url));
      return v && v.ok === true ? { ok: true } : { ok: false, message: typeof v?.message === "string" ? v.message : t("main.preload.insecure") };
    },
    insecureAllowed: async (url) => (await call<boolean>(CONNECTION_IPC.insecureAllowed, String(url))) === true,
    setInsecure: (url, on) => call<void>(CONNECTION_IPC.setInsecure, String(url), on === true),
  },
  locked: async () => {
    const r = await call<{ url?: unknown } | null>(SETTINGS_IPC.locked);
    return r && typeof r.url === "string" ? { url: r.url } : null;
  },
  update,
  i18n,
  browser: {
    openLocal: (projectId, url) => (url === undefined ? call<void>(LOCAL_BROWSER_IPC.openLocal, String(projectId)) : call<void>(LOCAL_BROWSER_IPC.openLocal, String(projectId), String(url))),
  },
  uiState: {
    load: () => call<unknown>(UI_STATE_IPC.load),
    save: (state) => call<void>(UI_STATE_IPC.save, state),
  },
  menu,
  web,
  window: windowBridge,
  clipboard,
  links,
  // Yerel bağlantı: no key crosses this bridge.
  localEngine: {
    detect: () => call<LocalEngineInfo | null>(LOCAL_ENGINE_IPC.detect),
    connect: () => call<void>(LOCAL_ENGINE_IPC.connect),
  },
};

contextBridge.exposeInMainWorld("kokpit", bridge);
