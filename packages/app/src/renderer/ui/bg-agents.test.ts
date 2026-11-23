import type { BgAgentSession } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import { bgAgentCounts, bgReasonLabel, groupBgAgents, mergeCounts, waitingBgAgents } from "./bg-agents.ts";

const iso = (min: number) => new Date(Date.parse("2026-11-16T10:00:00.000Z") - min * 60_000).toISOString();
const s = (id: string, state: BgAgentSession["state"], extra: Partial<BgAgentSession> = {}): BgAgentSession => ({
  id,
  name: id,
  state,
  cwd: "/x",
  ...(state === "waiting" ? { waitingReason: "approval" as const } : {}),
  ...extra,
});

describe("background agent helpers", () => {
  it("labels waiting reasons in Turkish", () => {
    expect(Object.fromEntries((["approval", "input"] as const).map((r) => [r, bgReasonLabel(r)]))).toEqual({ approval: "onay bekliyor", input: "sıra sende" });
  });

  it("groups by state, newest first, done last", () => {
    const g = groupBgAgents([
      s("d1", "done", { startedAt: iso(5) }),
      s("w1", "waiting", { startedAt: iso(30) }),
      s("r1", "running", { startedAt: iso(1) }),
      s("w2", "waiting", { startedAt: iso(2), waitingReason: "input" }),
      s("r2", "running"),
    ]);
    expect(g.map((x) => [x.key, x.title, x.sessions.map((y) => y.id)])).toEqual([
      ["waiting", "Seni bekliyor", ["w2", "w1"]],
      ["running", "Çalışıyor", ["r1", "r2"]],
      ["done", "Bitti", ["d1"]],
    ]);
  });

  it("counts running and waiting per project; unmatched sessions are not counted", () => {
    const counts = bgAgentCounts([
      s("a", "running", { projectId: "p1" }),
      s("b", "waiting", { projectId: "p1", cardId: "k" }),
      s("c", "done", { projectId: "p1" }),
      s("d", "waiting", { projectId: "p2" }),
      s("e", "running"),
    ]);
    expect(counts).toEqual({ p1: { running: 1, waiting: 1 }, p2: { running: 0, waiting: 1 } });
    expect(mergeCounts({ p1: { running: 2, waiting: 0 }, p3: { running: 1, waiting: 1 } }, counts)).toEqual({
      p1: { running: 3, waiting: 1 },
      p2: { running: 0, waiting: 1 },
      p3: { running: 1, waiting: 1 },
    });
  });

  it("waiting list: the longest waiting first; sessions without a time last", () => {
    const w = waitingBgAgents([s("a", "waiting", { startedAt: iso(1) }), s("b", "running"), s("c", "waiting"), s("d", "waiting", { startedAt: iso(9) })]);
    expect(w.map((x) => x.id)).toEqual(["d", "a", "c"]);
  });
});
