import type { BgAgentSession, Card, Project, TerminalInfo } from "@kokpit/shared";
import { useEffect, useId, useState, type FormEvent } from "react";
import type { AgentCount } from "./agents.ts";
import { errorMessage } from "./errors.ts";
import { supportsCards } from "./projects.ts";
import { AgentCounter, WaitingAgents, WaitingBadge, type WaitingAgent, type WaitingBgAgent } from "./RailAgents.tsx";
import { t, useT, type MessageKey } from "../../i18n/index.ts";

export type WorkbenchView = "work" | "todo";

export interface RailProps {
  projects: Project[];
  cardsByProject: Readonly<Record<string, Card[]>>;
  error: string | null;
  cardErrors: Readonly<Record<string, string>>;
  selectedCardId: string | null;
  selectedProjectId: string | null;
  onSelectCard(cardId: string): void;
  onSelectProject(projectId: string): void;
  /** Creates a card; rejects with the engine error. */
  onCreateCard(projectId: string, name: string): Promise<void>;
  view: WorkbenchView;
  onViewChange(view: WorkbenchView): void;
  onOpenSettings(): void;
  // ---- İş A: ajan özeti ----
  agentCounts?: Readonly<Record<string, AgentCount>>;
  waitingAgents?: readonly WaitingAgent[];
  /** Current time for relative times. */
  now?: number;
  onSelectAgent?(terminal: TerminalInfo): void;
  /** İş A (Adım 7): waiting background sessions in "Seni bekleyen". */
  waitingBgAgents?: readonly WaitingBgAgent[];
  onSelectBgAgent?(session: BgAgentSession): void;
  /** İş P: the rail is collapsed to a strip: its expand button and the number of waiting sessions. */
  collapsed?: boolean;
  onToggleCollapsed?(): void;
}

/** İş P: labels of the collapse toggle. */
export const RAIL_TEXT = {
  get collapse() {
    return t("workbench.rail.collapse");
  },
  get expand() {
    return t("workbench.rail.expand");
  },
};

const VIEWS: Array<{ id: WorkbenchView; label: MessageKey }> = [
  { id: "work", label: "workbench.rail.viewWork" },
  { id: "todo", label: "workbench.rail.viewTodoOnly" },
];

export function Rail(props: RailProps) {
  const t = useT();
  const { projects, cardsByProject, error, cardErrors, selectedCardId, onSelectCard, view, onViewChange } = props;
  const { selectedProjectId, onSelectProject } = props;
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const projectsHeadingId = useId();

  /**
   * The list was opened from the collapsed strip's badge, to answer a waiting session: choosing one gives the strip
   * back. Any other use of the rail (a project, a card, « ») means the user wants it open.
   */
  const [peeking, setPeeking] = useState(false);
  const { onSelectAgent, onSelectBgAgent, onToggleCollapsed } = props;
  const waitingCount = (props.waitingAgents?.length ?? 0) + (props.waitingBgAgents?.length ?? 0);
  // Nothing left to answer: the open list is no longer "just to answer one", so a later session does not close it.
  useEffect(() => {
    if (waitingCount === 0) setPeeking(false);
  }, [waitingCount]);
  const toggleByHand = (): void => {
    setPeeking(false);
    onToggleCollapsed?.();
  };
  const afterWaitingChosen = (): void => {
    if (!peeking) return;
    setPeeking(false);
    onToggleCollapsed?.();
  };

  if (props.collapsed && onToggleCollapsed) {
    return (
      <nav className="kp-rail kp-rail--collapsed" aria-label="Kokpit">
        <button
          type="button"
          className="kp-btn kp-btn--quiet kp-rail__collapse"
          aria-expanded={false}
          aria-label={RAIL_TEXT.expand}
          title={RAIL_TEXT.expand}
          onClick={toggleByHand}
        >
          »
        </button>
        {/* "Seni bekleyen" is only a number here: the strip stays a strip. */}
        {onSelectAgent && (
          <WaitingBadge
            agents={props.waitingAgents ?? []}
            {...(props.waitingBgAgents ? { background: props.waitingBgAgents } : {})}
            onOpen={() => {
              setPeeking(true);
              onToggleCollapsed();
            }}
          />
        )}
      </nav>
    );
  }

  const waiting = onSelectAgent && (
    <WaitingAgents
      agents={props.waitingAgents ?? []}
      {...(props.waitingBgAgents ? { background: props.waitingBgAgents } : {})}
      now={props.now ?? Date.now()}
      focusFirst={peeking}
      onSelect={(terminal) => {
        onSelectAgent(terminal);
        afterWaitingChosen();
      }}
      {...(onSelectBgAgent
        ? {
            onSelectBackground: (session: BgAgentSession) => {
              onSelectBgAgent(session);
              afterWaitingChosen();
            },
          }
        : {})}
    />
  );

  return (
    <nav className="kp-rail" aria-label="Kokpit">
      <div className="kp-rail__top">
        {props.onToggleCollapsed && (
          <button
            type="button"
            className="kp-btn kp-btn--quiet kp-rail__collapse"
            aria-expanded={true}
            aria-label={RAIL_TEXT.collapse}
            title={RAIL_TEXT.collapse}
            onClick={toggleByHand}
          >
            «
          </button>
        )}
        <h1 className="kp-rail__title">Kokpit</h1>
        <button type="button" className="kp-btn" onClick={props.onOpenSettings}>
          {t("workbench.rail.settings")}
        </button>
      </div>

      <div className="kp-switch" role="group" aria-label={t("workbench.rail.view")}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className="kp-switch__btn"
            aria-pressed={view === v.id}
            onClick={() => onViewChange(v.id)}
          >
            {t(v.label)}
          </button>
        ))}
      </div>

      {waiting}

      <h2 id={projectsHeadingId} className="kp-rail__section">
        {t("workbench.rail.projects")}
      </h2>
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
      <div aria-labelledby={projectsHeadingId}>
        {projects.map((project) => (
          <ProjectBlock
            key={project.id}
            project={project}
            cards={cardsByProject[project.id] ?? []}
            error={cardErrors[project.id] ?? null}
            selectedCardId={selectedCardId}
            selected={selectedProjectId === project.id}
            onSelectCard={(cardId) => {
              setPeeking(false);
              onSelectCard(cardId);
            }}
            onSelectProject={() => {
              setPeeking(false);
              onSelectProject(project.id);
            }}
            creating={creatingFor === project.id}
            onStartCreate={() => setCreatingFor(project.id)}
            onEndCreate={() => setCreatingFor(null)}
            onCreateCard={props.onCreateCard}
            agentCount={props.agentCounts?.[project.id]}
          />
        ))}
      </div>
    </nav>
  );
}

interface ProjectBlockProps {
  project: Project;
  cards: Card[];
  error: string | null;
  selectedCardId: string | null;
  /** The project itself (not one of its cards) is selected. */
  selected: boolean;
  onSelectCard(cardId: string): void;
  onSelectProject(): void;
  creating: boolean;
  onStartCreate(): void;
  onEndCreate(): void;
  onCreateCard(projectId: string, name: string): Promise<void>;
  agentCount?: AgentCount | undefined;
}

function ProjectBlock(p: ProjectBlockProps) {
  const t = useT();
  const nameId = useId();
  const cards = supportsCards(p.project);
  return (
    <div role="group" aria-labelledby={nameId} className="kp-project">
      <div className="kp-project__row">
        <button
          type="button"
          id={nameId}
          className={p.selected ? "kp-project__name kp-project__name--selected" : "kp-project__name"}
          aria-current={p.selected ? "true" : undefined}
          onClick={p.onSelectProject}
        >
          {p.project.name}
        </button>
        <AgentCounter projectName={p.project.name} count={p.agentCount} />
        {cards && !p.creating && (
          <button
            type="button"
            className="kp-btn kp-btn--quiet"
            aria-label={t("workbench.rail.newCardFor", { project: p.project.name })}
            onClick={p.onStartCreate}
          >
            {t("workbench.rail.newCard")}
          </button>
        )}
      </div>
      {p.error && (
        <p role="alert" className="kp-error">
          {p.error}
        </p>
      )}
      {cards && p.creating && (
        <NewCardForm
          onCancel={p.onEndCreate}
          onCreate={async (name) => {
            await p.onCreateCard(p.project.id, name);
            p.onEndCreate();
          }}
        />
      )}
      {cards && (
        <ul className="kp-cards">
          {p.cards.map((card) => {
            const selected = card.id === p.selectedCardId;
            return (
              <li key={card.id}>
                <button
                  type="button"
                  className={selected ? "kp-card kp-card--selected" : "kp-card"}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => p.onSelectCard(card.id)}
                >
                  {card.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NewCardForm({ onCreate, onCancel }: { onCreate(name: string): Promise<void>; onCancel(): void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed);
    } catch (err) {
      setError(t("workbench.rail.createFailed", { error: errorMessage(err) }));
      setBusy(false);
    }
  };

  return (
    <form className="kp-form" onSubmit={(e) => void submit(e)}>
      <label className="kp-field">
        <span className="kp-field__label">{t("workbench.rail.cardName")}</span>
        <input
          className="kp-input"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
        />
      </label>
      <div className="kp-form__actions">
        <button type="submit" className="kp-btn kp-btn--primary" disabled={!trimmed || busy}>
          {t("workbench.rail.create")}
        </button>
        <button type="button" className="kp-btn" disabled={busy} onClick={onCancel}>
          {t("workbench.common.cancel")}
        </button>
      </div>
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
    </form>
  );
}
