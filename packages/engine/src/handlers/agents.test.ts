import type { ServerMessage } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePtys, makeProjects } from "../../test/fakes/server-fakes.ts";
import { createActivityTracker, withActivity, type ActivityTracker } from "../activity.ts";
import type { LaunchSpec, PtyManager } from "../contracts.ts";
import { agentsHandlers } from "./agents.ts";

const WINDOW_MS = 1000;
const DEBOUNCE_MS = 50;
const LAUNCH: LaunchSpec = { file: "/bin/sh", args: [], cwd: "/", title: "sh" };
const DIMS = { cols: 80, rows: 24 };

let fake: FakePtys;
let tracker: ActivityTracker;
let ptys: PtyManager;
let sent: ServerMessage[];

beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakePtys();
  tracker = createActivityTracker({
    windowMs: WINDOW_MS,
    debounceMs: DEBOUNCE_MS,
    scanLines: 10,
    summaryMaxLen: 80,
    tailChars: 4096,
    patternsFor: (toolId) => (toolId === "claude" ? ["Do you want to proceed\\?"] : []),
    logger: { info() {}, warn() {}, error() {} },
  });
  ptys = withActivity(fake, tracker);
  sent = [];
});
afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
});

describe("withActivity", () => {
  it("open/get/list carry activity; output, input and exit drive it", () => {
    const t = ptys.open({ projectId: "p1", toolId: "claude" }, LAUNCH, DIMS);
    expect(t.activity?.state).toBe("idle");
    fake.emit(t.id, "Do you want to proceed?\r\n");
    expect(ptys.get(t.id)?.activity?.state).toBe("waiting");
    ptys.write(t.id, "1");
    expect(fake.called("write")).toEqual([[t.id, "1"]]);
    expect(ptys.list({ projectId: "p1" })[0]?.activity?.state).toBe("running");
    fake.exit(t.id, 0);
    expect(ptys.get(t.id)?.activity?.state).toBe("exited");
  });

  it("terminals it never tracked: exited ones report exited, running ones carry no activity", () => {
    const exited = { id: "old", projectId: "p1", title: "x", status: "exited" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    fake.seed(exited);
    expect(ptys.get("old")?.activity).toEqual({ state: "exited", since: exited.createdAt });
    const running = fake.add({ projectId: "p1" });
    expect(ptys.get(running.id)?.activity).toBeUndefined();
  });

  it("close, closeAllForCard and closeAllForProject forget the terminals and unsubscribe", () => {
    const a = ptys.open({ projectId: "p1" }, LAUNCH, DIMS);
    const b = ptys.open({ projectId: "p1", cardId: "c" }, LAUNCH, DIMS);
    const c = ptys.open({ projectId: "p2" }, LAUNCH, DIMS);
    ptys.close(a.id);
    ptys.closeAllForCard("c");
    ptys.closeAllForProject("p2");
    for (const id of [a.id, b.id, c.id]) expect(tracker.get(id)).toBeUndefined();
  });

  it("delegates history, resize and subscribe", () => {
    const t = ptys.open({ projectId: "p1" }, LAUNCH, DIMS);
    fake.emit(t.id, "hi");
    expect(ptys.history(t.id)).toBe("hi");
    ptys.resize(t.id, 10, 10);
    expect(fake.called("resize")).toEqual([[t.id, 10, 10]]);
    const seen: string[] = [];
    ptys.subscribe(t.id, { onData: (d) => seen.push(d), onExit() {} });
    fake.emit(t.id, "x");
    expect(seen).toEqual(["x"]);
  });
});

describe("agents handlers", () => {
  function handlers() {
    return agentsHandlers({ ptys, projects: { list: makeProjects }, activity: tracker, broadcast: (m) => sent.push(m) });
  }

  it("agents.summary groups every terminal by project in project order, skipping empty and unknown projects", () => {
    const h = handlers();
    const t2 = ptys.open({ projectId: "p2" }, LAUNCH, DIMS);
    const t1 = ptys.open({ projectId: "p1", cardId: "c1", toolId: "claude" }, LAUNCH, DIMS);
    ptys.open({ projectId: "gone" }, LAUNCH, DIMS);
    fake.emit(t1.id, "Do you want to proceed?\r\n");
    const r = h["agents.summary"](undefined, {});
    expect(r.projects.map((p) => p.projectId)).toEqual(["p1", "p2"]);
    expect(r.projects[0]!.terminals.map((t) => [t.id, t.cardId, t.activity?.state])).toEqual([[t1.id, "c1", "waiting"]]);
    expect(r.projects[1]!.terminals[0]!.id).toBe(t2.id);
  });

  it("broadcasts terminal.activity on tracker changes", () => {
    handlers();
    const t = ptys.open({ projectId: "p1", cardId: "c1", toolId: "claude" }, LAUNCH, DIMS);
    fake.emit(t.id, "Do you want to proceed?\r\n");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(sent).toEqual([
      {
        type: "event",
        name: "terminal.activity",
        terminalId: t.id,
        projectId: "p1",
        cardId: "c1",
        activity: expect.objectContaining({ state: "waiting", summary: "Do you want to proceed?" }),
      },
    ]);
  });

  it("works without a tracker (no activity, no events)", () => {
    const h = agentsHandlers({ ptys: fake, projects: { list: makeProjects }, broadcast: (m) => sent.push(m) });
    fake.add({ projectId: "p1" });
    expect(h["agents.summary"](undefined, {}).projects).toHaveLength(1);
    expect(sent).toEqual([]);
  });
});
