// İş M — Web: the user's sites (Ana sayfa, Wiki, …) as tabs inside the app window. Electron main draws each
// site in a WebContentsView of its own (persistent per-site partition, no preload, no Node); this panel keeps the tab
// list, reports where the active site's surface is on screen and forwards the buttons. Kokpit never sees the page or
// its login, nothing of it goes through the engine, and agents have no access to it. The tabs are shared by every
// project (global panel state).
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { isSiteId, SITE_TRANSPORT_BADGES, siteTransport, tailnetBlockedText, type WebBridge, type WebSite, type WebStatus } from "../../engine/web-ipc.ts";
import type { PanelContext, PanelDefinition, PanelStateStore } from "../layout/contract.ts";
import { PanelTitle } from "../PanelTitle.tsx";
import { t as translate, useT, type MessageKey } from "../../../i18n/index.ts";
import { animationFrames, useSurfaceReporter, type FrameScheduler } from "./native-view.ts";
// Same look as the Uzak masaüstü surface and the Tarayıcı tab strip.
import "./surface.css";
import "../browser.css";
import "./web.css";

const STATUS_LABELS: Record<WebStatus, MessageKey> = {
  connecting: "web.status.connecting",
  ready: "web.status.ready",
  failed: "web.status.failed",
  closed: "web.status.closed",
  tailnet: "web.status.tailnet",
};

const TABS_KEY = "tabs";
const ACTIVE_KEY = "active";

function bridgeFromWindow(): WebBridge | undefined {
  return typeof window === "undefined" ? undefined : window.kokpit?.web;
}

export interface WebPanelProps {
  /** Global panel state: open tabs (site ids) and the active one. */
  state: PanelStateStore;
  /** A request (Git menu, first launch) to open and show a site; a new `seq` repeats it. */
  focus: PanelContext["focus"];
  /** Defaults to the preload's `window.kokpit.web`; absent outside Electron. */
  bridge?: WebBridge | undefined;
  schedule?: FrameScheduler;
}

export function WebPanel(props: WebPanelProps) {
  const t = useT();
  const bridge = "bridge" in props ? props.bridge : bridgeFromWindow();
  const titleId = useId();
  if (!bridge) {
    return (
      <section className="kp-panel kp-surface kp-web" aria-labelledby={titleId}>
        <PanelTitle id={titleId}>{t("web.title")}</PanelTitle>
        <p className="kp-surface__message">{t("web.onlyInApp")}</p>
      </section>
    );
  }
  return <WebSurface {...props} titleId={titleId} bridge={bridge} schedule={props.schedule ?? animationFrames} />;
}

interface Tabs {
  tabs: string[];
  active: string | null;
}

/** Saved state → unique valid site ids, active among them. */
function readTabs(state: PanelStateStore): Tabs {
  const raw = state.get<unknown>(TABS_KEY);
  const tabs: string[] = [];
  if (Array.isArray(raw)) for (const id of raw) if (isSiteId(id) && !tabs.includes(id)) tabs.push(id);
  const active = state.get<unknown>(ACTIVE_KEY);
  return { tabs, active: typeof active === "string" && tabs.includes(active) ? active : (tabs[0] ?? null) };
}

/** Drops tabs of unknown sites; keeps the active one when it survives. */
function onlyKnown(t: Tabs, sites: readonly WebSite[]): Tabs {
  const tabs = t.tabs.filter((id) => sites.some((s) => s.id === id));
  if (tabs.length === t.tabs.length) return t;
  return { tabs, active: t.active !== null && tabs.includes(t.active) ? t.active : (tabs[0] ?? null) };
}

function WebSurface({ state, focus, bridge, schedule, titleId }: WebPanelProps & { titleId: string; bridge: WebBridge; schedule: FrameScheduler }) {
  const t = useT();
  const surface = useRef<HTMLDivElement>(null);
  const [sites, setSites] = useState<WebSite[] | null>(null);
  const [tabs, setTabsState] = useState<Tabs>(() => readTabs(state));
  const [status, setStatus] = useState<Record<string, WebStatus>>({});
  const [error, setError] = useState<string | null>(null);

  const setTabs = useCallback(
    (fn: (t: Tabs) => Tabs) => {
      setTabsState((cur) => {
        const next = fn(cur);
        if (next === cur) return cur;
        state.set(TABS_KEY, next.tabs);
        state.set(ACTIVE_KEY, next.active);
        return next;
      });
    },
    [state],
  );

  useEffect(() => {
    let alive = true;
    bridge.sites.load().then(
      (list) => alive && setSites(list),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    );
    const off = bridge.sites.onChange((list) => setSites(list));
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  useEffect(() => {
    if (sites) setTabs((t) => onlyKnown(t, sites));
  }, [sites, setTabs]);

  useEffect(() => bridge.onStatus((e) => setStatus((s) => ({ ...s, [e.siteId]: e.status }))), [bridge]);

  const open = useCallback(
    (siteId: string) =>
      setTabs((t) => {
        if (t.active === siteId) return t;
        return { tabs: t.tabs.includes(siteId) ? t.tabs : [...t.tabs, siteId], active: siteId };
      }),
    [setTabs],
  );

  // Git menu / first launch: open the requested site (each seq once). Unknown ids are dropped once sites load.
  const lastSeq = useRef<number | null>(null);
  const requested = focus?.siteId;
  const seq = focus?.seq;
  useEffect(() => {
    if (seq === undefined || requested === undefined || lastSeq.current === seq) return;
    lastSeq.current = seq;
    if (isSiteId(requested) && (!sites || sites.some((s) => s.id === requested))) open(requested);
  }, [seq, requested, sites, open]);

  const close = (siteId: string): void => {
    setTabs((t) => {
      const i = t.tabs.indexOf(siteId);
      const rest = t.tabs.filter((id) => id !== siteId);
      const active = t.active === siteId ? (rest[i] ?? rest[i - 1] ?? null) : t.active;
      return { tabs: rest, active };
    });
    void bridge.close(siteId).catch(() => {});
  };

  const active = tabs.active;
  useSurfaceReporter(surface, {
    key: active ?? "",
    active: active !== null,
    schedule,
    show: (bounds) => bridge.show({ siteId: active!, bounds }),
    hide: () => bridge.hide(active!),
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const titleOf = useMemo(() => {
    const byId = new Map((sites ?? []).map((s) => [s.id, s.title]));
    return (id: string) => byId.get(id) ?? id;
  }, [sites]);
  /** The mark of a plain-http site ("http · Tailscale"); https sites have none. */
  const badgeOf = useMemo(() => {
    const byId = new Map((sites ?? []).map((s) => [s.id, siteTransport(s.url)]));
    return (id: string) => {
      const transport = byId.get(id) ?? "https";
      return transport === "https" ? undefined : SITE_TRANSPORT_BADGES[transport];
    };
  }, [sites]);
  const activeStatus = active !== null ? status[active] : undefined;

  return (
    <section className="kp-panel kp-surface kp-web" aria-labelledby={titleId}>
      <PanelTitle id={titleId}>{t("web.title")}</PanelTitle>
      {/* Without an open site there is nothing to put in a bar: the sites are offered in the panel itself. */}
      <div className="kp-panel__bar kp-web__bar" hidden={tabs.tabs.length === 0}>
        <div className="kp-browser__tabs kp-web__tabs" role="group" aria-label={t("web.siteTabs")}>
          {tabs.tabs.map((id) => (
            <span key={id} className="kp-browser__tab" {...(id === active ? { "data-active": "" } : {})}>
              <button type="button" className="kp-browser__tab-select" aria-pressed={id === active} onClick={() => open(id)}>
                {titleOf(id)}
              </button>
              {badgeOf(id) && (
                <span className="kp-web__badge" title={badgeOf(id)!.title}>
                  {badgeOf(id)!.label}
                </span>
              )}
              <button type="button" className="kp-browser__tab-close" aria-label={t("web.closeTab", { title: titleOf(id) })} onClick={() => close(id)}>
                ×
              </button>
            </span>
          ))}
        </div>
        {activeStatus && (
          <span role="status" className={`kp-surface__chip kp-surface__chip--${activeStatus}`}>
            {t(STATUS_LABELS[activeStatus])}
          </span>
        )}
        {active !== null && (
          <div className="kp-panel__actions">
            <button
              type="button"
              className="kp-btn kp-btn--quiet kp-btn--icon"
              aria-label={t("web.reload")}
              title={t("web.reload")}
              onClick={() => void bridge.reload(active).catch(() => {})}
            >
              ↻
            </button>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="kp-error kp-surface__error">
          {error}
        </p>
      )}
      <div ref={surface} className="kp-surface__surface" data-testid="web-surface">
        {activeStatus === "tailnet" && (
          <div className="kp-surface__message">
            <p role="alert">{tailnetBlockedText()}</p>
            <p>{t("web.tailnetHelp")}</p>
          </div>
        )}
        {active === null && (
          <div className="kp-surface__message">
            <p>{t("web.noSite")}</p>
            <div className="kp-web__sites">
              {(sites ?? []).map((s) => (
                <button key={s.id} type="button" className="kp-btn" onClick={() => open(s.id)}>
                  {s.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <p className="kp-surface__note">{t("web.note")}</p>
    </section>
  );
}

export const webPanel: PanelDefinition = {
  id: "web",
  get title() {
    return translate("web.title");
  },
  stateScope: "global",
  available: () => true,
  render: (ctx) => <WebPanel state={ctx.state} focus={ctx.focus ?? null} />,
};
