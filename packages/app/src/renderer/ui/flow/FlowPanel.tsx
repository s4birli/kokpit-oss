// İş W — Akış: the project's (or card's) Mermaid flow diagrams (`docs/akis/*.mmd` by default, engine config).
// Lists the flows, draws the selected one (zoom / pan / Tam ekran) and offers "Akışı çiz / güncelle", which opens a
// project terminal running the engine's command (claude with the shipped Turkish prompt). The list is re-read on
// connect, on a timer and when the project's terminals change, so new or edited files show up by themselves.
// Drawing goes through a FlowRenderer whose SVG is shown only as an <img> (see flow-render.ts for the isolation).
import type { Card, FlowEntry, FlowInfo, Project } from "@kokpit/shared";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { EngineClient } from "../../engine/types.ts";
import { intlLocale, t as translate, useT } from "../../../i18n/index.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { whenConnected } from "../hooks/when-connected.ts";
import type { PanelStateStore } from "../layout/contract.ts";
import { PanelTitle } from "../PanelTitle.tsx";
import type { FlowUiConfig } from "./flow-config.ts";
import { svgDataUrl, type FlowRenderer } from "./flow-render.ts";
import "./flow.css";

export interface FlowPanelProps {
  client: EngineClient;
  config: FlowUiConfig;
  project: Project;
  card: Card | null;
  state: PanelStateStore;
  renderer: FlowRenderer;
  /** Opens a terminal (project or card) running `command`; rejects with the engine error. */
  onUpdate(command: string): Promise<void>;
}

type View =
  | { status: "loading"; key: string }
  | { status: "ok"; key: string; url: string }
  | { status: "error"; key: string; message: string; text?: string };

const SELECTED_KEY = "selected";
const ORIGIN = { x: 0, y: 0 };

const flowKey = (f: FlowEntry): string => `${f.id}@${f.modifiedAt}`;
const sameList = (a: readonly FlowEntry[] | null, b: readonly FlowEntry[]): boolean =>
  a !== null && a.length === b.length && a.every((f, i) => flowKey(f) === flowKey(b[i]!) && f.title === b[i]!.title);

function readSelected(state: PanelStateStore): string | null {
  const v = state.get<unknown>(SELECTED_KEY);
  return typeof v === "string" ? v : null;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

export function FlowPanel({ client, config, project, card, state, renderer, onUpdate }: FlowPanelProps) {
  const t = useT();
  const titleId = useId();
  const listId = useId();
  const remote = !card && project.location.kind === "ssh";
  const target = useMemo(() => (card ? { cardId: card.id } : { projectId: project.id }), [card, project.id]);
  const targetKey = card ? `c:${card.id}` : `p:${project.id}`;

  const [info, setInfo] = useState<FlowInfo | null>(null);
  const [flows, setFlows] = useState<FlowEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => readSelected(state));
  const [view, setView] = useState<View | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [full, setFull] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState(ORIGIN);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  // ---- list: on connect, on a timer, when this project's terminals change ----
  useEffect(() => {
    setInfo(null);
    setFlows(null);
    setListError(null);
    setView(null);
    if (remote) return;
    let disposed = false;
    let haveInfo = false;

    const check = async (): Promise<void> => {
      try {
        if (!haveInfo) {
          const next = await client.request("flow.info", target);
          if (disposed) return;
          haveInfo = true;
          setInfo(next);
        }
        const { flows: next } = await client.request("flow.list", target);
        if (disposed) return;
        setFlows((prev) => (sameList(prev, next) ? prev : next));
        setListError(null);
      } catch (err) {
        if (!disposed && !isDisconnected(err)) setListError(translate("flow.listFailed", { error: errorMessage(err) }));
      }
    };

    const offConnected = whenConnected(client, check);
    const offEvent = client.onEvent((e) => {
      if (e.name === "terminals.changed" && e.projectId === project.id) void check();
    });
    const timer = config.pollMs > 0 ? setInterval(() => void check(), config.pollMs) : undefined;
    return () => {
      disposed = true;
      offConnected();
      offEvent();
      if (timer !== undefined) clearInterval(timer);
    };
    // targetKey stands for `target`.
  }, [client, targetKey, remote, project.id, config.pollMs]);

  const current = useMemo(
    () => (flows && flows.length > 0 ? (flows.find((f) => f.id === selected) ?? flows[0]!) : null),
    [flows, selected],
  );
  const currentKey = current ? flowKey(current) : null;

  // ---- draw the current flow when it (or its file) changes ----
  useEffect(() => {
    if (!current || currentKey === null) {
      setView(null);
      return;
    }
    let cancelled = false;
    setView((v) => (v && v.key.startsWith(`${current.id}@`) ? v : { status: "loading", key: currentKey }));
    void (async () => {
      let text: string | undefined;
      try {
        ({ text } = await client.request("flow.read", { ...target, id: current.id }));
        if (cancelled) return;
        const svg = await renderer.render(text);
        if (cancelled) return;
        setView({ status: "ok", key: currentKey, url: svgDataUrl(svg) });
      } catch (err) {
        if (cancelled || isDisconnected(err)) return;
        const message =
          text === undefined
            ? translate("flow.readFailed", { error: errorMessage(err) })
            : translate("flow.drawFailed", { error: errorMessage(err) });
        setView({ status: "error", key: currentKey, message, ...(text !== undefined ? { text } : {}) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // currentKey stands for `current`, targetKey for `target`.
  }, [client, renderer, currentKey, targetKey]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setFull(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [full]);

  const choose = useCallback(
    (id: string) => {
      setSelected(id);
      state.set(SELECTED_KEY, id);
      setScale(1);
      setOffset(ORIGIN);
    },
    [state],
  );

  const update = useCallback(async (): Promise<void> => {
    if (!info?.updateCommand || updating) return;
    setUpdating(true);
    setActionError(null);
    try {
      await onUpdate(info.updateCommand);
    } catch (err) {
      setActionError(translate("flow.terminalFailed", { error: errorMessage(err) }));
    } finally {
      setUpdating(false);
    }
  }, [info, onUpdate, updating]);

  const zoomBy = useCallback(
    (delta: number) => setScale((s) => round(Math.min(config.zoomMax, Math.max(config.zoomMin, s + delta)))),
    [config.zoomMax, config.zoomMin],
  );
  const fit = (): void => {
    setScale(1);
    setOffset(ORIGIN);
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey) zoomBy(e.deltaY < 0 ? config.zoomStep : -config.zoomStep);
    else setOffset((o) => ({ x: o.x - e.deltaX, y: o.y - e.deltaY }));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
  };
  const endDrag = (): void => {
    drag.current = null;
  };

  const time = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(intlLocale());
  };

  const error = actionError ?? listError ?? (view?.status === "error" ? view.message : null);
  const label = current ? (current.title ?? current.id) : "";

  return (
    <section className={`kp-panel kp-flow${full ? " kp-flow--full" : ""}`} aria-labelledby={titleId}>
      <PanelTitle id={titleId}>{t("flow.title")}</PanelTitle>
      {(current || view?.status === "ok" || (!remote && info?.updateCommand)) && (
        <div className="kp-panel__bar">
          {current && <span className="kp-flow__meta">{current.file}</span>}
          <span className="kp-panel__actions">
            {view?.status === "ok" && (
              <>
                <button type="button" className="kp-btn kp-btn--quiet kp-btn--icon" aria-label={t("flow.zoomOut")} title={t("flow.zoomOut")} onClick={() => zoomBy(-config.zoomStep)}>
                  −
                </button>
                <button type="button" className="kp-btn" onClick={fit}>
                  {t("flow.fit")}
                </button>
                <button type="button" className="kp-btn kp-btn--quiet kp-btn--icon" aria-label={t("flow.zoomIn")} title={t("flow.zoomIn")} onClick={() => zoomBy(config.zoomStep)}>
                  +
                </button>
                <button type="button" className="kp-btn" aria-pressed={full} onClick={() => setFull((f) => !f)}>
                  {full ? t("flow.exitFullScreen") : t("flow.fullScreen")}
                </button>
              </>
            )}
            {!remote && info?.updateCommand && (
              <button type="button" className="kp-btn kp-btn--primary" disabled={updating} onClick={() => void update()}>
                {t("flow.update")}
              </button>
            )}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
      {remote ? (
        <div className="kp-placeholder__body">
          <p className="kp-flow__hint">{t("flow.sshNote")}</p>
        </div>
      ) : flows && flows.length === 0 ? (
        <div className="kp-placeholder__body">
          <p className="kp-flow__hint">
            {t("flow.emptyLead")} <strong>{t("flow.update")}</strong> {t("flow.emptyMiddle")}{" "}
            {info?.dir ? <code>{info.dir}</code> : t("flow.emptyDirFallback")} {t("flow.emptyTail")}
          </p>
          {info?.updateCommand && (
            <>
              <code className="kp-flow__cmd">{info.updateCommand}</code>
              <p>
                <button type="button" className="kp-btn kp-btn--primary" disabled={updating} onClick={() => void update()}>
                  {t("flow.update")}
                </button>
              </p>
            </>
          )}
        </div>
      ) : (
        flows && (
          <div className="kp-flow__body">
            <ul id={listId} className="kp-flow__list" role="listbox" aria-label={t("flow.list")}>
              {flows.map((f) => {
                const active = current?.id === f.id;
                return (
                  <li
                    key={f.id}
                    role="option"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    className={`kp-flow__item${active ? " kp-flow__item--active" : ""}`}
                    onClick={() => choose(f.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        choose(f.id);
                      }
                    }}
                  >
                    <span className="kp-flow__name">{f.title ?? f.id}</span>
                    <span className="kp-flow__time">{time(f.modifiedAt)}</span>
                  </li>
                );
              })}
            </ul>
            <div
              className="kp-flow__viewport"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {view?.status === "ok" && (
                <div
                  className="kp-flow__stage"
                  style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
                >
                  <img className="kp-flow__img" src={view.url} alt={t("flow.imageAlt", { label })} draggable={false} />
                </div>
              )}
              {view?.status === "loading" && <p className="kp-flow__hint">{t("flow.drawing")}</p>}
              {view?.status === "error" && view.text !== undefined && <pre className="kp-flow__source">{view.text}</pre>}
            </div>
          </div>
        )
      )}
    </section>
  );
}
