// İş A — Ajanlar: the project's terminals with their live state; a click goes to that terminal.
// Adım 7: with `background`, two sections: "Terminaller" and "Arka plan ajanları" (BgAgentsSection).
import type { AgentState, Card, TerminalInfo, Tool } from "@kokpit/shared";
import { useId } from "react";
import { useT } from "../../i18n/index.ts";
import { AGENT_STATE_KEY, agentLabel, relativeTime } from "./agents.ts";
import { BgAgentsSection, type BgAgentsSectionProps } from "./BgAgentsSection.tsx";
import { PanelTitle } from "./PanelTitle.tsx";
import "./agents.css";
import { copyValue } from "./copy-menu.ts";

export interface AgentsPanelProps {
  /** This project's terminals (card terminals included). */
  terminals: readonly TerminalInfo[];
  cards: readonly Card[];
  tools: readonly Tool[];
  /** Current time for relative times (ticks). */
  now: number;
  error?: string | null;
  className?: string;
  /** Shown when there are no terminals. */
  emptyText: string;
  onSelect(terminal: TerminalInfo): void;
  /** İş A (Adım 7): Claude Code background sessions; absent = terminals only (no section headings). */
  background?: BgAgentsSectionProps;
}

export function AgentStateChip({ state }: { state: AgentState }) {
  const translate = useT();
  return <span className={`kp-agent-chip kp-agent-chip--${state}`}>{translate(AGENT_STATE_KEY[state])}</span>;
}

export function AgentsPanel({ terminals, cards, tools, now, error, className, emptyText, onSelect, background }: AgentsPanelProps) {
  const translate = useT();
  const titleId = useId();
  const terminalsId = useId();
  return (
    <section className={`kp-panel kp-agents${className ? ` ${className}` : ""}`} aria-labelledby={titleId}>
      <PanelTitle id={titleId}>{translate("agents.panel.title")}</PanelTitle>
      {error && (
        <p role="alert" className="kp-error">
          {error}
        </p>
      )}
      {background && (
        <h4 id={terminalsId} className="kp-agents__section">
          {translate("agents.panel.terminals")}
        </h4>
      )}
      {terminals.length === 0 ? (
        <p className="kp-agents__empty">{emptyText}</p>
      ) : (
        <ul className="kp-agents__list" aria-labelledby={background ? terminalsId : undefined}>
          {terminals.map((t) => {
            const state: AgentState = t.activity?.state ?? (t.status === "exited" ? "exited" : "idle");
            const card = t.cardId === undefined ? undefined : cards.find((c) => c.id === t.cardId);
            return (
              <li key={t.id}>
                <button type="button" className="kp-agent" {...copyValue(t.title)} onClick={() => onSelect(t)}>
                  <span className="kp-agent__top">
                    <span className="kp-agent__name">{agentLabel(t, tools)}</span>
                    {card && <span className="kp-agent__card">{card.name}</span>}
                    <AgentStateChip state={state} />
                    {t.activity && <span className="kp-agent__time">{relativeTime(t.activity.since, now)}</span>}
                  </span>
                  {t.activity?.summary && <span className="kp-agent__summary">{t.activity.summary}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {background && <BgAgentsSection {...background} />}
    </section>
  );
}
