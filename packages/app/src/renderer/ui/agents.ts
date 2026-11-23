// İş A — ajan özeti: pure helpers for the Ajanlar panel and the rail.
import type { AgentState, TerminalInfo, Tool } from "@kokpit/shared";
import { t, type MessageKey } from "../../i18n/index.ts";

export const AGENT_STATE_KEY: Record<AgentState, MessageKey> = {
  running: "agents.state.running",
  waiting: "agents.state.waiting",
  idle: "agents.state.idle",
  exited: "agents.state.exited",
};

/** The state in the current language (çalışıyor / seni bekliyor / boşta / kapandı). */
export const agentStateLabel = (state: AgentState): string => t(AGENT_STATE_KEY[state]);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Below this, "az önce". */
const JUST_NOW = 5 * SECOND;

/** "az önce", "42 sn önce", "5 dk önce", "3 sa önce", "2 gün önce"; "" for an unreadable time. */
export function relativeTime(since: string, now: number): string {
  const at = Date.parse(since);
  if (Number.isNaN(at)) return "";
  const d = Math.max(0, now - at);
  if (d < JUST_NOW) return t("agents.time.justNow");
  if (d < MINUTE) return t("agents.time.seconds", { count: Math.floor(d / SECOND) });
  if (d < HOUR) return t("agents.time.minutes", { count: Math.floor(d / MINUTE) });
  if (d < DAY) return t("agents.time.hours", { count: Math.floor(d / HOUR) });
  return t("agents.time.days", { count: Math.floor(d / DAY) });
}

/** The tool's name when the terminal runs one, else the terminal title. */
export function agentLabel(t: TerminalInfo, tools: readonly Tool[]): string {
  const tool = t.toolId === undefined ? undefined : tools.find((x) => x.id === t.toolId);
  return tool?.name ?? t.title;
}

export interface AgentCount {
  running: number;
  waiting: number;
}

export function agentCounts(terminals: readonly TerminalInfo[]): Record<string, AgentCount> {
  const out: Record<string, AgentCount> = {};
  for (const t of terminals) {
    const c = (out[t.projectId] ??= { running: 0, waiting: 0 });
    if (t.activity?.state === "running") c.running++;
    else if (t.activity?.state === "waiting") c.waiting++;
  }
  return out;
}

/** Waiting terminals, the one waiting longest first. */
export function waitingAgents(terminals: readonly TerminalInfo[]): TerminalInfo[] {
  return terminals
    .filter((t) => t.activity?.state === "waiting")
    .sort((a, b) => Date.parse(a.activity!.since) - Date.parse(b.activity!.since));
}
