import type { BgAgentSession, BrowserState, Card, Project, TerminalInfo } from "@kokpit/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineClient } from "../engine/types.ts";
import type { UiStateBridge } from "../engine/ui-state-ipc.ts";
import { agentCounts, agentLabel, waitingAgents } from "./agents.ts";
import { bgAgentCounts, mergeCounts, waitingBgAgents } from "./bg-agents.ts";
import { CardBar } from "./CardBar.tsx";
import { defaultUiConfig, type UiConfig } from "./config.ts";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import {
  fetchHosts,
  fetchTools,
  HOSTS_EVENTS,
  TOOLS_EVENTS,
  useEngineResource,
} from "./hooks/useEngineResource.ts";
import { useAgents } from "./hooks/useAgents.ts";
import { useBgAgents } from "./hooks/useBgAgents.ts";
import { useConnectionState } from "./hooks/useConnectionState.ts";
import { useNow } from "./hooks/useNow.ts";
import { useProjects } from "./hooks/useProjects.ts";
import type { TerminalScope } from "./hooks/useTerminals.ts";
import { defaultLayoutConfig, type LayoutConfig } from "./layout/config.ts";
import type { PanelContext, PanelDefinition } from "./layout/contract.ts";
import { LayoutHost, type LayoutHostHandle, type PanelBase } from "./layout/LayoutHost.tsx";
import { LegacyPanelsContext, type LegacyPanelsData } from "./layout/legacy-panels.tsx";
import { PANELS } from "./layout/registry.ts";
import { createUiStateStore, scopeOf, type SavedSelection } from "./layout/ui-state.ts";
import { accountBadge, CLAUDE_ACCOUNTS_EVENTS, fetchClaudeAccounts, projectAccountBadge } from "./claude-accounts.ts";
import { accountUsage, CLAUDE_USAGE_EVENTS, fetchClaudeUsage, usageTooltip } from "./claude-usage.ts";
import {
  activateTab,
  closeTab,
  dropCard,
  dropMissingCards,
  emptyTabs,
  mergeTabs,
  moveTab,
  openTab,
  retainProjects,
  selectionOf,
  tabsFromSelection,
  type ProjectTabsState,
} from "./project-tabs.ts";
import { ProjectTabs, type ProjectTabItem } from "./ProjectTabs.tsx";
import { locationLabel } from "./projects.ts";
import { Rail, type WorkbenchView } from "./Rail.tsx";
import type { Launch } from "./TerminalLauncher.tsx";
import type { TerminalViewFactory } from "./terminal-view.ts";
import { TodoPanel } from "./todos/TodoPanel.tsx";
import { createXtermView } from "./xterm-view.ts";
import { useMenuCommand } from "./menu/menu-commands.ts";
import { webConfig } from "../engine/web-ipc.ts";
import { ViewPrefsContext, type ViewPrefs } from "./view-prefs-context.tsx";
import { createFontSizeStore, dispatchViewCommand, GLOBAL_SCOPE, isViewCommand, onViewCommand } from "./view-prefs.ts";
import { CLAUDE_HELP_COMMAND, revealClaudeHelp } from "./panels/ClaudePanel.tsx";
// Bağlantılar: links of the terminals open in their project's browser.
import { linksConfig } from "../engine/links-ipc.ts";
import { ACTIVE_TAB_KEY, type StoredTab } from "./BrowserPanel.tsx";
import { createLinkOpener, LinkOpenerContext } from "./link-opener.ts";
import { intlLocale, useLocale, useT } from "../../i18n/index.ts";
import "./theme.css";
import "./workbench.css";

/** Settings tabs the workbench can ask to open. */
export type SettingsTab = "projects" | "servers" | "tools" | "connection";

export interface WorkbenchProps {
  client: EngineClient;
  /** Opens the settings screen, optionally on a given tab. */
  onOpenSettings: (tab?: SettingsTab) => void;
  /** Engine address, shown in the connection banner. */
  engineUrl?: string;
  /** Terminal renderer; defaults to xterm. Tests inject a fake. */
  createView?: TerminalViewFactory;
  config?: Partial<UiConfig>;
  /** Selects a project from outside (e.g. after "Kur"); a new `seq` repeats the request. */
  selectProject?: { projectId: string; seq: number };
  /** İş L: where the layout and panel state are saved; defaults to the preload bridge, null = not persisted. */
  uiState?: UiStateBridge | null;
  /** İş L: the dockable panels; defaults to the registry. */
  panels?: readonly PanelDefinition[];
  layoutConfig?: LayoutConfig;
}

const EMPTY: never[] = [];

export function Workbench(props: WorkbenchProps) {
  const { client, onOpenSettings, engineUrl, createView = createXtermView, config, selectProject } = props;
  const { panels = PANELS, layoutConfig = defaultLayoutConfig } = props;
  const uiConfig = useMemo<UiConfig>(() => ({ ...defaultUiConfig, ...config }), [config]);
  const t = useT();
  const locale = useLocale();
  const connection = useConnectionState(client);
  const { projects, cardsByProject, error, cardErrors, reloadCards, addCard } = useProjects(client);
  const tools = useEngineResource(client, fetchTools, TOOLS_EVENTS).data ?? EMPTY;
  const hosts = useEngineResource(client, fetchHosts, HOSTS_EVENTS).data ?? EMPTY;
  const [view, setView] = useState<WorkbenchView>("work");
  const projectOfCard = useCallback(
    (cardId: string): string | undefined => {
      for (const [projectId, cards] of Object.entries(cardsByProject)) if (cards.some((c) => c.id === cardId)) return projectId;
      return undefined;
    },
    [cardsByProject],
  );
  // İş P: the open project tabs; the active tab (and its card) is the selection.
  const [tabs, setTabs] = useState<ProjectTabsState>(emptyTabs);
  const selection = useMemo(() => selectionOf(tabs), [tabs]);
  /** İş P: a selection saved before tabs existed, waiting to become the only tab (a card needs its project). */
  const [legacySelection, setLegacySelection] = useState<SavedSelection>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);

  // ---- İş L: persisted layout, panel state and selection ----
  const [uiStore] = useState(() =>
    createUiStateStore({
      bridge: props.uiState === undefined ? (typeof window === "undefined" ? null : (window.kokpit?.uiState ?? null)) : props.uiState,
      saveDebounceMs: layoutConfig.saveDebounceMs,
    }),
  );
  const [uiReady, setUiReady] = useState(false);
  const layoutRef = useRef<LayoutHostHandle>(null);
  useEffect(() => {
    let active = true;
    void uiStore.load().then(() => {
      if (!active) return;
      // An explicit request (e.g. after "Kur") or a click while loading wins over the saved tabs.
      const saved = uiStore.getTabs();
      if (saved) setTabs((cur) => mergeTabs(saved, cur));
      else setLegacySelection(uiStore.getSelection());
      setRailCollapsed(uiStore.getRailCollapsed());
      setUiReady(true);
    });
    const flush = (): void => void uiStore.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      active = false;
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [uiStore]);
  useEffect(() => {
    if (!legacySelection) return;
    const migrated = tabsFromSelection(legacySelection, projectOfCard);
    if (!migrated) return;
    setTabs((cur) => mergeTabs(migrated, cur));
    setLegacySelection(null);
  }, [legacySelection, projectOfCard]);
  useEffect(() => {
    // Not while a legacy selection waits: saving empty tabs now would lose it.
    if (!uiReady || legacySelection) return;
    uiStore.setSelection(selection);
    uiStore.setTabs(tabs);
  }, [uiReady, uiStore, selection, tabs, legacySelection]);
  useEffect(() => {
    if (uiReady) uiStore.setRailCollapsed(railCollapsed);
  }, [uiReady, uiStore, railCollapsed]);
  // İş P: tabs of deleted projects close; a deleted card's tab falls back to its project.
  // İş D: a deleted project's panel layout is forgotten with it.
  useEffect(() => {
    if (!uiReady || projects.length === 0) return;
    const known = new Set(projects.map((p) => p.id));
    setTabs((cur) => retainProjects(cur, known));
    uiStore.retainLayouts(known);
  }, [uiReady, uiStore, projects]);
  useEffect(() => {
    setTabs((cur) => dropMissingCards(cur, (projectId) => cardsByProject[projectId]));
  }, [cardsByProject]);

  // ---- İş Z: global terminal font size (persisted) + view commands from the menu/shortcuts ----
  const viewPrefs = useMemo<ViewPrefs | null>(
    () =>
      uiReady
        ? {
            font: createFontSizeStore(uiStore.panelState("terminals", GLOBAL_SCOPE), uiConfig),
            panelState: (panelId, scope) => uiStore.panelState(panelId, scope),
          }
        : null,
    [uiReady, uiStore, uiConfig],
  );
  useEffect(() => {
    if (!viewPrefs) return;
    return onViewCommand((cmd) => {
      if (cmd === "terminal.font.smaller") viewPrefs.font.apply("smaller");
      else if (cmd === "terminal.font.larger") viewPrefs.font.apply("larger");
      else if (cmd === "terminal.font.reset") viewPrefs.font.apply("reset");
    });
  }, [viewPrefs]);

  // ---- İş M: Git › <site> opens its tab in the Web panel; the very first launch shows Ana sayfa ----
  // Görünüm's font/zoom items go to İş Z's view commands; Yardım › Claude komutları to the Claude panel's Rehber.
  useMenuCommand((c) => {
    if (isViewCommand(c.type)) {
      dispatchViewCommand(c.type);
    } else if (c.type === CLAUDE_HELP_COMMAND) {
      setView("work");
      if (layoutRef.current) revealClaudeHelp(layoutRef.current);
    } else if (c.type === "site.open") {
      setView("work");
      layoutRef.current?.reveal("web", { siteId: c.siteId });
    }
  });
  const firstLaunchChecked = useRef(false);
  /** İş D: Ana sayfa was opened by the first launch while no project was selected; see the effect below. */
  const firstLaunchWebRef = useRef(false);
  const projectIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!uiReady || firstLaunchChecked.current) return;
    firstLaunchChecked.current = true;
    const web = typeof window === "undefined" ? undefined : window.kokpit?.web;
    if (!uiStore.isFresh() || !web) return;
    const siteId = webConfig.firstLaunchSiteId;
    web.sites.load().then(
      (sites) => {
        if (!sites.some((s) => s.id === siteId)) return;
        layoutRef.current?.reveal("web", { siteId });
        firstLaunchWebRef.current = projectIdRef.current === undefined;
      },
      () => {},
    );
  }, [uiReady, uiStore]);

  const requestedProject = selectProject?.projectId;
  const requestSeq = selectProject?.seq;
  useEffect(() => {
    if (requestedProject === undefined) return;
    setTabs((cur) => openTab(cur, requestedProject, null));
    setView("work");
  }, [requestedProject, requestSeq]);

  const selectedCard: Card | undefined = useMemo(() => {
    if (selection?.kind !== "card") return undefined;
    for (const cards of Object.values(cardsByProject)) {
      const found = cards.find((c) => c.id === selection.cardId);
      if (found) return found;
    }
    return undefined;
  }, [cardsByProject, selection]);
  const projectId = selection?.kind === "project" ? selection.projectId : selectedCard?.projectId;
  const selectedProject: Project | undefined = projects.find((p) => p.id === projectId);
  // İş D: layouts are per project, so the first project picked would start without the Web panel and the first
  // launch's Ana sayfa would vanish with that click. It is carried over once, into that project's layout.
  useEffect(() => {
    projectIdRef.current = projectId;
    if (projectId === undefined || !firstLaunchWebRef.current) return;
    firstLaunchWebRef.current = false;
    layoutRef.current?.reveal("web");
  }, [projectId]);

  // ---- Bağlantılar: a link in a terminal opens in that terminal's project browser ----
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const engineUrlRef = useRef(engineUrl);
  engineUrlRef.current = engineUrl;
  /** What is on screen now: only then is the Tarayıcı panel touched for a link. */
  const shownRef = useRef<{ projectId: string | undefined; cardId: string | undefined }>({ projectId: undefined, cardId: undefined });
  shownRef.current = { projectId, cardId: selectedCard?.id };
  const linkOpener = useMemo(
    () =>
      createLinkOpener({
        client,
        project: (id) => projectsRef.current.find((p) => p.id === id),
        engineOpen: {
          // The panel reselects a remembered tab when it first sees the browser running (e.g. started by this very
          // link, with tabs restored from the last session): what it remembers becomes the link, not an older tab.
          before: (linkProjectId, url) => {
            const shown = shownRef.current;
            if (shown.projectId !== linkProjectId) return;
            uiStore.panelState("browser", scopeOf(shown.projectId, shown.cardId)).set(ACTIVE_TAB_KEY, { tabId: "", url } satisfies StoredTab);
          },
          // The link's tab is the active one in the project's Chrome; show it — unless the user moved on to another
          // project meanwhile (the panel would show that one's browser).
          after: (linkProjectId, browser: BrowserState) => {
            const shown = shownRef.current;
            if (shown.projectId !== linkProjectId) return;
            const active = browser.tabs.find((t) => t.id === browser.activeTabId);
            if (active) uiStore.panelState("browser", scopeOf(shown.projectId, shown.cardId)).set(ACTIVE_TAB_KEY, { tabId: active.id, url: active.url } satisfies StoredTab);
            setView("work");
            layoutRef.current?.reveal("browser");
          },
        },
        links: typeof window === "undefined" ? undefined : window.kokpit?.links,
        openLocal: typeof window === "undefined" ? undefined : window.kokpit?.browser?.openLocal,
        config: linksConfig,
        machineName: uiConfig.machineName,
        // Yollar: a file of the project's (or card's) folder is shown in Dosyalar — of the selection on screen only.
        showFile: (fileProjectId, location) => {
          const shown = shownRef.current;
          if (shown.projectId !== fileProjectId || shown.cardId !== location.cardId || location.rootPath === undefined) return false;
          setView("work");
          layoutRef.current?.reveal("files", { filePath: location.rootPath, fileIsDir: location.kind === "dir" });
          return true;
        },
        engineUrl: () => engineUrlRef.current,
      }),
    [client, uiStore, uiConfig.machineName],
  );
  // Yollar: a program in a terminal ran `open <address | page>`; the engine showed it in that project's Chrome.
  // Like after a link click, the Tarayıcı panel comes to the front — when that project is the one on screen.
  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.name !== "browser.reveal" || shownRef.current.projectId !== event.projectId) return;
        setView("work");
        layoutRef.current?.reveal("browser");
      }),
    [client],
  );

  const createCard = useCallback(
    async (projectId: string, name: string): Promise<void> => {
      const { card } = await client.request("cards.create", { projectId, name });
      addCard(card);
      setTabs((cur) => openTab(cur, projectId, card.id));
      void reloadCards(projectId);
    },
    [client, addCard, reloadCards],
  );

  const deleteCard = useCallback(
    async (card: Card): Promise<void> => {
      await client.request("cards.delete", { cardId: card.id });
      setTabs((cur) => dropCard(cur, card.id));
      await reloadCards(card.projectId);
    },
    [client, reloadCards],
  );

  // The user opens terminals from the Terminal panel's launcher only; this one serves the other panels.
  // The Terminal panel (İş T) keeps its own list; it learns of a new terminal from the engine's terminals.changed.
  const openTerminal = useCallback(
    async (target: TerminalScope, launch: Launch): Promise<TerminalInfo> => {
      const { terminal } = await client.request("terminal.open", { ...target, ...uiConfig.fallbackDims, ...launch });
      return terminal;
    },
    [client, uiConfig],
  );

  // ---- İş A: ajan özeti ----
  const agents = useAgents(client);
  const now = useNow(uiConfig.agentsClockMs);
  const selectFromPanel = useCallback<PanelContext["select"]>(({ projectId, cardId }) => {
    setTabs((cur) => openTab(cur, projectId, cardId ?? null));
    setView("work");
  }, []);
  const focusAgent = useCallback(
    (t: TerminalInfo) => {
      selectFromPanel({ projectId: t.projectId, ...(t.cardId !== undefined ? { cardId: t.cardId } : {}) });
      layoutRef.current?.reveal("terminals", { terminalId: t.id });
    },
    [selectFromPanel],
  );
  const railAgents = useMemo(() => {
    const cardName = (t: TerminalInfo) =>
      t.cardId === undefined ? undefined : cardsByProject[t.projectId]?.find((c) => c.id === t.cardId)?.name;
    return {
      counts: agentCounts(agents.terminals),
      waiting: waitingAgents(agents.terminals).map((t) => {
        const card = cardName(t);
        return {
          terminal: t,
          label: agentLabel(t, tools),
          projectName: projects.find((p) => p.id === t.projectId)?.name ?? t.projectId,
          ...(card !== undefined ? { cardName: card } : {}),
        };
      }),
    };
  }, [agents.terminals, cardsByProject, projects, tools]);
  // ---- İş A (Adım 7): arka plan ajanları ----
  const bg = useBgAgents(client);
  const claudeAccounts = useEngineResource(client, fetchClaudeAccounts, CLAUDE_ACCOUNTS_EVENTS).data; // İş H
  // Claude kullanımı: for the account badge's tooltip. No polling here — read on connect, when the engine
  // announces new numbers, and when a badge is hovered.
  const claudeUsage = useEngineResource(client, fetchClaudeUsage, CLAUDE_USAGE_EVENTS);
  const claudeUsageData = claudeUsage.data;
  const reloadClaudeUsage = claudeUsage.reload;
  const onAccountHover = useCallback(() => void reloadClaudeUsage(), [reloadClaudeUsage]);
  const [bgHighlight, setBgHighlight] = useState<{ id: string; seq: number } | null>(null);
  const placeOf = useCallback(
    (s: { projectId?: string; cardId?: string }): { projectName: string; cardName?: string } => {
      if (s.projectId === undefined) return { projectName: t("workbench.place.other") };
      const projectName = projects.find((p) => p.id === s.projectId)?.name ?? s.projectId;
      const cardName = s.cardId === undefined ? undefined : cardsByProject[s.projectId]?.find((c) => c.id === s.cardId)?.name;
      return { projectName, ...(cardName !== undefined ? { cardName } : {}) };
    },
    [projects, cardsByProject, t],
  );
  const attachBg = useCallback(
    async (id: string): Promise<void> => {
      const { terminal } = await client.request("bgAgents.attach", { id, ...uiConfig.fallbackDims });
      focusAgent(terminal);
    },
    [client, uiConfig, focusAgent],
  );
  const selectBgAgent = useCallback(
    (s: BgAgentSession) => {
      const builtin = projects.find((p) => p.builtin)?.id;
      const cardId = s.cardId;
      const cardProject = cardId === undefined ? undefined : (s.projectId ?? projectOfCard(cardId));
      if (cardId !== undefined && cardProject !== undefined) setTabs((cur) => openTab(cur, cardProject, cardId));
      else if (s.projectId !== undefined) setTabs((cur) => openTab(cur, s.projectId!, null));
      else if (builtin !== undefined) setTabs((cur) => openTab(cur, builtin, null));
      setView("work");
      layoutRef.current?.clearFocus();
      // İş L: the session is listed in the Ajanlar panel; make sure that panel is on screen.
      layoutRef.current?.reveal("agents");
      setBgHighlight((h) => ({ id: s.id, seq: (h?.seq ?? 0) + 1 }));
    },
    [projects, projectOfCard],
  );
  const railBgWaiting = useMemo(
    () => waitingBgAgents(bg.sessions).map((session) => ({ session, ...placeOf(session) })),
    [bg.sessions, placeOf],
  );
  const background = useMemo<LegacyPanelsData["background"]>(
    () => ({
      sessions: bg.sessions,
      error: bg.error,
      placeOf: (s) => {
        const p = placeOf(s);
        return p.cardName ? `${p.projectName} › ${p.cardName}` : p.projectName;
      },
      highlight: bgHighlight,
      accountOf: (s) => accountBadge(claudeAccounts, s.accountId), // İş H
      onAttach: attachBg,
      onLogs: (id) => client.request("bgAgents.logs", { id }),
      onStop: async (id) => {
        await client.request("bgAgents.stop", { id });
      },
    }),
    [bg.sessions, bg.error, placeOf, bgHighlight, attachBg, client, claudeAccounts],
  );

  const selectCard = useCallback(
    (cardId: string) => {
      const projectId = projectOfCard(cardId);
      if (projectId === undefined) return;
      setTabs((cur) => openTab(cur, projectId, cardId));
      layoutRef.current?.clearFocus();
      setBgHighlight(null);
    },
    [projectOfCard],
  );
  /** İş P: opens/activates the project's tab (keeping its card); on the active tab, goes back to the project itself. */
  const selectProjectInRail = useCallback((id: string) => {
    setTabs((cur) => (cur.active === id ? openTab(cur, id, null) : openTab(cur, id)));
    layoutRef.current?.clearFocus();
    setBgHighlight(null);
  }, []);
  const activateProjectTab = useCallback((id: string) => {
    setTabs((cur) => activateTab(cur, id));
    layoutRef.current?.clearFocus();
    setBgHighlight(null);
  }, []);
  const closeProjectTab = useCallback((id: string) => setTabs((cur) => closeTab(cur, id)), []);
  const moveProjectTab = useCallback((id: string, index: number) => setTabs((cur) => moveTab(cur, id, index)), []);
  const projectCounts = useMemo(() => mergeCounts(railAgents.counts, bgAgentCounts(bg.sessions)), [railAgents.counts, bg.sessions]);
  const tabItems = useMemo<ProjectTabItem[]>(
    () =>
      tabs.tabs.flatMap((t) => {
        const project = projects.find((p) => p.id === t.projectId);
        if (!project) return [];
        return [
          {
            projectId: project.id,
            title: project.name,
            count: projectCounts[project.id],
            // The work area has no header row: the location is the tab's tooltip, the account a badge on it.
            location: locationLabel(project, hosts, uiConfig.machineName),
            accountName: projectAccountBadge(claudeAccounts, project),
            accountUsage: usageTooltip(accountUsage(claudeUsageData, project.claudeAccountId), claudeUsageData, intlLocale(locale)),
          },
        ];
      }),
    [tabs.tabs, projects, projectCounts, hosts, uiConfig.machineName, locale, claudeAccounts, claudeUsageData],
  );

  const panelBase = useMemo<PanelBase>(
    () => ({
      client,
      config: uiConfig,
      createView,
      project: selectedProject ?? null,
      card: selectedCard ?? null,
      ...(engineUrl !== undefined ? { engineUrl } : {}),
    }),
    [client, uiConfig, createView, selectedProject, selectedCard, engineUrl],
  );
  const legacy = useMemo<LegacyPanelsData>(
    () => ({ tools, cardsByProject, agents, now, openTerminal, background }),
    [tools, cardsByProject, agents, now, openTerminal, background],
  );

  // No header row while something is selected — the dock starts right under the project tabs. A project keeps
  // its name for assistive tech only; a card's line sits at the right end of the tab strip.
  const selectedProjectOnly = selection?.kind === "project" ? selectedProject : undefined;

  return (
    <div className="kp-root">
      <ConnectionBanner state={connection} engineUrl={engineUrl} transportMessage={client.transportMessage} onOpenSettings={() => onOpenSettings("connection")} />
      <div className="kp-page">
        <Rail
          projects={projects}
          cardsByProject={cardsByProject}
          error={error}
          cardErrors={cardErrors}
          selectedCardId={selectedCard?.id ?? null}
          selectedProjectId={selection?.kind === "project" ? selection.projectId : null}
          onSelectCard={selectCard}
          onSelectProject={selectProjectInRail}
          onCreateCard={createCard}
          view={view}
          onViewChange={setView}
          onOpenSettings={() => onOpenSettings()}
          agentCounts={projectCounts}
          waitingAgents={railAgents.waiting}
          now={now}
          onSelectAgent={focusAgent}
          waitingBgAgents={railBgWaiting}
          onSelectBgAgent={selectBgAgent}
          collapsed={railCollapsed}
          onToggleCollapsed={() => setRailCollapsed((c) => !c)}
        />
        <main className="kp-main">
          {/* The work view stays mounted while hidden so terminals keep streaming. */}
          <div className="kp-view kp-view--work" hidden={view !== "work"}>
            {tabItems.length > 0 && (
              <div className="kp-topbar">
                <ProjectTabs
                  items={tabItems}
                  active={tabs.active}
                  onActivate={activateProjectTab}
                  onClose={closeProjectTab}
                  onMove={moveProjectTab}
                  onAccountHover={onAccountHover}
                />
                {selectedCard && (
                  <CardBar
                    key={selectedCard.id}
                    card={selectedCard}
                    projectName={selectedProject?.name ?? selectedCard.projectId}
                    onDelete={() => deleteCard(selectedCard)}
                  />
                )}
              </div>
            )}
            {selectedProjectOnly && <h2 className="kp-header__title kp-visually-hidden">{selectedProjectOnly.name}</h2>}
            {!selectedCard && !selectedProjectOnly && (
              <header className="kp-header">
                <h2 className="kp-header__title">{t("workbench.noSelection.title")}</h2>
                <p className="kp-header__hint">{t("workbench.noSelection.hint")}</p>
              </header>
            )}
            {viewPrefs && (
              <ViewPrefsContext.Provider value={viewPrefs}>
                <LegacyPanelsContext.Provider value={legacy}>
                  <LinkOpenerContext.Provider value={linkOpener}>
                    <LayoutHost ref={layoutRef} panels={panels} store={uiStore} base={panelBase} onSelect={selectFromPanel} config={layoutConfig} />
                  </LinkOpenerContext.Provider>
                </LegacyPanelsContext.Provider>
              </ViewPrefsContext.Provider>
            )}
          </div>
          {view === "todo" && (
            <div className="kp-view kp-row">
              <TodoPanel client={client} projects={projects} className="kp-half" />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
