import type { AgentState, TerminalActivity, TerminalInfo } from "@kokpit/shared";
import { useEffect, useRef, useState } from "react";
import type { EngineClient } from "../engine/types.ts";
import { t as translate, useT } from "../../i18n/index.ts";
import { agentStateLabel } from "./agents.ts";
import { measurableDims, toProtocolDims, type UiConfig } from "./config.ts";
import { errorMessage, isDisconnected } from "./errors.ts";
import { whenConnected } from "./hooks/when-connected.ts";
import { useLinkOpener } from "./link-opener.ts";
import type { TerminalDims, TerminalView, TerminalViewFactory } from "./terminal-view.ts";
import { useViewPrefs } from "./view-prefs-context.tsx";

export interface TerminalPanelProps {
  client: EngineClient;
  terminal: TerminalInfo;
  createView: TerminalViewFactory;
  config: UiConfig;
  /** Called after the engine closed the terminal on the user's request. */
  onClosed?: (terminalId: string) => void;
  /** İş A: a new value scrolls this panel into view and focuses the terminal. */
  focusSeq?: number | undefined;
  /** İş T: no header (title, status, close) — the Terminaller panel's tab shows those. */
  bare?: boolean;
}

type Status = { running: true } | { running: false; exitCode: number | null };

/** While the process runs, the header speaks the Ajanlar panel's words (çalışıyor / seni bekliyor / boşta). */
function headerState(status: Status, activity: TerminalActivity | undefined): AgentState {
  if (!status.running) return "exited";
  return activity && activity.state !== "exited" ? activity.state : "running";
}

function headerText(status: Status, activity: TerminalActivity | undefined): string {
  return status.running ? agentStateLabel(headerState(status, activity)) : statusText(status);
}

function statusFrom(t: TerminalInfo): Status {
  return t.status === "running" ? { running: true } : { running: false, exitCode: t.exitCode ?? null };
}

function statusText(s: Status): string {
  if (s.running) return agentStateLabel("running");
  return s.exitCode === null ? agentStateLabel("exited") : translate("terminal.panel.exitedWithCode", { code: s.exitCode });
}

export function TerminalPanel({ client, terminal, createView, config, onClosed, focusSeq, bare = false }: TerminalPanelProps) {
  const t = useT();
  const terminalId = terminal.id;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<Status>(() => statusFrom(terminal));
  const [activity, setActivity] = useState<TerminalActivity | undefined>(terminal.activity);

  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.name === "terminal.activity" && event.terminalId === terminalId) setActivity(event.activity);
      }),
    [client, terminalId],
  );
  const [error, setError] = useState<string | null>(null);
  /** The engine sent history this panel could not use (see EngineClient.onOutputLost): say so, offer to reload. */
  const [historyLost, setHistoryLost] = useState(false);
  const reloadRef = useRef<() => void>(() => {});
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);

  // Latest config without re-running the lifecycle effect.
  const configRef = useRef(config);
  configRef.current = config;
  /** İş Z: the global terminal font size (applied before the first fit, then live). */
  const { font } = useViewPrefs();
  const fontRef = useRef(font);
  fontRef.current = font;
  // Bağlantılar: links of this terminal open in ITS project's browser (a card's terminal: the card's project).
  const linkOpener = useLinkOpener();
  const linkOpenerRef = useRef(linkOpener);
  linkOpenerRef.current = linkOpener;
  const projectId = terminal.projectId;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    // Yollar: file paths in the output are resolved for THIS terminal (its folder, its current directory).
    const view = createView({ links: linkOpenerRef.current?.forProject(projectId, { id: terminalId }) });
    viewRef.current = view;
    view.setFontSize?.(fontRef.current.get());
    view.open(host);
    let last: TerminalDims = toProtocolDims(view.fit(), configRef.current);

    const offOutput = client.onOutput(terminalId, (data, replay, continued) => {
      if (disposed) return;
      // A replay starts over: the screen is cleared once, at its first part; a new history also ends an old loss.
      if (replay && !continued) {
        view.reset();
        setHistoryLost(false);
      }
      view.write(data, replay);
    });
    const offLost = client.onOutputLost(terminalId, () => {
      if (!disposed) setHistoryLost(true);
    });
    const offExit = client.onExit(terminalId, (exitCode) => {
      if (!disposed) setStatus({ running: false, exitCode });
    });
    const offData = view.onData((data) => {
      if (!disposed) client.sendInput(terminalId, data);
    });

    const attach = async (): Promise<void> => {
      try {
        const { terminal: info } = await client.request("terminal.attach", { terminalId, ...last });
        if (disposed) return;
        setError(null);
        setStatus(statusFrom(info));
      } catch (err) {
        // Connection loss is shown by the banner; the next connection re-attaches.
        if (!disposed && !isDisconnected(err)) setError(translate("terminal.panel.attachFailed", { error: errorMessage(err) }));
      }
    };
    const offConnected = whenConnected(client, attach);
    // Attaching again makes the engine send the history anew (and drops nothing: replay, then live).
    reloadRef.current = () => {
      if (disposed) return;
      setHistoryLost(false);
      void attach();
    };

    /** Fits the view and tells the engine when the size really changed. */
    const refit = (): void => {
      if (disposed) return;
      const next = measurableDims(view.fit(), configRef.current);
      if (!next || (next.cols === last.cols && next.rows === last.rows)) return;
      last = next;
      client.sendResize(terminalId, next.cols, next.rows);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        refit();
      }, configRef.current.resizeDebounceMs);
    };
    // İş Z: a new font size is one deliberate step — refit and resize right away, no debounce. (The store is
    // created once the UI state has loaded, before any panel mounts, so it never changes under a mounted view.)
    const offFont = fontRef.current.subscribe((px) => {
      view.setFontSize?.(px);
      refit();
    });

    const RO = typeof ResizeObserver === "function" ? ResizeObserver : undefined;
    const observer = RO ? new RO(onResize) : undefined;
    observer?.observe(host);

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
      offFont();
      offConnected();
      offOutput();
      offLost();
      offExit();
      offData();
      client.request("terminal.detach", { terminalId }).catch(() => {});
      viewRef.current = null;
      view.dispose();
    };
  }, [client, terminalId, createView, projectId]);

  useEffect(() => {
    if (focusSeq === undefined) return;
    sectionRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    viewRef.current?.focus();
  }, [focusSeq]);

  const close = async (): Promise<void> => {
    setClosing(true);
    try {
      await client.request("terminal.close", { terminalId });
      onClosed?.(terminalId);
    } catch (err) {
      setError(t("terminal.panel.closeFailed", { error: errorMessage(err) }));
      setClosing(false);
      setConfirmClose(false);
    }
  };

  const header = bare ? null : (
    <header className="kp-panel__head">
      <span className="kp-panel__title">{terminal.title}</span>
      <span className={`kp-status kp-status--${headerState(status, activity)}`}>{headerText(status, activity)}</span>
      <span className="kp-panel__actions">
        {confirmClose ? (
          <>
            <button type="button" className="kp-btn kp-btn--danger" disabled={closing} onClick={() => void close()}>
              {t("terminal.panel.confirmClose")}
            </button>
            <button type="button" className="kp-btn" disabled={closing} onClick={() => setConfirmClose(false)}>
              {t("terminal.panel.cancel")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="kp-btn kp-btn--icon"
            aria-label={t("terminal.panel.close")}
            title={t("terminal.panel.close")}
            onClick={() => setConfirmClose(true)}
          >
            ×
          </button>
        )}
      </span>
    </header>
  );

  return (
    <section
      ref={sectionRef}
      className={bare ? "kp-term kp-term--bare" : "kp-panel kp-term"}
      aria-label={t("terminal.panel.label", { title: terminal.title })}
      data-terminal-id={terminalId}
    >
      {header}
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
      {historyLost && (
        <p role="status" className="kp-term__notice">
          <span>{t("terminal.panel.historyLost")}</span>
          <button type="button" className="kp-btn" onClick={() => reloadRef.current()}>
            {t("terminal.panel.retry")}
          </button>
        </p>
      )}
      <div ref={hostRef} className="kp-term__host" />
    </section>
  );
}
