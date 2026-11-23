// İş L — Modüler düzen: the dockview host. Renders every registered panel in a draggable/splittable/tabbed dock,
// persists the layout and gives each panel its PanelContext (scoped state, reveal, focus, select). Panels never see
// dockview. İş M: the Görünüm toggles and "Varsayılan düzen" live in the native menu bar; the host reports the panel
// list to it and acts on its commands (menu/menu-commands.ts).
// İş D: the layout belongs to the selected project (per layout kind; "no project" has its own). Changing project
// swaps the dock to that project's layout before the next paint; panels open in both layouts stay mounted, so a
// global panel (e.g. Web) keeps its content and its native view. Görünüm and "Varsayılan düzen" act on the
// project on screen only.
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
  type Ref,
} from "react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme, type IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { defaultLayoutConfig, type LayoutConfig } from "./config.ts";
import type { PanelContext, PanelDefinition, PanelId, RevealArgs } from "./contract.ts";
import { onMenuCommand, reportViewMenu, resendViewMenu } from "../menu/menu-commands.ts";
import { addPanelAt, applySizes, restoreLayout, serializeLayout } from "./dock.ts";
import type { DefaultLayout } from "./config.ts";
import { layoutKindOf } from "./kinds.ts";
import { layoutOwnerOf, scopeOf, type LayoutKind, type UiStateStore } from "./ui-state.ts";
import "./layout.css";
import { useLocale } from "../../../i18n/index.ts";

/** What the host needs to build each panel's context; state/reveal/focus/select are the host's own. */
export type PanelBase = Omit<PanelContext, "state" | "reveal" | "focus" | "select">;

export interface LayoutHostHandle {
  reveal(panel: PanelId, args?: RevealArgs): void;
  /** Drops a pending focus request (e.g. the user picked another project in the rail). */
  clearFocus(): void;
}

export interface LayoutHostProps {
  panels: readonly PanelDefinition[];
  /** Already loaded. */
  store: UiStateStore;
  base: PanelBase;
  onSelect: PanelContext["select"];
  config?: LayoutConfig;
  ref?: Ref<LayoutHostHandle>;
}

type FocusRequest = RevealArgs & { panel: PanelId; seq: number };

/** Only the args that are set (exactOptionalPropertyTypes). */
function argsOf(args: RevealArgs | undefined): RevealArgs {
  return {
    ...(args?.terminalId !== undefined ? { terminalId: args.terminalId } : {}),
    ...(args?.tab !== undefined ? { tab: args.tab } : {}),
    ...(args?.siteId !== undefined ? { siteId: args.siteId } : {}),
    ...(args?.filePath !== undefined ? { filePath: args.filePath } : {}),
    ...(args?.fileIsDir !== undefined ? { fileIsDir: args.fileIsDir } : {}),
  };
}

interface HostValue {
  panels: readonly PanelDefinition[];
  base: PanelBase;
  store: UiStateStore;
  scope: string;
  /** Panels the current layout kind allows. */
  allowed: ReadonlySet<string>;
  focus: FocusRequest | null;
  reveal: PanelContext["reveal"];
  select: PanelContext["select"];
  text: LayoutConfig["text"];
}

const HostContext = createContext<HostValue | null>(null);

class PanelBoundary extends Component<{ message: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[kokpit] panel failed", error, info.componentStack);
  }
  override render(): ReactNode {
    return this.state.failed ? (
      <p role="alert" className="kp-error">
        {this.props.message}
      </p>
    ) : (
      this.props.children
    );
  }
}

/** Calls `render` inside the boundary, so a throwing panel is caught. */
function PanelBody({ def, ctx }: { def: PanelDefinition; ctx: PanelContext }) {
  return def.render(ctx);
}

function HostedPanel({ api }: IDockviewPanelProps) {
  const host = useContext(HostContext)!;
  const id = api.id as PanelId;
  const def = host.panels.find((p) => p.id === id);
  const scope = def?.stateScope === "global" ? GLOBAL_SCOPE : host.scope;
  const state = host.store.panelState(id, scope);
  const request = host.focus?.panel === id ? host.focus : null;
  const focus = useMemo(() => (request ? { ...argsOf(request), seq: request.seq } : null), [request]);
  const ctx = useMemo<PanelContext>(
    () => ({ ...host.base, state, reveal: host.reveal, select: host.select, focus }),
    [host.base, state, host.reveal, host.select, focus],
  );
  if (!def) return null;
  const note = ctx.project ? host.text.unavailable : host.text.noSelection;
  return (
    <div className="kp-dock-panel" data-panel-id={id}>
      {/* A new scope gets a fresh boundary, so one failing project doesn't keep the panel dead. */}
      <PanelBoundary key={scope} message={host.text.panelError}>
        {host.allowed.has(id) && def.available(ctx) ? <PanelBody def={def} ctx={ctx} /> : <p className="kp-dock-note">{note}</p>}
      </PanelBoundary>
    </div>
  );
}

/** İş M: the scope of panels whose state is shared by every selection. */
export const GLOBAL_SCOPE = "global";

function Watermark() {
  const host = useContext(HostContext)!;
  return <p className="kp-dock-note">{host.text.emptyDock}</p>;
}

export function LayoutHost({ panels, store, base, onSelect, config = defaultLayoutConfig, ref }: LayoutHostProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const kind: LayoutKind = layoutKindOf(base.project);
  /** İş D: whose layout is in the dock — the selected project (a card uses its project's), or "no project". */
  const owner = layoutOwnerOf(base.project?.id);
  /** The layout the dock currently holds; saves go here. */
  const shownRef = useRef<{ owner: string; kind: LayoutKind }>({ owner, kind });
  const restoringRef = useRef(false);
  /** D1: the layout (as stored text) the dock was last put in by the host or saved as; only a different one is saved. */
  const settledRef = useRef<string | null>(null);
  /** A default layout built before the dock had a size; its group sizes are applied on the first real layout. */
  const pendingSizesRef = useRef<DefaultLayout | null>(null);
  /**
   * A reveal of a panel the current layout kind doesn't allow, e.g. "Seni bekleyen" clicked while an app-only project is
   * on screen: select() switches to a normal project, whose layout is only restored by the effect below.
   */
  const pendingRevealRef = useRef<PanelId | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  /** İş M: never restarts (also not after clearFocus), so a panel can tell a new request from one it already handled. */
  const focusSeqRef = useRef(0);
  const configRef = useRef(config);
  configRef.current = config;
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  // i18n: titles and texts are read at render; a language switch re-renders the host and re-titles the open tabs.
  const locale = useLocale();

  const syncOpen = useCallback(() => {
    const api = apiRef.current;
    if (api) setOpen(new Set(api.panels.map((p) => p.id)));
    // dockview makes each group a region named after its active tab; our panels already name their own regions,
    // and two regions called "Ajanlar" confuse screen readers (and tests). Tabs + tabpanels stay.
    for (const el of rootRef.current?.querySelectorAll('.dv-groupview[role="region"]') ?? []) el.removeAttribute("role");
  }, []);

  /** The dock's layout as it is stored, and as text to compare two of them. */
  const snapshot = useCallback((api: DockviewApi) => {
    const layout = serializeLayout(api, configRef.current.gap) as unknown as Record<string, unknown>;
    return { layout, text: JSON.stringify(layout) };
  }, []);

  /** D1: the dock is as the host itself arranged it (or as it was last stored) — nothing to save until it differs. */
  const settle = useCallback(() => {
    const api = apiRef.current;
    if (api) settledRef.current = snapshot(api).text;
  }, [snapshot]);

  /** Stores the dock's layout when it is no longer the settled one, i.e. when the user changed it. */
  const save = useCallback(() => {
    const api = apiRef.current;
    if (!api || restoringRef.current) return;
    const { layout, text } = snapshot(api);
    if (text === settledRef.current) return;
    settledRef.current = text;
    const { owner: o, kind: k } = shownRef.current;
    store.setLayout(o, k, layout);
  }, [store, snapshot]);

  /**
   * Runs a whole-layout change without saving its intermediate states. `fn` tells whether the result is to be
   * stored (the user asked for it, or it replaces a damaged stored layout); showing a layout is not a change (D1).
   */
  const rebuild = useCallback(
    (fn: (api: DockviewApi) => boolean) => {
      const api = apiRef.current;
      if (!api) return;
      let persist = false;
      restoringRef.current = true;
      try {
        persist = fn(api);
      } finally {
        restoringRef.current = false;
      }
      if (persist) {
        settledRef.current = null;
        save();
      } else {
        settle();
      }
      syncOpen();
    },
    [save, settle, syncOpen],
  );

  /** Puts the layout of `shownRef` in the dock: the project's own, else the inherited one, else the default. */
  const restore = useCallback(
    () =>
      rebuild((api) => {
        const { owner: o, kind: k } = shownRef.current;
        const fallback = configRef.current.defaults[k];
        const stored = store.getLayout(o, k);
        const restored = restoreLayout(api, stored, fallback, panelsRef.current);
        pendingSizesRef.current = restored || applySizes(api, fallback) ? null : fallback;
        // A stored layout that could not be used is replaced by the default it fell back to.
        return stored !== undefined && !restored;
      }),
    [rebuild, store],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      // Announcements are off; dockview still adds its (empty) live regions, one of them role="alert".
      for (const el of rootRef.current?.querySelectorAll(".dv-live-region, .dv-live-region-assertive") ?? []) el.remove();
      api.onDidLayoutChange(() => {
        const pending = pendingSizesRef.current;
        if (pending && applySizes(api, pending)) {
          // The default layout getting its sizes is still the default, not something the user arranged.
          pendingSizesRef.current = null;
          settle();
        }
        save();
        syncOpen();
      });
      api.onDidAddPanel(syncOpen);
      api.onDidRemovePanel(syncOpen);
      restore();
    },
    [restore, save, settle, syncOpen],
  );

  const allowedFor = useCallback((id: PanelId) => configRef.current.kindPanels[shownRef.current.kind].includes(id), []);

  /** Puts `id` on screen (adding it at its default place when closed). */
  const show = useCallback((id: PanelId) => {
    const api = apiRef.current;
    const def = panelsRef.current.find((p) => p.id === id);
    if (!api || !def) return;
    if (!api.getPanel(id)) addPanelAt(api, def, configRef.current.placement[id]);
    api.getPanel(id)?.api.setActive();
  }, []);

  // İş D: another project (or crossing between layout kinds) swaps the whole layout. A layout effect, so
  // the new project's panels are never painted in the previous project's arrangement. The layout being left is
  // already stored (every change saves itself), and is not written again here: its project may just have been deleted.
  useLayoutEffect(() => {
    const shown = shownRef.current;
    if (shown.owner === owner && shown.kind === kind) return;
    shownRef.current = { owner, kind };
    if (!apiRef.current) return; // not ready yet: onReady restores what shownRef says
    restore();
    const pending = pendingRevealRef.current;
    pendingRevealRef.current = null;
    if (pending && allowedFor(pending)) show(pending);
  }, [owner, kind, restore, allowedFor, show]);

  const toggle = useCallback((id: PanelId) => {
    const api = apiRef.current;
    const def = panelsRef.current.find((p) => p.id === id);
    if (!api || !def) return;
    if (!api.getPanel(id) && !allowedFor(id)) return;
    const panel = api.getPanel(id);
    if (panel) api.removePanel(panel);
    else addPanelAt(api, def, configRef.current.placement[id]);
  }, [allowedFor]);

  const reset = useCallback(
    () =>
      rebuild((api) => {
        const layout = configRef.current.defaults[shownRef.current.kind];
        restoreLayout(api, undefined, layout, panelsRef.current);
        pendingSizesRef.current = applySizes(api, layout) ? null : layout;
        return true; // the user's own doing: stored
      }),
    [rebuild],
  );

  const reveal = useCallback<PanelContext["reveal"]>(
    (id, args) => {
      if (allowedFor(id)) {
        pendingRevealRef.current = null;
        show(id);
      } else {
        pendingRevealRef.current = id;
      }
      focusSeqRef.current += 1;
      setFocus({ panel: id, ...argsOf(args), seq: focusSeqRef.current });
    },
    [allowedFor, show],
  );

  const clearFocus = useCallback(() => {
    pendingRevealRef.current = null;
    setFocus(null);
  }, []);

  useImperativeHandle(ref, () => ({ reveal, clearFocus }), [reveal, clearFocus]);

  const scope = scopeOf(base.project?.id, base.card?.id);
  const allowedIds = config.kindPanels[kind];
  const allowed = useMemo<ReadonlySet<string>>(() => new Set(allowedIds), [allowedIds]);
  const host = useMemo<HostValue>(
    // `locale`: a new value after a switch, so every hosted panel re-reads the texts.
    () => ({ panels, base, store, scope, allowed, focus, reveal, select: onSelect, text: config.text }),
    [panels, base, store, scope, allowed, focus, reveal, onSelect, config.text, locale],
  );

  const components = useMemo(() => Object.fromEntries(panels.map((p) => [p.id, HostedPanel])), [panels]);
  const theme = useMemo<DockviewTheme>(() => ({ name: "kokpit", className: "kp-dock", colorScheme: "dark", gap: config.gap }), [config.gap]);
  const messages = useMemo(
    () => ({
      closeTab: config.text.closeTab,
      closeTabPlain: () => config.text.closeTabPlain,
    }),
    [config.text, locale],
  );

  // i18n: a restored layout already takes its titles from the registry (dock.ts); after a switch, so do open tabs.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const panel of api.panels) {
      const def = panelsRef.current.find((d) => d.id === panel.id);
      if (def && panel.title !== def.title) panel.api.setTitle(def.title);
    }
  }, [locale]);

  // İş M: Görünüm in the native menu bar — every panel, checked when open, enabled when it can be toggled here.
  const { project, card } = base;
  useEffect(() => {
    reportViewMenu({
      panels: panels.map((p) => ({
        id: p.id,
        title: p.title,
        checked: open.has(p.id),
        enabled: open.has(p.id) || (allowed.has(p.id) && p.available({ project, card })),
      })),
    });
    // `locale`: titles are read in the current language, so a switch sends the new ones to the menu.
  }, [panels, open, allowed, project, card, locale]);
  useEffect(
    () =>
      onMenuCommand((c) => {
        if (c.type === "layout.reset") reset();
        else if (c.type === "panel.toggle") {
          if (panelsRef.current.some((p) => p.id === c.panelId)) toggle(c.panelId as PanelId);
          // The native checkbox flipped itself; if nothing changed, put it back (a real change reports itself anyway).
          resendViewMenu();
        }
      }),
    [reset, toggle],
  );

  return (
    <HostContext.Provider value={host}>
      <div className="kp-layout" ref={rootRef}>
        <DockviewReact
          className="kp-dock-root"
          components={components}
          watermarkComponent={Watermark}
          onReady={onReady}
          theme={theme}
          messages={messages}
          disableFloatingGroups
          announcements={false}
        />
      </div>
    </HostContext.Provider>
  );
}
