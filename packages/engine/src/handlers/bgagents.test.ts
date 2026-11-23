import type { TerminalInfo } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import type { BgAgentsService } from "../bg-agents.ts";
import { EngineError } from "../contracts.ts";
import { bgAgentsHandlers } from "./bgagents.ts";

const terminal: TerminalInfo = { id: "t1", projectId: "alfa", title: "claude", status: "running", createdAt: "2026-01-01T00:00:00.000Z" };

function fakeService(): BgAgentsService & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    setClientCount: (n) => calls.push(["clients", n]),
    list: async () => ({ sessions: [{ id: "a1", name: "A", state: "running", cwd: "/x", projectId: "alfa" }] }),
    attachTarget: async (id) => {
      calls.push(["attachTarget", id]);
      return { projectId: "alfa", cardId: "k1", command: `claude attach ${id}` };
    },
    logs: async (id) => {
      calls.push(["logs", id]);
      return { text: "log", truncated: false };
    },
    stop: async (id) => {
      calls.push(["stop", id]);
    },
    onChange: () => () => {},
    match: () => undefined,
    dispose: () => {},
  };
}

describe("bgAgentsHandlers", () => {
  it("routes every request; attach opens a terminal with the attach command", async () => {
    const svc = fakeService();
    const opened: unknown[] = [];
    const h = bgAgentsHandlers({
      service: svc,
      openTerminal: (ctx, target, size) => {
        opened.push([ctx, target, size]);
        return { terminal };
      },
    });
    expect(await h["bgAgents.list"]("ctx", {})).toEqual({
      sessions: [{ id: "a1", name: "A", state: "running", cwd: "/x", projectId: "alfa" }],
    });
    expect(await h["bgAgents.attach"]("ctx", { id: "a1", cols: 90, rows: 20 })).toEqual({ terminal });
    expect(opened).toEqual([["ctx", { projectId: "alfa", cardId: "k1", command: "claude attach a1" }, { cols: 90, rows: 20 }]]);
    expect(await h["bgAgents.logs"]("ctx", { id: "a1" })).toEqual({ text: "log", truncated: false });
    expect(await h["bgAgents.stop"]("ctx", { id: "a1" })).toEqual({});
    expect(svc.calls).toEqual([
      ["attachTarget", "a1"],
      ["logs", "a1"],
      ["stop", "a1"],
    ]);
  });

  it("without a service: list is empty, actions answer INVALID", async () => {
    const h = bgAgentsHandlers({ service: undefined, openTerminal: () => ({ terminal }) });
    expect(await h["bgAgents.list"](null, {})).toEqual({ sessions: [] });
    for (const call of [
      () => h["bgAgents.attach"](null, { id: "a", cols: 1, rows: 1 }),
      () => h["bgAgents.logs"](null, { id: "a" }),
      () => h["bgAgents.stop"](null, { id: "a" }),
    ] as Array<() => unknown>) {
      await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(EngineError);
    }
  });
});
