// Electron main process: one locked-down window plus the settings IPC.
import { app, BrowserWindow, clipboard, ipcMain, Menu, safeStorage, session, shell, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { trackEngineOrigin } from "./engine-origin.ts";
import { isAllowedSubframeUrl, isAllowedWindowRequest } from "./frame-guard.ts";
import { createLocalBrowser, LocalBrowserError } from "./local-browser.ts";
import { createLocalEngineService, detectLocalEngine, LocalEngineError } from "./local-engine.ts"; // Yerel bağlantı
import { applyUserDataDir } from "./runtime-env.ts";
import { createSettingsStore, SettingsError } from "./settings-store.ts";
import { createUiStateFile, UiStateError } from "./ui-state-file.ts";
import { CONNECTION_IPC, SETTINGS_IPC, type SettingsIpcReply } from "../renderer/engine/options.ts";
import { LOCAL_BROWSER_IPC } from "../renderer/engine/local-browser-ipc.ts";
import { UI_STATE_IPC } from "../renderer/engine/ui-state-ipc.ts";
// İş M: native menu bar + web site tabs.
import { createAppMenu } from "./app-menu.ts";
import { createWebHost } from "./web-host.ts";
import { createTailnetStatusReader, createTailnetVerifier } from "./tailnet.ts";
import { createConnectionGate } from "./connection-gate.ts";
import connectionDefaults from "./connection.defaults.json" with { type: "json" };
import { defaultSites, WebError, webEnv } from "./web-policy.ts";
import { createWebSitesFile } from "./web-sites-file.ts";
import { MENU_IPC, type MenuCommand } from "../renderer/engine/menu-ipc.ts";
import { WEB_IPC, webConfig } from "../renderer/engine/web-ipc.ts";
import { LOCAL_ENGINE_IPC } from "../renderer/engine/local-engine-ipc.ts"; // Yerel bağlantı
import { BUILD_FEATURES } from "@kokpit/shared"; // optional modules (kokpit.features.json)
import { WINDOW_IPC } from "../renderer/engine/window-ipc.ts";
// Kopyalama: OSC 52 writes of the terminals and the native Kopyala / Yapıştır context menus.
import { ClipboardError, contextMenuTemplate, createClipboardHost } from "./clipboard-host.ts";
import { CLIPBOARD_IPC, clipboardConfig } from "../renderer/engine/clipboard-ipc.ts";
// Bağlantılar: links of the terminals — the default browser, the right-click menu, a local project Chrome.
import { createExternalOpener, createLinksHost, EXTERNAL_OPEN_RECORD_GLOBAL, LinkError, linksEnv } from "./links-host.ts";
import { LINKS_IPC, linksConfig } from "../renderer/engine/links-ipc.ts";
// Kendini güncelleme: the app fetches the build its engine publishes, verifies it and swaps itself.
import { createUpdateHost } from "./update/host.ts";
import windowDefaults from "./window.defaults.json" with { type: "json" };
// i18n: the language setting (per machine) — menus and dialogs here, the window through the preload.
import { getLocale, setLocale, type Locale } from "@kokpit/shared/i18n";
import { COMPILED_LANGUAGE, createLanguageStore, defaultLanguage, LanguageError } from "./language.ts";
import { I18N_IPC, LANGUAGE_ARG_PREFIX } from "../renderer/engine/i18n-ipc.ts";
import { t } from "../i18n/index.ts";

/**
 * The app window. `backgroundColor` is what macOS shows wherever the page has not painted yet (the strip uncovered
 * while the window grows into full screen): the theme's --bg, never Electron's white (window-defaults.test.ts).
 */
const WINDOW = windowDefaults;

const SETTINGS_FILE_NAME = "engine-settings.json";
/** İş L: panel layout, per-panel state and the selected project/card. */
const UI_STATE_FILE_NAME = "ui-state.json";
/** İş M: the user's web sites (Ayarlar › Siteler), next to the UI state. */
const WEB_SITES_FILE_NAME = "web-sites.json";
/** i18n: the language the user picked (Ayarlar › Dil). */
const LANGUAGE_FILE_NAME = "language.json";
/** Set by electron-vite in development only. */
const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
const PRELOAD_PATH = join(import.meta.dirname, "../preload/index.cjs");
const RENDERER_FILE = join(import.meta.dirname, "../renderer/index.html");

applyUserDataDir(app, process.env);

const languageStore = createLanguageStore({
  filePath: join(app.getPath("userData"), LANGUAGE_FILE_NAME),
  fallback: defaultLanguage({ compiled: COMPILED_LANGUAGE, env: process.env, isPackaged: app.isPackaged }),
});
setLocale(languageStore.load());

// Dosyalar — medya: the store also tells the request guard which engine the app talks to.
const engine = trackEngineOrigin(
  createSettingsStore({
    filePath: join(app.getPath("userData"), SETTINGS_FILE_NAME),
    safeStorage,
  }),
);
const store = engine.store;

// Yerel bağlantı: one-click connect to an engine on this Mac; the key is read and saved here, never sent to the page.
const localEngine = createLocalEngineService({
  detect: () => detectLocalEngine({ env: process.env, log: (m) => console.info(m) }),
  save: (settings) => store.save(settings),
});

const uiState = createUiStateFile({ filePath: join(app.getPath("userData"), UI_STATE_FILE_NAME) });

// İş B: Chrome on this machine for projects whose browser runs on the client.
const localBrowser = createLocalBrowser({ userDataDir: app.getPath("userData"), env: process.env });

// Every "open in the default browser" goes through this one opener; a test run records instead of opening.
const external = createExternalOpener({ env: linksEnv(process.env, app.isPackaged), openExternal: (url) => shell.openExternal(url) });
if (external.recorded) (globalThis as Record<string, unknown>)[EXTERNAL_OPEN_RECORD_GLOBAL] = external.recorded;
const openExternal = (url: string): void => {
  // The reason is not logged: an operating-system error may quote the address, and addresses stay out of the log.
  external.open(url).catch(() => console.error("[kokpit] opening the default browser failed"));
};

let mainWindow: BrowserWindow | null = null;

// İş M: web sites in WebContentsViews over the Web panel; the Git menu lists them.
const webTestEnv = webEnv(process.env, app.isPackaged);
const sendToRenderer = (channel: string, payload: unknown): void => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
const web = createWebHost({
  config: webConfig,
  env: webTestEnv,
  window: () => mainWindow,
  openExternal,
  file: createWebSitesFile({
    filePath: join(app.getPath("userData"), WEB_SITES_FILE_NAME),
    defaults: defaultSites(webConfig, webTestEnv),
    seededBeforeMarker: webConfig.defaultsSeededBeforeMarker,
  }),
  // Plain http to a Tailscale address loads only while Tailscale's own status says the address is in the tailnet.
  tailnet: createTailnetVerifier({ config: webConfig.httpTailnet, read: createTailnetStatusReader(webConfig.httpTailnet) }),
  emitStatus: (e) => sendToRenderer(WEB_IPC.status, e),
  clearSiteData: (partition) => session.fromPartition(partition).clearStorageData(),
  sitesChanged: (sites) => {
    sendToRenderer(WEB_IPC.sites, sites);
    appMenu.refresh();
  },
});
const appMenu = createAppMenu({
  appName: WINDOW.title,
  isMac: process.platform === "darwin",
  devTools: !app.isPackaged,
  sites: () => web.sites(),
  send: (c: MenuCommand) => sendToRenderer(MENU_IPC.command, c),
});

// Before the window's key handshake: only this Mac, Tailscale (asked afresh each time) or wss:// — or an address the
// user explicitly opted in for (Ayarlar › Bağlantı).
const connectionGate = createConnectionGate({
  tailnet: createTailnetVerifier({ config: webConfig.httpTailnet, read: createTailnetStatusReader(webConfig.httpTailnet) }),
  config: webConfig.httpTailnet,
  filePath: join(app.getPath("userData"), connectionDefaults.insecureFileName),
  maxAddresses: connectionDefaults.maxInsecureAddresses,
});

const updateHost = createUpdateHost({
  app,
  // An update comes over Tailscale only while Tailscale's own status says the engine's address is in the tailnet.
  tailnet: {
    verifier: createTailnetVerifier({ config: webConfig.httpTailnet, read: createTailnetStatusReader(webConfig.httpTailnet) }),
    config: webConfig.httpTailnet,
  },
  settings: () => store.load(),
  send: sendToRenderer,
  focused: () => BrowserWindow.getFocusedWindow() !== null,
});


const clipboardHost = createClipboardHost({
  config: clipboardConfig,
  write: (text) => clipboard.writeText(text),
  hasText: () => clipboard.readText() !== "",
  popup: (template) => {
    if (mainWindow && !mainWindow.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: mainWindow });
  },
});

const linksHost = createLinksHost({
  config: linksConfig,
  openExternal: (url) => external.open(url),
  write: (text) => clipboard.writeText(text),
  popup: (template, onClose) => {
    if (mainWindow && !mainWindow.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: mainWindow, callback: onClose });
    else onClose();
  },
});

/** Only the app's own page may talk to main or be navigated to. */
function isAppUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (DEV_RENDERER_URL) return url.origin === new URL(DEV_RENDERER_URL).origin;
    return url.protocol === "file:" && decodeURIComponent(url.pathname) === RENDERER_FILE;
  } catch {
    return false;
  }
}

function safeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "?";
  }
}

function handle<T>(channel: string, fn: (...args: unknown[]) => Promise<T>): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SettingsIpcReply<T>> => {
    if (!isAppUrl(event.senderFrame?.url)) return { ok: false, error: t("main.ipc.unauthorized") };
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      if (err instanceof SettingsError || err instanceof LocalBrowserError || err instanceof UiStateError || err instanceof LocalEngineError || err instanceof WebError || err instanceof ClipboardError || err instanceof LinkError || err instanceof LanguageError) {
        return { ok: false, error: err.message };
      }
      console.error(`[kokpit] ${channel} failed`, err);
      return { ok: false, error: t("main.ipc.failed") };
    }
  });
}

function registerIpc(): void {
  handle(SETTINGS_IPC.load, () => store.load());
  handle(SETTINGS_IPC.save, (input) => store.save(input));
  handle(SETTINGS_IPC.clear, () => store.clear());
  handle(SETTINGS_IPC.locked, () => store.locked());
  // The transport gate in front of the window's key handshake (connection-gate.ts).
  handle(CONNECTION_IPC.check, (url) => connectionGate.check(typeof url === "string" ? url : ""));
  handle(CONNECTION_IPC.insecureAllowed, (url) => connectionGate.insecureAllowed(typeof url === "string" ? url : ""));
  handle(CONNECTION_IPC.setInsecure, (url, on) => connectionGate.setInsecure(typeof url === "string" ? url : "", on === true));
  updateHost.register(handle); // Kendini güncelleme
  // Bağlantılar: with an address (a link from the project's terminal) it is checked and rate-limited first.
  handle(LOCAL_BROWSER_IPC.openLocal, (projectId, url) => localBrowser.open(projectId, url === undefined || url === null ? undefined : linksHost.checkWeb(url)));
  handle(UI_STATE_IPC.load, () => uiState.load());
  handle(UI_STATE_IPC.save, (state) => uiState.save(state));
  // İş M
  handle(MENU_IPC.viewState, async (state) => appMenu.setView(state));
  handle(WEB_IPC.show, async (req) => web.show(req));
  handle(WEB_IPC.hide, async (siteId) => web.hide(siteId));
  handle(WEB_IPC.close, async (siteId) => web.close(siteId));
  handle(WEB_IPC.reload, async (siteId) => web.reload(siteId));
  handle(WEB_IPC.loadSites, async () => web.sites());
  handle(WEB_IPC.saveSites, (sites) => web.saveSites(sites));
  handle(LOCAL_ENGINE_IPC.detect, () => localEngine.info()); // Yerel bağlantı
  handle(LOCAL_ENGINE_IPC.connect, () => localEngine.connect()); // Yerel bağlantı
  // Kopyalama
  handle(CLIPBOARD_IPC.writeText, async (text) => clipboardHost.writeText(text));
  handle(CLIPBOARD_IPC.copyMenu, async (text) => clipboardHost.copyMenu(text));
  handle(CLIPBOARD_IPC.pageMenu, async (request) => clipboardHost.pageMenu(request));
  // Bağlantılar
  handle(LINKS_IPC.openExternal, (url) => linksHost.openExternal(url));
  handle(LINKS_IPC.menu, (request) => linksHost.menu(request));
  // i18n: store first, then switch main's text (menus) and tell the window.
  handle(I18N_IPC.set, async (language) => {
    await languageStore.save(language);
    setLocale(language as Locale);
    appMenu.refresh();
    sendToRenderer(I18N_IPC.changed, getLocale());
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    title: WINDOW.title,
    width: WINDOW.width,
    height: WINDOW.height,
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    backgroundColor: WINDOW.backgroundColor,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      // i18n: the first paint is already in the current language (the preload reads it).
      additionalArguments: [`${LANGUAGE_ARG_PREFIX}${getLocale()}`],
    },
  });

  mainWindow = win;
  win.on("closed", () => {
    web.destroyAll();
    if (mainWindow === win) mainWindow = null;
  });
  win.once("ready-to-show", () => win.show());
  // Performans: streamed panels (e.g. Tarayıcı) ask for frames only while the window can be seen.
  const sendShown = (): void => {
    if (!win.isDestroyed()) win.webContents.send(WINDOW_IPC.shown, win.isVisible() && !win.isMinimized());
  };
  win.on("show", sendShown);
  win.on("hide", sendShown);
  win.on("minimize", sendShown);
  win.on("restore", sendShown);
  // Keep "Kokpit" rather than the document title.
  win.on("page-title-updated", (e) => e.preventDefault());

  // The app's own page opens no windows. An http(s) address asked for this way goes to the default browser, under
  // the links' rules (http/https only, normalized, rate-limited); everything else is dropped.
  win.webContents.setWindowOpenHandler(({ url }) => {
    linksHost.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  win.webContents.on("will-redirect", (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
  // Kopyalama: right click on selected text, an input or the terminal → native Kes / Kopyala / Yapıştır.
  win.webContents.on("context-menu", (_e, params) => {
    const template = contextMenuTemplate(params, clipboardConfig);
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win });
  });
  // İş C — Harita, Dosyalar — medya: sub-frames may only show the engine's one-time map page or (for a PDF) a media
  // URL of the connected engine (main frame: will-navigate above).
  win.webContents.on("will-frame-navigate", (e) => {
    if (!e.isMainFrame && !isAllowedSubframeUrl(e.url, engine.origin())) e.preventDefault();
  });

  if (DEV_RENDERER_URL) void win.loadURL(DEV_RENDERER_URL);
  else void win.loadFile(RENDERER_FILE);
}

/** The requests the window guard looks at. */
const GUARDED_URLS = ["http://*/*", "https://*/*"];

/**
 * Dosyalar — medya: what the app window loads over http(s) — media elements and the PDF frame from the connected
 * engine's media URLs, the map frame, nothing else (frame-guard.ts). Embedded web views have their own
 * sessions and are not touched.
 */
function guardWindowRequests(): void {
  const devOrigin = DEV_RENDERER_URL ? new URL(DEV_RENDERER_URL).origin : undefined;
  // Only http(s) is judged, so only http(s) is intercepted: the engine's WebSocket and the page's own files never
  // pass through here.
  session.defaultSession.webRequest.onBeforeRequest({ urls: GUARDED_URLS }, (details, callback) => {
    let allowed = false;
    try {
      const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
      if (!wc || details.webContentsId !== wc.id) return callback({});
      const top = wc.mainFrame;
      // A sub-frame navigation is the app page's doing when the frame sits directly in the top document.
      const fromAppPage = details.resourceType === "subFrame" ? details.frame?.parent === top : details.frame == null || details.frame === top;
      allowed = isAllowedWindowRequest({ url: details.url, resourceType: details.resourceType, fromAppPage }, { engineOrigin: engine.origin(), devOrigin });
    } catch (err) {
      console.error("[kokpit] request guard failed", err);
    }
    // Never the URL itself: a media URL carries its token.
    if (!allowed) console.warn(`[kokpit] request blocked: ${details.resourceType} ${safeOrigin(details.url)}`);
    callback(allowed ? {} : { cancel: true });
  });
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  guardWindowRequests();
  // Kendini güncelleme: a verified update that was waiting for a restart goes in now — no window, the app quits
  // and the swap helper starts the new build.
  if (await updateHost.beforeWindow()) return;
  await web.init();
  appMenu.refresh();
  registerIpc();
  createWindow();
  updateHost.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
