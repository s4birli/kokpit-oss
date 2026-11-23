// İş C (Adım 8) — Claude paneli: the skills, agents and slash commands Claude Code sees for the selected project
// (its `.claude/` and its account's config dir, plugin skills included), with a read-only preview, plus Rehber: the
// shipped guide to Claude Code's slash commands, CLI flags and subcommands, and the project's own commands.
// Hidden by default; the Yardım menu's `claude.help` opens it on Rehber via `revealClaudeHelp`.
// Kullanım: what each Claude account used (ClaudeUsage.tsx) — read only while that tab is open.
import type { Card, ClaudeInventoryItem, ClaudeInventoryResult, ClaudeItemKind, ClaudeItemSource, Project } from "@kokpit/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { intlLocale, t as translate, useLocale, useT, type MessageKey } from "../../../i18n/index.ts";
import type { EngineClient } from "../../engine/types.ts";
import type { UiConfig } from "../config.ts";
import { errorMessage, isDisconnected } from "../errors.ts";
import { useEngineResource } from "../hooks/useEngineResource.ts";
import type { PanelContext, PanelDefinition, PanelId, PanelStateStore, RevealArgs } from "../layout/contract.ts";
import { PanelTitle } from "../PanelTitle.tsx";
import { ClaudeUsageList } from "../ClaudeUsage.tsx";
import { claudeGuide, filterGuide, matches } from "./claude-guide.ts";
import { FilePreview, type Preview } from "./FilesPanel.tsx";
import "./claude.css";
import { copyValue } from "../copy-menu.ts";

/** The tab a `claude.help` menu command opens. */
export const CLAUDE_HELP_TAB = "rehber";
/** The menu command id (İş: native menus) that opens the panel on Rehber. */
export const CLAUDE_HELP_COMMAND = "claude.help";

/** Claude kullanımı: the accounts' usage. */
export const CLAUDE_USAGE_TAB = "kullanim";

type Tab = ClaudeItemKind | typeof CLAUDE_USAGE_TAB | typeof CLAUDE_HELP_TAB;
/** A tab that lists inventory items (with a count, the search box and the CLAUDE.md line). */
const isKind = (t: Tab): t is ClaudeItemKind => t !== CLAUDE_HELP_TAB && t !== CLAUDE_USAGE_TAB;

const TABS: readonly { id: Tab; label: MessageKey }[] = [
  { id: "skill", label: "claude.panel.tabs.skill" },
  { id: "agent", label: "claude.panel.tabs.agent" },
  { id: "command", label: "claude.panel.tabs.command" },
  { id: CLAUDE_USAGE_TAB, label: "claude.panel.tabs.usage" },
  { id: CLAUDE_HELP_TAB, label: "claude.panel.tabs.guide" },
];
const BADGE: Record<ClaudeItemSource, MessageKey> = { project: "claude.panel.badge.project", user: "claude.panel.badge.user", plugin: "claude.panel.badge.plugin" };
const TAB_KEY = "tab";

const isTab = (v: unknown): v is Tab => TABS.some((t) => t.id === v);
const shownName = (i: ClaudeInventoryItem): string => (i.kind === "command" ? `/${i.name}` : i.name);

/** Opens the Claude panel on Rehber (for the Yardım menu's `claude.help`). */
export function revealClaudeHelp(host: { reveal(panel: PanelId, args?: RevealArgs): void }): void {
  host.reveal("claude", { tab: CLAUDE_HELP_TAB });
}

export interface ClaudePanelProps {
  client: EngineClient;
  config: UiConfig;
  project: Project | null;
  card: Card | null;
  state: PanelStateStore;
  focus?: PanelContext["focus"];
}

export function ClaudePanel({ client, project, card, state, focus }: ClaudePanelProps) {
  const t = useT();
  const titleId = useId();
  const previewId = useId();
  const target = useMemo(() => (card ? { cardId: card.id } : project ? { projectId: project.id } : null), [card, project]);

  const [tab, setTabState] = useState<Tab>(() => {
    const saved = state.get<unknown>(TAB_KEY);
    return isTab(saved) ? saved : "skill";
  });
  const setTab = useCallback(
    (next: Tab) => {
      setTabState(next);
      state.set(TAB_KEY, next);
    },
    [state],
  );

  // A reveal request (new `seq`) with a tab switches to it once.
  const seenSeq = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || focus.seq === seenSeq.current) return;
    seenSeq.current = focus.seq;
    if (isTab(focus.tab)) setTab(focus.tab);
  }, [focus, setTab]);

  const [query, setQuery] = useState("");

  const fetchInventory = useCallback(
    async (c: EngineClient): Promise<ClaudeInventoryResult | null> => (target ? c.request("claude.inventory", target) : null),
    [target],
  );
  const inventory = useEngineResource(client, fetchInventory, []);
  const data = inventory.data ?? null;

  const [selected, setSelected] = useState<ClaudeInventoryItem | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const live = useRef<{ selected: string | null; alive: boolean }>({ selected: null, alive: true });
  useEffect(() => {
    live.current.alive = true;
    return () => {
      live.current.alive = false;
    };
  }, []);

  const open = async (it: ClaudeInventoryItem): Promise<void> => {
    if (!target) return;
    setSelected(it);
    live.current.selected = it.id;
    setPreview({ status: "loading" });
    try {
      const result = await client.request("claude.inventory.read", { ...target, id: it.id });
      if (!live.current.alive || live.current.selected !== it.id) return;
      setPreview({ status: "ok", result });
    } catch (err) {
      if (!live.current.alive || isDisconnected(err) || live.current.selected !== it.id) return;
      setPreview({ status: "error", message: errorMessage(err) });
    }
  };

  const items = data?.items ?? [];
  const counts = useMemo(() => {
    const c: Record<ClaudeItemKind, number> = { skill: 0, agent: 0, command: 0 };
    for (const i of items) c[i.kind] += 1;
    return c;
  }, [items]);
  const visible = useMemo(
    () => (isKind(tab) ? items.filter((i) => i.kind === tab && matches([shownName(i), i.description], query)) : []),
    [items, tab, query],
  );

  let body: ReactElement;
  if (tab === CLAUDE_HELP_TAB) {
    body = <Guide query={query} commands={items.filter((i) => i.kind === "command")} />;
  } else if (tab === CLAUDE_USAGE_TAB) {
    body = (
      <ClaudeUsageList
        client={client}
        firstAccountId={project?.claudeAccountId}
        firstDefault={project !== null && project.claudeAccountId === undefined}
      />
    );
  } else if (!project) {
    body = <p className="kp-placeholder__body">{t("claude.panel.noProject")}</p>;
  } else if (inventory.error && !data) {
    body = (
      <p role="alert" className="kp-error kp-claude__alert">
        {inventory.error}
      </p>
    );
  } else if (!data) {
    body = <p className="kp-claude__hint">{t("claude.panel.loading")}</p>;
  } else {
    body = (
      <div className="kp-claude__body">
        <div className="kp-claude__side">
          {visible.length === 0 ? (
            <p className="kp-claude__hint">{counts[tab] === 0 ? t("claude.panel.emptyTab") : t("claude.panel.noMatch")}</p>
          ) : (
            <ul className="kp-claude__list" aria-label={t("claude.panel.items")}>
              {visible.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className="kp-claude__item"
                    aria-current={selected?.id === i.id ? true : undefined}
                    title={i.path}
                    {...copyValue(i.path)}
                    onClick={() => void open(i)}
                  >
                    <span className="kp-claude__row">
                      <span className="kp-claude__name">{shownName(i)}</span>
                      <span className={`kp-claude__badge kp-claude__badge--${i.source}`}>{t(BADGE[i.source])}</span>
                    </span>
                    {i.description !== undefined && <span className="kp-claude__desc">{i.description}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <section className="kp-files__preview kp-claude__preview" aria-labelledby={previewId}>
          <h4 id={previewId} className="kp-files__preview-title">
            {t("claude.panel.preview")}
          </h4>
          <FilePreview path={selected?.path ?? null} preview={selected ? preview : null} locale={intlLocale()} />
        </section>
      </div>
    );
  }

  const notes: string[] = [];
  if (data?.note) notes.push(data.note);
  if (data?.truncated) notes.push(t("claude.panel.truncated", { count: items.length }));

  return (
    <section className="kp-panel kp-claude" aria-labelledby={titleId}>
      <PanelTitle id={titleId}>Claude</PanelTitle>
      <div className="kp-claude__bar">
        <div role="tablist" aria-label={t("claude.panel.tablist")} className="kp-claude__tabs">
          {TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              type="button"
              role="tab"
              aria-selected={tab === tabDef.id}
              className="kp-claude__tab"
              onClick={() => setTab(tabDef.id)}
            >
              {t(tabDef.label)}
              {isKind(tabDef.id) && data && <span className="kp-claude__count"> {counts[tabDef.id]}</span>}
            </button>
          ))}
        </div>
        {tab !== CLAUDE_USAGE_TAB && (
          <input
            type="search"
            className="kp-claude__search"
            aria-label={t("claude.panel.search")}
            placeholder={t("claude.panel.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {project && tab !== CLAUDE_USAGE_TAB && (
          <button type="button" className="kp-btn kp-btn--quiet kp-btn--icon" aria-label={t("claude.panel.reload")} title={t("claude.panel.reload")} onClick={() => void inventory.reload()}>
            ↻
          </button>
        )}
      </div>
      {notes.map((n) => (
        <p key={n} className="kp-claude__note">
          {n}
        </p>
      ))}
      {data && isKind(tab) && (
        <p className="kp-claude__meta">
          {t("claude.panel.claudeMd", {
            parts: [
              ...(data.claudeMd.project !== undefined ? [t("claude.panel.claudeMdProject", { value: t(data.claudeMd.project ? "claude.panel.present" : "claude.panel.absent") })] : []),
              t("claude.panel.claudeMdUser", { value: t(data.claudeMd.user ? "claude.panel.present" : "claude.panel.absent") }),
            ].join(", "),
          })}
        </p>
      )}
      {body}
    </section>
  );
}

function Guide({ query, commands }: { query: string; commands: ClaudeInventoryItem[] }) {
  const t = useT();
  const guide = claudeGuide(useLocale());
  const sections = filterGuide(guide, query);
  const own = commands.filter((i) => matches([shownName(i), i.description], query));
  return (
    <div className="kp-claude__guide">
      <p className="kp-claude__hint">
        {t("claude.guide.builtFrom", { version: guide.cliVersion, source: guide.source })}
      </p>
      {own.length > 0 && (
        <GuideBlock title={t("claude.guide.own")}>
          {own.map((i) => (
            <GuideRow key={i.id} name={shownName(i)} description={i.description} badge={t(BADGE[i.source])} />
          ))}
        </GuideBlock>
      )}
      {sections.map((s) => (
        <GuideBlock key={s.id} title={s.title}>
          {s.entries.map((e) => (
            <GuideRow key={e.name} name={e.name} description={e.description} />
          ))}
        </GuideBlock>
      ))}
      {sections.length === 0 && own.length === 0 && <p className="kp-claude__hint">{t("claude.guide.noMatch")}</p>}
    </div>
  );
}

function GuideBlock({ title, children }: { title: string; children: ReactElement[] }) {
  const id = useId();
  return (
    <section className="kp-claude__section" aria-labelledby={id}>
      <h4 id={id} className="kp-claude__section-title">
        {title}
      </h4>
      <dl className="kp-claude__dl">{children}</dl>
    </section>
  );
}

function GuideRow({ name, description, badge }: { name: string; description: string | undefined; badge?: string }) {
  return (
    <div className="kp-claude__entry">
      <dt>
        <code>{name}</code>
        {badge && <span className="kp-claude__badge">{badge}</span>}
      </dt>
      <dd>{description ?? "—"}</dd>
    </div>
  );
}

/** Registry entry (İş L): `claudePanel,` in layout/registry.ts. */
export const claudePanel: PanelDefinition = {
  id: "claude",
  get title() {
    return translate("claude.panel.title");
  },
  available: () => true,
  render: (ctx) => (
    <ClaudePanel
      key={ctx.card ? `c:${ctx.card.id}` : `p:${ctx.project?.id ?? ""}`}
      client={ctx.client}
      config={ctx.config}
      project={ctx.project}
      card={ctx.card}
      state={ctx.state}
      focus={ctx.focus ?? null}
    />
  ),
};
