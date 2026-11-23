// İş B: the Tarayıcı panel. Engine mode shows the project's Chrome (running on the engine machine) as a CDP
// screencast on a canvas and forwards mouse, wheel and keyboard to it (page-view.tsx, shared with the Masaüstü
// windows). Client mode opens a local Chrome window.
import { browserWindowOf, type BrowserState, type Method, type Project } from "@kokpit/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { EngineClient } from "../engine/types.ts";
import { BrowserExtensions } from "./BrowserExtensions.tsx";
import { BrowserLogins } from "./BrowserLogins.tsx"; // Girişler
import { t as translate, useT } from "../../i18n/index.ts";
import { isMacPlatform, resolveAddress } from "./browser-input.ts";
import type { UiConfig } from "./config.ts";
import { errorMessage, isDisconnected } from "./errors.ts";
import type { PanelStateStore } from "./layout/contract.ts";
import { PanelTitle } from "./PanelTitle.tsx";
import { defaultClipboard, drawJpegFrame, usePageView, type FrameDrawer, type PageChannel, type PageClipboard } from "./page-view.tsx";
import { useViewPrefs } from "./view-prefs-context.tsx";
import { BROWSER_ZOOM_KEY, GLOBAL_SCOPE, legacyZoom, searchUrlOf } from "./view-prefs.ts";
import "./browser.css";

export { drawJpegFrame, type FrameDrawer } from "./page-view.tsx";

export interface BrowserPanelProps {
  client: EngineClient;
  project: Project;
  config: UiConfig;
  /** Client mode: opens Chrome on this machine (Electron main via preload). Absent = not available. */
  openLocal?: (projectId: string) => Promise<void>;
  /** Tests inject a fake; defaults to createImageBitmap on the canvas. */
  drawFrame?: FrameDrawer;
  /** Adım 7: where the active tab is remembered (layout panel state); absent = not remembered. */
  tabState?: PanelStateStore;
  /**
   * Kopyalama: writes this machine's clipboard and shows the page's right-click menu (Electron main). Defaults to
   * the preload's `window.kokpit.clipboard`; null = none (outside Electron).
   */
  clipboard?: PageClipboard | null;
  /** Cmd (macOS) or Ctrl is the shortcut modifier; defaults to the platform's. */
  isMac?: boolean;
}

/** Key of the remembered active tab in the panel state. */
export const ACTIVE_TAB_KEY = "activeTab";
export interface StoredTab {
  tabId: string;
  url: string;
}

/** A stored value written by an older or broken build is ignored rather than trusted. */
function storedTab(v: unknown): StoredTab | null {
  if (typeof v !== "object" || v === null) return null;
  const { tabId, url } = v as Record<string, unknown>;
  return typeof tabId === "string" && typeof url === "string" ? { tabId, url } : null;
}

const tabLabel = (t: { title: string; url: string }): string => t.title || t.url || translate("browser.panel.newTab");

export function BrowserPanel(props: BrowserPanelProps) {
  const t = useT();
  const headingId = useId();
  const clientMode = props.project.browser?.runOn === "client";
  return (
    <section className="kp-panel kp-browser" aria-labelledby={headingId}>
      <PanelTitle id={headingId}>{t("browser.panel.title")}</PanelTitle>
      {clientMode ? <LocalBrowser {...props} /> : <EngineBrowser {...props} />}
    </section>
  );
}

function LocalBrowser({ project, openLocal }: BrowserPanelProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    if (!openLocal) return;
    setBusy(true);
    setError(null);
    try {
      await openLocal(project.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kp-browser__body kp-browser__body--idle">
      <p className="kp-browser__note">{t("browser.panel.localNote")}</p>
      {!openLocal && <p className="kp-browser__note">{t("browser.panel.localUnavailable")}</p>}
      <div className="kp-browser__actions">
        <button type="button" className="kp-btn kp-btn--primary" disabled={!openLocal || busy} onClick={() => void open()}>
          {t("browser.panel.open")}
        </button>
      </div>
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The project's active tab as a streamed page (`browser.*` requests, frames keyed by the project). */
export function browserChannel(client: EngineClient, projectId: string): PageChannel {
  return {
    key: `browser:${projectId}`,
    onFrame: (cb) => client.onBrowserFrame(projectId, cb),
    ack: (frameId) => client.sendBrowserAck(projectId, frameId),
    input: (event) => client.sendBrowserInput(projectId, event),
    startCast: (size) => client.request("browser.screencast.start", { projectId, ...size }),
    stopCast: () => client.request("browser.screencast.stop", { projectId }),
    setViewport: (size, interaction) => client.request("browser.viewport.set", { projectId, ...size, ...(interaction ? { interaction: true } : {}) }),
    setZoom: (zoom) => client.request("browser.zoom.set", { projectId, zoom, mode: "user" }),
    copy: (cut) => client.request("browser.copy", { projectId, ...(cut ? { cut: true } : {}) }),
    paste: (text) => client.request("browser.paste", { projectId, text }),
    context: (at) => client.request("browser.context", { projectId, ...at }),
    onChanged: (cb) =>
      client.onEvent((ev) => {
        if (ev.name === "browser.changed" && ev.projectId === projectId) cb();
      }),
  };
}

function EngineBrowser({ client, project, config, drawFrame = drawJpegFrame, tabState, clipboard, isMac }: BrowserPanelProps) {
  const t = useT();
  const projectId = project.id;
  const [state, setBrowserState] = useState<BrowserState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showExt, setShowExt] = useState(false);
  const [address, setAddress] = useState("");
  const editing = useRef(false);
  /** The remembered tab is reselected once, on the first running state this panel sees. */
  const restored = useRef(false);
  const stripRef = useRef<HTMLDivElement>(null);

  const running = state?.running === true;
  const activeTab = state?.tabs.find((t) => t.id === state.activeTabId);
  const activeUrl = activeTab?.url ?? "";

  // ---- İş Z: search engine (global); the zoom is the project's, owned by the engine (page-view.tsx) ----
  const { panelState } = useViewPrefs();
  const projectPrefs = useMemo(() => panelState("browser", `project:${projectId}`), [panelState, projectId]);
  const globalPrefs = useMemo(() => panelState("browser", GLOBAL_SCOPE), [panelState]);

  const configRef = useRef(config);
  configRef.current = config;
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const channel = useMemo(() => browserChannel(client, projectId), [client, projectId]);
  const page = usePageView({
    client,
    channel,
    config,
    running,
    drawFrame,
    clipboard: clipboard === undefined ? defaultClipboard() : clipboard,
    isMac: isMac ?? isMacPlatform(),
    pageUrl: activeUrl,
    onError: setError,
    reload: () => reloadRef.current(),
    menuZoom: true,
  });
  const { engineZoom, engineOwner } = page;
  /** Every browser state the engine sends carries the project's zoom and who drives the viewport. */
  const setState = useCallback(
    (browser: BrowserState) => {
      setBrowserState(browser);
      engineZoom(browser.zoom);
      engineOwner(browser.viewportOwner === true);
    },
    [engineZoom, engineOwner],
  );
  // Hand-over, once: a zoom this app kept in its own UI state (before the engine owned it) becomes the project's
  // if nobody chose one there yet; either way the app's copy is removed. Kept only while the engine is unreachable.
  useEffect(() => {
    const stored = projectPrefs.get(BROWSER_ZOOM_KEY);
    if (stored === undefined) return;
    const mine = legacyZoom(stored, configRef.current);
    if (mine === null) {
      projectPrefs.set(BROWSER_ZOOM_KEY, undefined);
      return;
    }
    let active = true;
    const handOver = () => {
      if (projectPrefs.get(BROWSER_ZOOM_KEY) === undefined) return;
      client.request("browser.zoom.set", { projectId, zoom: mine, mode: "adopt" }).then(
        (r) => {
          projectPrefs.set(BROWSER_ZOOM_KEY, undefined);
          if (active) engineZoom(r.zoom);
        },
        () => {
          /* tried again on reconnect and when the panel starts next */
        },
      );
    };
    handOver();
    const off = client.onReconnected(handOver);
    return () => {
      active = false;
      off();
    };
  }, [client, projectId, projectPrefs, engineZoom]);

  const reload = useCallback(async () => {
    try {
      const { browser } = await client.request("browser.tabs", { projectId });
      setState(browser);
    } catch (err) {
      if (!isDisconnected(err)) setError(errorMessage(err));
    }
  }, [client, projectId, setState]);
  reloadRef.current = reload;

  useEffect(() => {
    void reload();
    const offEvent = client.onEvent((ev) => {
      if (ev.name === "browser.changed" && ev.projectId === projectId) void reload();
    });
    const offReconnect = client.onReconnected(() => void reload());
    return () => {
      offEvent();
      offReconnect();
    };
  }, [client, projectId, reload]);

  useEffect(() => {
    if (!editing.current) setAddress(activeUrl);
  }, [activeUrl]);

  // Keep the active tab visible in a long (scrolling) strip.
  const activeTabId = state?.activeTabId;
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  // ---------- actions ----------

  /** Runs one engine request; its error is shown. Answers whether it succeeded. */
  const act = async (fn: () => Promise<{ browser: BrowserState } | Record<string, never>>): Promise<boolean> => {
    setError(null);
    try {
      const r = await fn();
      if ("browser" in r) setState(r.browser as BrowserState);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  };

  const simple = (method: Extract<Method, "browser.back" | "browser.forward" | "browser.reload">) =>
    void act(() => client.request(method, { projectId }));

  /**
   * The tab clicked last, until the engine has answered that click: the strip marks it at once (a switch can take a
   * moment — the page is brought to the front and sized first). The engine's answer, or its tabs again after a
   * refusal, then decide.
   */
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const pendingTabRef = useRef<string | null>(null);
  const selectTab = (tabId: string) => {
    pendingTabRef.current = tabId;
    setPendingTab(tabId);
    const settle = () => {
      if (pendingTabRef.current !== tabId) return;
      pendingTabRef.current = null;
      setPendingTab(null);
    };
    void act(() => client.request("browser.selectTab", { projectId, tabId }))
      .then((ok) => {
        // Refused (the error is shown): the strip shows the engine's tabs and the one really in front.
        if (!ok && pendingTabRef.current === tabId) void reloadRef.current();
      })
      .finally(settle);
  };
  const closeTab = (tabId: string) => void act(() => client.request("browser.closeTab", { projectId, tabId }));
  const newTab = () => void act(() => client.request("browser.newTab", { projectId }));

  // Active tab ↔ panel state: reselect the remembered tab once (by id, else by URL), then follow the real one.
  useEffect(() => {
    if (!tabState || !state?.running) return;
    if (!restored.current) {
      restored.current = true;
      const want = storedTab(tabState.get(ACTIVE_TAB_KEY));
      const target = want && (state.tabs.find((t) => t.id === want.tabId) ?? (want.url ? state.tabs.find((t) => t.url === want.url) : undefined));
      if (target && target.id !== state.activeTabId) {
        selectTab(target.id);
        return;
      }
    }
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    if (active) tabState.set(ACTIVE_TAB_KEY, { tabId: active.id, url: active.url } satisfies StoredTab);
  }, [state, tabState]);

  const open = async () => {
    setBusy(true);
    await act(() => client.request("browser.open", { projectId }));
    setBusy(false);
  };

  const close = async () => {
    setBusy(true);
    await act(async () => {
      await client.request("browser.close", { projectId });
      return { browser: { running: false, tabs: [] } };
    });
    setBusy(false);
  };

  const submitAddress = (e: FormEvent) => {
    e.preventDefault();
    const r = resolveAddress(address, searchUrlOf(globalPrefs, config));
    if (!r.ok) {
      setError(r.error);
      return;
    }
    editing.current = false;
    setAddress(r.url);
    void act(() => client.request("browser.navigate", { projectId, url: r.url }));
  };

  // ---------- render ----------

  const extToggle = (
    <button type="button" className="kp-btn" aria-expanded={showExt} onClick={() => setShowExt((v) => !v)}>
      {t("browser.panel.extensions")}
    </button>
  );
  const extMenu = showExt && (
    <BrowserExtensions
      client={client}
      projectId={projectId}
      running={running}
      window={browserWindowOf(project)}
      machineName={config.machineName}
    />
  );

  if (!running) {
    return (
      <div className="kp-browser__body kp-browser__body--idle">
        <p className="kp-browser__note">{t("browser.panel.closedNote")}</p>
        <div className="kp-browser__actions">
          <button type="button" className="kp-btn kp-btn--primary" disabled={busy} onClick={() => void open()}>
            {busy ? t("browser.panel.opening") : t("browser.panel.open")}
          </button>
          {extToggle}
        </div>
        {extMenu}
        {error && (
          <p role="alert" className="kp-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="kp-browser__body" onKeyDownCapture={page.onZoomKey} onKeyUpCapture={page.onZoomKey}>
      <div className="kp-browser__tabs" role="group" aria-label={t("browser.panel.tabs")} ref={stripRef}>
        {state.tabs.map((tab) => {
          const label = tabLabel(tab);
          const active = tab.id === (pendingTab !== null && state.tabs.some((x) => x.id === pendingTab) ? pendingTab : state.activeTabId);
          return (
            <div key={tab.id} className="kp-browser__tab" data-tab-id={tab.id} data-active={active || undefined}>
              <button type="button" className="kp-browser__tab-select" aria-pressed={active} title={tab.url} onClick={() => selectTab(tab.id)}>
                {label}
              </button>
              <button
                type="button"
                className="kp-browser__tab-close"
                aria-label={t("browser.panel.closeTabFor", { label })}
                title={t("browser.panel.closeTab")}
                onClick={() => closeTab(tab.id)}
              >
                ×
              </button>
            </div>
          );
        })}
        <button type="button" className="kp-btn kp-btn--quiet kp-browser__tab-new" aria-label={t("browser.panel.newTab")} title={t("browser.panel.newTab")} onClick={newTab}>
          +
        </button>
      </div>
      <div className="kp-browser__toolbar">
        <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("browser.panel.back")} onClick={() => simple("browser.back")}>
          ←
        </button>
        <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("browser.panel.forward")} onClick={() => simple("browser.forward")}>
          →
        </button>
        <button type="button" className="kp-btn kp-btn--quiet" aria-label={t("browser.panel.reload")} onClick={() => simple("browser.reload")}>
          ↻
        </button>
        <form className="kp-browser__address" onSubmit={submitAddress}>
          <input
            className="kp-input kp-input--mono kp-browser__url"
            aria-label={t("browser.panel.address")}
            value={address}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              editing.current = true;
              setAddress(e.target.value);
            }}
            onBlur={(e) => {
              // The window being deactivated (another app in front) also blurs the field, but it stays the active
              // element: the user is still typing here, and a refresh must not swap the text for the page's address.
              if (e.currentTarget.ownerDocument.activeElement === e.currentTarget) return;
              editing.current = false;
            }}
          />
        </form>
        {/* No permanent zoom control: Görünüm menu, Cmd + − / = / 0, a pinch; the bubble shows for a while after. */}
        {/* Girişler: saved logins of this project for the open site (BrowserLogins.tsx). */}
        <BrowserLogins client={client} projectId={projectId} pageUrl={activeUrl} />
        {extToggle}
        <button type="button" className="kp-btn" disabled={busy} onClick={() => void close()}>
          {t("browser.panel.close")}
        </button>
      </div>
      {extMenu}
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
      {page.element}
    </div>
  );
}
