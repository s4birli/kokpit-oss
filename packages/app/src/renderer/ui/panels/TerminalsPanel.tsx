// İş T — Terminaller paneli: one tab per terminal of the selected project (or card), "+ Yeni terminal ▾",
// confirmed close, and "böl" (two terminals side by side). Every terminal stays mounted and attached; inactive
// ones are only hidden, so switching never re-attaches and never mixes output.
import type { AgentState, TerminalActivity, TerminalInfo } from "@kokpit/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { t as translate, useT } from "../../../i18n/index.ts";
import { agentStateLabel } from "../agents.ts";
import { errorMessage } from "../errors.ts";
import {
  fetchSettings,
  fetchTools,
  SETTINGS_EVENTS,
  TOOLS_EVENTS,
  useEngineResource,
} from "../hooks/useEngineResource.ts";
import { scopeKey, useTerminals, type TerminalScope } from "../hooks/useTerminals.ts";
import type { PanelContext, PanelDefinition } from "../layout/contract.ts";
import { isAppOnlyProject } from "../layout/kinds.ts";
import { effectiveDefaultToolId } from "../projects.ts";
import { TerminalLauncher, type Launch } from "../TerminalLauncher.tsx";
import { toolsForProject } from "../tool-choice.ts";
import { TerminalPanel } from "../TerminalPanel.tsx";
import {
  clampRatio,
  EMPTY_PREFS,
  moveTab,
  neighbourOf,
  PREFS_KEY,
  readPrefs,
  reconcileTabs,
  type TabPrefs,
} from "./terminal-tabs.ts";
import { useTerminalFontSize } from "../view-prefs-context.tsx";
import { shortcutStep } from "../view-prefs.ts";
import "./terminals.css";
import { copyValue } from "../copy-menu.ts";

const NO_TOOLS: never[] = [];

export interface TerminalsPanelProps {
  ctx: PanelContext;
}

export function TerminalsPanel({ ctx }: TerminalsPanelProps) {
  const t = useT();
  const scope: TerminalScope | null = ctx.card
    ? { cardId: ctx.card.id }
    : ctx.project
      ? { projectId: ctx.project.id }
      : null;
  if (scope === null) {
    return (
      <section className="kp-tabs" aria-label={t("terminal.tabs.label")}>
        <p className="kp-tabs__empty">{t("terminal.tabs.noSelection")}</p>
      </section>
    );
  }
  // A new scope is a new set of tabs with its own stored state.
  return <TerminalTabs key={scopeKey(scope)} ctx={ctx} scope={scope} />;
}

export const terminalsPanel: PanelDefinition = {
  id: "terminals",
  get title() {
    return translate("terminal.tabs.panelTitle");
  },
  // Without a selection the panel asks for one; app-only projects have no terminals.
  available: ({ project }) => !isAppOnlyProject(project),
  render: (ctx) => <TerminalsPanel ctx={ctx} />,
};

/** Each terminal's agent state: from the list, then live terminal.activity events and exits. */
function useAgentStates(ctx: PanelContext, terminals: readonly TerminalInfo[]): Record<string, AgentState> {
  const { client } = ctx;
  const [activity, setActivity] = useState<Record<string, TerminalActivity>>({});
  const [exited, setExited] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.name === "terminal.activity") setActivity((a) => ({ ...a, [event.terminalId]: event.activity }));
      }),
    [client],
  );

  const ids = terminals.map((t) => t.id).join("\n");
  useEffect(() => {
    if (ids === "") return;
    const offs = ids
      .split("\n")
      .map((id) => client.onExit(id, () => setExited((s) => (s.has(id) ? s : new Set(s).add(id)))));
    return () => offs.forEach((off) => off());
  }, [client, ids]);

  return useMemo(() => {
    const out: Record<string, AgentState> = {};
    for (const t of terminals) {
      const live = activity[t.id] ?? t.activity;
      out[t.id] =
        exited.has(t.id) || t.status === "exited" || live?.state === "exited" ? "exited" : (live?.state ?? "running");
    }
    return out;
  }, [terminals, activity, exited]);
}

function TerminalTabs({ ctx, scope }: { ctx: PanelContext; scope: TerminalScope }) {
  const t = useT();
  const { client, config, createView } = ctx;
  const list = useTerminals(client, scope);
  // İş Z: global font size; Cmd/Ctrl + − / = / 0 while focus is in this panel (before xterm sees the key).
  const [fontPx, font] = useTerminalFontSize();
  const onFontKey = (e: KeyboardEvent<HTMLElement>): void => {
    const step = shortcutStep(e);
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    font.apply(step);
  };
  // İş K: tools that need screen control are offered only where the project allows it.
  const tools = toolsForProject(useEngineResource(client, fetchTools, TOOLS_EVENTS).data ?? NO_TOOLS, ctx.project ?? undefined);
  const globalDefaultToolId = useEngineResource(client, fetchSettings, SETTINGS_EVENTS).data?.defaultToolId;
  const defaultToolId = effectiveDefaultToolId(ctx.project ?? undefined, globalDefaultToolId, tools);
  const states = useAgentStates(ctx, list.terminals);

  // ---- tab preferences (order, active, split), persisted per scope ----
  const stateRef = useRef(ctx.state);
  stateRef.current = ctx.state;
  const [prefs, setPrefs] = useState<TabPrefs>(() => readPrefs(ctx.state.get(PREFS_KEY) ?? EMPTY_PREFS));
  const byId = useMemo(() => new Map(list.terminals.map((t) => [t.id, t])), [list.terminals]);
  const ids = useMemo(() => list.terminals.map((t) => t.id), [list.terminals]);
  const view = useMemo(() => reconcileTabs(prefs, ids), [prefs, ids]);

  const written = useRef<string | null>(null);
  useEffect(() => {
    // Until the engine answered, an empty list would wrongly drop every stored tab.
    if (!list.loaded) return;
    const json = JSON.stringify(view);
    if (json === written.current) return;
    written.current = json;
    stateRef.current.set(PREFS_KEY, view);
  }, [list.loaded, view]);

  // ---- focus: tab clicks and the host's focus requests ----
  const [focusReq, setFocusReq] = useState<{ id: string; seq: number } | null>(null);
  const focusTerminal = useCallback((id: string) => setFocusReq((f) => ({ id, seq: (f?.seq ?? 0) + 1 })), []);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const activate = useCallback(
    (id: string) => {
      setPrefs((p) => {
        const cur = reconcileTabs(p, ids);
        if (cur.active === id) return p;
        // The partner's tab swaps the two panes; any other tab replaces the active pane.
        return cur.split === id ? { ...cur, active: id, split: cur.active } : { ...cur, active: id };
      });
    },
    [ids],
  );

  const focus = ctx.focus;
  const handledFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!focus?.terminalId || handledFocus.current === focus.seq || !byId.has(focus.terminalId)) return;
    handledFocus.current = focus.seq;
    if (view.split !== focus.terminalId) activate(focus.terminalId);
    focusTerminal(focus.terminalId);
  }, [focus?.terminalId, focus?.seq, byId, view.split, activate, focusTerminal]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, id: string): void => {
    const i = view.order.indexOf(id);
    const n = view.order.length;
    const to =
      e.key === "ArrowRight"
        ? view.order[(i + 1) % n]
        : e.key === "ArrowLeft"
          ? view.order[(i - 1 + n) % n]
          : e.key === "Home"
            ? view.order[0]
            : e.key === "End"
              ? view.order[n - 1]
              : undefined;
    if (to === undefined) return;
    e.preventDefault();
    activate(to);
    tabRefs.current.get(to)?.focus();
  };

  // ---- drag to reorder ----
  const dragged = useRef<string | null>(null);
  const drop = (beforeId: string): void => {
    const id = dragged.current;
    dragged.current = null;
    if (id !== null) setPrefs((p) => ({ ...reconcileTabs(p, ids), order: moveTab(view.order, id, beforeId) }));
  };

  // ---- new terminal ----
  const [menuOpen, setMenuOpen] = useState(false);
  const menuToggle = useRef<HTMLButtonElement>(null);
  // Without terminals the launcher is the panel's content (the only place terminals are opened from); with
  // terminals it is the "+ Yeni terminal ▾" menu.
  const isEmpty = list.loaded && view.order.length === 0;
  const startRef = useRef<HTMLDivElement>(null);
  const addTerminal = list.add;
  const open = async (launch: Launch): Promise<void> => {
    const { terminal } = await client.request("terminal.open", { ...scope, ...config.fallbackDims, ...launch });
    addTerminal(terminal);
    // After the tabs already on screen (stored order may not list them yet), and active.
    setPrefs((p) => {
      const cur = reconcileTabs(p, ids);
      return { ...cur, order: [...cur.order.filter((x) => x !== terminal.id), terminal.id], active: terminal.id };
    });
    focusTerminal(terminal.id);
    setMenuOpen(false);
  };

  const launcher = <TerminalLauncher tools={tools} {...(defaultToolId ? { defaultToolId } : {})} onOpen={open} />;

  // ---- close (confirmed) ----
  const [confirming, setConfirming] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removeTerminal = list.remove;
  const close = async (id: string): Promise<void> => {
    setClosing(true);
    setError(null);
    try {
      await client.request("terminal.close", { terminalId: id });
      const next = neighbourOf(view.order, id);
      setPrefs((p) => {
        const cur = reconcileTabs(p, ids);
        return {
          ...cur,
          order: cur.order.filter((x) => x !== id),
          active: cur.active === id ? next : cur.active,
          split: cur.split === id ? null : cur.split,
        };
      });
      removeTerminal(id);
    } catch (err) {
      setError(t("terminal.panel.closeFailed", { error: errorMessage(err) }));
    } finally {
      setClosing(false);
      setConfirming(null);
    }
  };

  // ---- split ----
  const split = view.split;
  const toggleSplit = (): void => {
    setPrefs((p) => {
      const cur = reconcileTabs(p, ids);
      if (cur.split !== null) return { ...cur, split: null };
      return { ...cur, split: cur.order.find((x) => x !== cur.active) ?? null };
    });
  };
  const ratio = clampRatio(view.ratio ?? config.terminalSplitRatio, config.terminalSplitMinRatio);
  const setRatio = (r: number): void =>
    setPrefs((p) => ({ ...reconcileTabs(p, ids), ratio: clampRatio(r, config.terminalSplitMinRatio) }));
  const stageRef = useRef<HTMLDivElement>(null);
  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const stage = stageRef.current;
    if (!stage) return;
    e.preventDefault();
    const move = (ev: PointerEvent): void => {
      const rect = stage.getBoundingClientRect();
      if (rect.width > 0) setRatio((ev.clientX - rect.left) / rect.width);
    };
    const up = (ev: PointerEvent): void => {
      move(ev);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onDividerKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    setRatio(ratio + step * config.terminalSplitKeyStep);
  };
  const stageStyle: CSSProperties | undefined =
    split !== null ? { gridTemplateColumns: `minmax(0, ${ratio}fr) var(--tabs-divider-w) minmax(0, ${1 - ratio}fr)` } : undefined;

  const paneOf = (id: string): "a" | "b" | "hidden" => (id === view.active ? "a" : id === split ? "b" : "hidden");
  const confirmTitle = confirming === null ? undefined : byId.get(confirming)?.title;

  return (
    <section className="kp-tabs" aria-label={t("terminal.tabs.label")} data-font-size={fontPx} onKeyDownCapture={onFontKey}>
      <div className="kp-tabs__bar">
        <div role="tablist" aria-label={t("terminal.tabs.tablist")} className="kp-tabs__list">
          {view.order.map((id) => {
            const info = byId.get(id)!;
            const state = states[id] ?? "running";
            const isActive = id === view.active;
            return (
              <div
                key={id}
                className={`kp-tabs__tab${isActive ? " kp-tabs__tab--active" : ""}${id === split ? " kp-tabs__tab--split" : ""}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(id);
                }}
              >
                <button
                  ref={(el) => {
                    if (el) tabRefs.current.set(id, el);
                    else tabRefs.current.delete(id);
                  }}
                  type="button"
                  role="tab"
                  id={`kp-tab-${id}`}
                  aria-selected={isActive}
                  aria-controls={`kp-tabpanel-${id}`}
                  tabIndex={isActive ? 0 : -1}
                  className="kp-tabs__select"
                  data-title={info.title}
                  {...copyValue(info.title)}
                  data-state={state}
                  title={`${info.title} — ${agentStateLabel(state)}\n${t("terminal.clipboard.selectionHint")}`}
                  draggable
                  onDragStart={() => (dragged.current = id)}
                  onClick={() => {
                    activate(id);
                    focusTerminal(id);
                  }}
                  onKeyDown={(e) => onTabKey(e, id)}
                >
                  <span className={`kp-tabs__dot kp-tabs__dot--${state}`} aria-hidden="true" />
                  <span className="kp-tabs__title">{info.title}</span>
                  <span className="kp-tabs__sr">, {agentStateLabel(state)}</span>
                </button>
                <button
                  type="button"
                  className="kp-tabs__close"
                  aria-label={t("terminal.tabs.closeTab", { title: info.title })}
                  title={t("terminal.panel.close")}
                  onClick={() => setConfirming(id)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <div className="kp-tabs__actions">
          {split !== null && (
            <label className="kp-tabs__partner">
              <span className="kp-tabs__sr">{t("terminal.tabs.partner")}</span>
              <select
                className="kp-input"
                value={split}
                onChange={(e) => setPrefs((p) => ({ ...reconcileTabs(p, ids), split: e.target.value }))}
              >
                {view.order
                  .filter((id) => id !== view.active)
                  .map((id) => (
                    <option key={id} value={id}>
                      {byId.get(id)!.title}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {/* Font size has no control here: Görünüm menu, or Cmd/Ctrl + − / = / 0 while the panel has focus. */}
          <button
            type="button"
            className="kp-btn"
            aria-pressed={split !== null}
            disabled={view.order.length < 2}
            onClick={toggleSplit}
          >
            {t("terminal.tabs.split")}
          </button>
          <button
            ref={menuToggle}
            type="button"
            className="kp-btn kp-btn--primary"
            aria-haspopup="true"
            aria-expanded={menuOpen || isEmpty}
            onClick={() => {
              if (isEmpty) startRef.current?.querySelector("input")?.focus();
              else setMenuOpen((o) => !o);
            }}
          >
            {t("terminal.tabs.newMenu")}
          </button>
        </div>
      </div>
      {menuOpen && !isEmpty && (
        <div
          role="group"
          aria-label={t("terminal.launcher.newTerminal")}
          className="kp-tabs__menu"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setMenuOpen(false);
            menuToggle.current?.focus();
          }}
        >
          {launcher}
        </div>
      )}
      {confirming !== null && confirmTitle !== undefined && (
        <div className="kp-tabs__confirm">
          <span>{t("terminal.tabs.confirmClose", { title: confirmTitle })}</span>
          <button type="button" className="kp-btn kp-btn--danger" disabled={closing} onClick={() => void close(confirming)}>
            {t("terminal.panel.confirmClose")}
          </button>
          <button type="button" className="kp-btn" disabled={closing} onClick={() => setConfirming(null)}>
            {t("terminal.panel.cancel")}
          </button>
        </div>
      )}
      {(error ?? list.error) && (
        <p role="alert" className="kp-error">
          {error ?? list.error}
        </p>
      )}
      {isEmpty && (
        <div ref={startRef} role="group" aria-label={t("terminal.launcher.newTerminal")} className="kp-tabs__start">
          <p className="kp-tabs__empty">{"cardId" in scope ? t("terminal.tabs.emptyCard") : t("terminal.tabs.emptyProject")}</p>
          {launcher}
        </div>
      )}
      <div ref={stageRef} className={`kp-tabs__stage${split !== null ? " kp-tabs__stage--split" : ""}`} style={stageStyle}>
        {view.order.map((id) => {
          const where = paneOf(id);
          return (
            <div
              key={id}
              role="tabpanel"
              id={`kp-tabpanel-${id}`}
              aria-labelledby={`kp-tab-${id}`}
              className={`kp-tabs__pane kp-tabs__pane--${where}`}
              data-pane={where}
              aria-hidden={where === "hidden" ? true : undefined}
              inert={where === "hidden"}
            >
              <TerminalPanel
                client={client}
                terminal={byId.get(id)!}
                createView={createView}
                config={config}
                bare
                focusSeq={focusReq?.id === id ? focusReq.seq : undefined}
              />
            </div>
          );
        })}
        {split !== null && (
          <div
            role="separator"
            aria-label={t("terminal.tabs.resizeSplit")}
            aria-orientation="vertical"
            aria-valuemin={config.terminalSplitMinRatio * 100}
            aria-valuemax={(1 - config.terminalSplitMinRatio) * 100}
            aria-valuenow={Math.round(ratio * 1000) / 10}
            tabIndex={0}
            className="kp-tabs__divider"
            onPointerDown={onDividerDown}
            onKeyDown={onDividerKey}
          />
        )}
      </div>
    </section>
  );
}
