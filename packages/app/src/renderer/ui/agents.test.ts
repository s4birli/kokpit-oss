import type { TerminalInfo } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import { agentCounts, agentLabel, agentStateLabel, relativeTime, waitingAgents } from "./agents.ts";
import { makeTool } from "./test-utils/fake-client.ts";

const T0 = Date.parse("2026-11-16T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function term(id: string, projectId: string, state?: "running" | "waiting" | "idle" | "exited", extra: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    projectId,
    title: id,
    status: state === "exited" ? "exited" : "running",
    createdAt: iso(T0),
    ...(state ? { activity: { state, since: iso(T0) } } : {}),
    ...extra,
  };
}

describe("agent helpers", () => {
  it("labels every state in Turkish", () => {
    expect(Object.fromEntries((["running", "waiting", "idle", "exited"] as const).map((s) => [s, agentStateLabel(s)]))).toEqual({ running: "çalışıyor", waiting: "seni bekliyor", idle: "boşta", exited: "kapandı" });
  });

  it("relative time in Turkish, clamped for clock skew and bad input", () => {
    expect(relativeTime(iso(T0), T0)).toBe("az önce");
    expect(relativeTime(iso(T0), T0 + 4_000)).toBe("az önce");
    expect(relativeTime(iso(T0), T0 + 42_000)).toBe("42 sn önce");
    expect(relativeTime(iso(T0), T0 + 5 * 60_000)).toBe("5 dk önce");
    expect(relativeTime(iso(T0), T0 + 3 * 3_600_000)).toBe("3 sa önce");
    expect(relativeTime(iso(T0), T0 + 2 * 86_400_000)).toBe("2 gün önce");
    expect(relativeTime(iso(T0 + 60_000), T0)).toBe("az önce");
    expect(relativeTime("not a date", T0)).toBe("");
  });

  it("agentLabel: the tool's name, else the terminal title", () => {
    const tools = [makeTool("claude", "Claude")];
    expect(agentLabel(term("t", "p", "idle", { toolId: "claude", title: "claude" }), tools)).toBe("Claude");
    expect(agentLabel(term("t", "p", "idle", { toolId: "gone", title: "zsh" }), tools)).toBe("zsh");
    expect(agentLabel(term("t", "p", "idle", { title: "npm test" }), tools)).toBe("npm test");
  });

  it("agentCounts counts running and waiting per project", () => {
    const counts = agentCounts([
      term("a", "p1", "running"),
      term("b", "p1", "waiting"),
      term("c", "p1", "waiting"),
      term("d", "p1", "idle"),
      term("e", "p2", "exited"),
      term("f", "p2"),
    ]);
    expect(counts).toEqual({ p1: { running: 1, waiting: 2 }, p2: { running: 0, waiting: 0 } });
  });

  it("waitingAgents lists waiting terminals, longest waiting first", () => {
    const a = term("a", "p1", "waiting", { activity: { state: "waiting", since: iso(T0 + 1000) } });
    const b = term("b", "p2", "waiting", { activity: { state: "waiting", since: iso(T0) } });
    expect(waitingAgents([a, term("c", "p1", "running"), b]).map((t) => t.id)).toEqual(["b", "a"]);
  });
});
