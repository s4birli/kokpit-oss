// İş A (Adım 7) — arka plan ajanları: pure helpers for the Ajanlar panel and the rail.
import type { BgAgentSession, BgAgentState, BgAgentWaitingReason } from "@kokpit/shared";
import { t, type MessageKey, type Translate } from "../../i18n/index.ts";
import type { AgentCount } from "./agents.ts";

export const BG_REASON_KEY: Record<BgAgentWaitingReason, MessageKey> = {
  approval: "agents.bg.reason.approval",
  input: "agents.bg.reason.input",
};

/** Why a session waits, in the current language. */
export const bgReasonLabel = (reason: BgAgentWaitingReason): string => t(BG_REASON_KEY[reason]);

const GROUPS: ReadonlyArray<{ key: BgAgentState; title: MessageKey }> = [
  { key: "waiting", title: "agents.bg.group.waiting" },
  { key: "running", title: "agents.bg.group.running" },
  { key: "done", title: "agents.bg.group.done" },
];

export interface BgAgentGroup {
  key: BgAgentState;
  title: string;
  sessions: BgAgentSession[];
}

/** Start time in ms; sessions without one sort as the oldest. */
const startMs = (s: BgAgentSession): number => {
  const t = s.startedAt === undefined ? Number.NaN : Date.parse(s.startedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/** Seni bekliyor / Çalışıyor / Bitti, each newest first. Every group is present (possibly empty). */
export function groupBgAgents(sessions: readonly BgAgentSession[], translate: Translate = t): BgAgentGroup[] {
  return GROUPS.map((g) => ({
    key: g.key,
    title: translate(g.title),
    sessions: sessions.filter((s) => s.state === g.key).sort((a, b) => startMs(b) - startMs(a)),
  }));
}

/** Running / waiting background sessions per matched project. */
export function bgAgentCounts(sessions: readonly BgAgentSession[]): Record<string, AgentCount> {
  const out: Record<string, AgentCount> = {};
  for (const s of sessions) {
    if (s.projectId === undefined || s.state === "done") continue;
    const c = (out[s.projectId] ??= { running: 0, waiting: 0 });
    c[s.state]++;
  }
  return out;
}

export function mergeCounts(...all: ReadonlyArray<Readonly<Record<string, AgentCount>>>): Record<string, AgentCount> {
  const out: Record<string, AgentCount> = {};
  for (const counts of all) {
    for (const [id, c] of Object.entries(counts)) {
      const o = (out[id] ??= { running: 0, waiting: 0 });
      o.running += c.running;
      o.waiting += c.waiting;
    }
  }
  return out;
}

/** Waiting sessions, the one waiting longest (started earliest) first; unknown start times last. */
export function waitingBgAgents(sessions: readonly BgAgentSession[]): BgAgentSession[] {
  const t = (s: BgAgentSession) => (startMs(s) === Number.NEGATIVE_INFINITY ? Number.POSITIVE_INFINITY : startMs(s));
  return sessions.filter((s) => s.state === "waiting").sort((a, b) => t(a) - t(b));
}
