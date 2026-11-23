// İş A — rail parts: per-project running/waiting counter, the "Seni bekleyen" list and its badge (collapsed rail).
import type { BgAgentSession, TerminalInfo } from "@kokpit/shared";
import { useEffect, useId, useRef } from "react";
import { t, useT } from "../../i18n/index.ts";
import { relativeTime, type AgentCount } from "./agents.ts";
import { bgReasonLabel } from "./bg-agents.ts";

export interface WaitingAgent {
  terminal: TerminalInfo;
  /** Tool name or terminal title. */
  label: string;
  projectName: string;
  cardName?: string;
}

/** İş A (Adım 7): a background session waiting for the user. */
export interface WaitingBgAgent {
  session: BgAgentSession;
  /** Project name, or "Diğer". */
  projectName: string;
  cardName?: string;
}

/** Limits of the collapsed rail's badge. */
export const WAITING_LIMITS = {
  /** Sessions listed in the badge's tooltip before "… ve N oturum daha". */
  tooltipMax: 8,
  /** The largest number the badge shows; beyond it "<max>+" (the badge's name still says the real count). */
  badgeMax: 99,
};

/** The badge's accessible name and the first line of its tooltip. */
export const waitingBadgeLabel = (count: number): string => t("agents.rail.waitingBadge", { count });
const moreWaiting = (count: number): string => t("agents.rail.moreWaiting", { count });

const place = (a: { projectName: string; cardName?: string }): string => `${a.projectName}${a.cardName ? ` › ${a.cardName}` : ""}`;
const bgPlace = (a: WaitingBgAgent): string =>
  `${place(a)}${a.session.waitingReason ? ` · ${bgReasonLabel(a.session.waitingReason)}` : ""}`;
/** A row's whole text — its tooltip, and its line in the badge's tooltip. The row itself cuts long names. */
const fullText = (name: string, where: string): string => `${name} — ${where}`;

export function AgentCounter({ projectName, count }: { projectName: string; count: AgentCount | undefined }) {
  const translate = useT();
  const c = count ?? { running: 0, waiting: 0 };
  if (c.running === 0 && c.waiting === 0) return null;
  const label = translate("agents.rail.counter", { project: projectName, running: c.running, waiting: c.waiting });
  return (
    <span className="kp-agent-count" role="img" aria-label={label} title={label}>
      {c.running > 0 && <span className="kp-agent-count__n kp-agent-count__n--running">{c.running}</span>}
      {c.waiting > 0 && <span className="kp-agent-count__n kp-agent-count__n--waiting">{c.waiting}</span>}
    </span>
  );
}

/**
 * "Seni bekleyen" of the collapsed rail: only the number of waiting sessions, inside the strip. The sessions are in
 * its tooltip; a click opens the list. Nothing is shown when nothing waits.
 */
export function WaitingBadge({
  agents,
  background = [],
  onOpen,
}: {
  agents: readonly WaitingAgent[];
  background?: readonly WaitingBgAgent[];
  onOpen(): void;
}) {
  useT(); // re-render on a language switch: the texts below come from module-level helpers
  const count = agents.length + background.length;
  if (count === 0) return null;
  const label = waitingBadgeLabel(count);
  const lines = [...agents.map((a) => fullText(a.label, place(a))), ...background.map((a) => fullText(a.session.name, bgPlace(a)))];
  const shown = lines.slice(0, WAITING_LIMITS.tooltipMax);
  const rest = lines.length - shown.length;
  const tooltip = [label, ...shown, ...(rest > 0 ? [moreWaiting(rest)] : [])].join("\n");
  return (
    <button type="button" className="kp-rail__waiting" aria-label={label} title={tooltip} onClick={onOpen}>
      {count > WAITING_LIMITS.badgeMax ? `${WAITING_LIMITS.badgeMax}+` : count}
    </button>
  );
}

export function WaitingAgents({
  agents,
  background = [],
  now,
  onSelect,
  onSelectBackground,
  focusFirst = false,
}: {
  agents: readonly WaitingAgent[];
  /** İş A (Adım 7): waiting background sessions, listed after the terminals. */
  background?: readonly WaitingBgAgent[];
  now: number;
  onSelect(terminal: TerminalInfo): void;
  onSelectBackground?(session: BgAgentSession): void;
  /** The list was opened from the collapsed rail's badge: its first session takes the focus. */
  focusFirst?: boolean;
}) {
  const translate = useT();
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  // When the list is opened that way — not when a session arrives later.
  useEffect(() => {
    if (focusFirst) sectionRef.current?.querySelector("button")?.focus();
  }, [focusFirst]);
  if (agents.length === 0 && background.length === 0) return null;
  return (
    <section ref={sectionRef} className="kp-waiting" aria-labelledby={headingId}>
      <h2 id={headingId} className="kp-rail__section kp-waiting__title">
        {translate("agents.rail.waitingTitle")}
      </h2>
      <ul className="kp-waiting__list">
        {agents.map((a) => (
          <li key={a.terminal.id}>
            <button type="button" className="kp-waiting__item" title={fullText(a.label, place(a))} onClick={() => onSelect(a.terminal)}>
              <span className="kp-waiting__name">{a.label}</span>
              <span className="kp-waiting__where">{place(a)}</span>
              {a.terminal.activity && (
                <span className="kp-waiting__time">{relativeTime(a.terminal.activity.since, now)}</span>
              )}
            </button>
          </li>
        ))}
        {background.map((a) => (
          <li key={`bg:${a.session.id}`}>
            <button
              type="button"
              className="kp-waiting__item"
              data-bg-agent-id={a.session.id}
              title={fullText(a.session.name, bgPlace(a))}
              onClick={() => onSelectBackground?.(a.session)}
            >
              <span className="kp-waiting__name">{a.session.name}</span>
              <span className="kp-waiting__where">{bgPlace(a)}</span>
              {a.session.startedAt && <span className="kp-waiting__time">{relativeTime(a.session.startedAt, now)}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
