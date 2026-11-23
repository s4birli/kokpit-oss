// Girişler: "is an agent running in this project right now?" — only ever used to make the warning stronger and to
// ask again on each fill. It never replaces the one-time per-project acceptance (logins.test.ts): the browser's
// DevTools port is a loopback port every program of this user can reach, whatever this function says.
import { describe, expect, it } from "vitest";
import { agentsPresentIn } from "./login-agents.ts";

const deps = (over: { terminals?: Record<string, number>; sessions?: { projectId?: string }[] | Error } = {}) => ({
  terminalCount: (projectId: string) => over.terminals?.[projectId] ?? 0,
  bgSessions: async () => {
    if (over.sessions instanceof Error) throw over.sessions;
    return over.sessions ?? [];
  },
});

describe("agentsPresentIn", () => {
  it("nothing running in the project: no", async () => {
    expect(await agentsPresentIn("p1", deps())).toBe(false);
    expect(await agentsPresentIn("p1", deps({ terminals: { p2: 3 }, sessions: [{ projectId: "p2" }, {}] }))).toBe(false);
  });

  it("a terminal of the project or of one of its cards (any tool, any location): yes", async () => {
    expect(await agentsPresentIn("p1", deps({ terminals: { p1: 1 } }))).toBe(true);
  });

  it("a background Claude session whose folder is the project's (or a card worktree of it): yes", async () => {
    expect(await agentsPresentIn("p1", deps({ sessions: [{ projectId: "p2" }, { projectId: "p1" }] }))).toBe(true);
  });

  it("the background sessions cannot be listed: assume yes (fail closed)", async () => {
    expect(await agentsPresentIn("p1", deps({ sessions: new Error("claude yok") }))).toBe(true);
  });

  it("does not ask for the background sessions when a terminal already answers", async () => {
    let asked = 0;
    const d = { terminalCount: () => 1, bgSessions: async () => (asked++, []) };
    expect(await agentsPresentIn("p1", d)).toBe(true);
    expect(asked).toBe(0);
  });
});
