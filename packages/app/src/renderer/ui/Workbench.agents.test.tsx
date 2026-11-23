// İş A — ajan özeti: Ajanlar panel, rail counters and "Seni bekleyen".
import type { TerminalActivity, TerminalInfo } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import {
  FakeEngineClient,
  makeCard,
  makeProject,
  makeProjectTerminal,
  makeTerminal,
  makeTool,
} from "./test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory, type FakeViewFactory } from "./test-utils/fake-view.ts";

const flush = () => act(async () => {});
const NOW = Date.parse("2026-11-16T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MONKEY_STEPS = 120;
/** jsdom renders are slow when the whole suite runs in parallel. */
const MONKEY_TIMEOUT_MS = 30_000;

function withActivity(t: TerminalInfo, activity: TerminalActivity, extra: Partial<TerminalInfo> = {}): TerminalInfo {
  return { ...t, activity, ...extra };
}

function seed() {
  return new FakeEngineClient({
    projects: [makeProject("p1", "Alfa"), makeProject("p2", "Beta")],
    cards: [makeCard("a", "p1", "Kart A")],
    tools: [makeTool("claude", "Claude"), makeTool("codex", "Codex")],
    terminals: [
      withActivity(makeProjectTerminal("tp1", "p1", "claude"), { state: "waiting", since: ago(42_000), summary: "Do you want to proceed?" }, { toolId: "claude" }),
      withActivity(makeTerminal("ta1", "a", "codex", "p1"), { state: "running", since: ago(5 * 60_000), summary: "working 3" }, { toolId: "codex" }),
      withActivity(makeProjectTerminal("tp2", "p1", "zsh"), { state: "idle", since: ago(3 * 3_600_000) }),
      withActivity(makeProjectTerminal("tq1", "p2", "claude"), { state: "waiting", since: ago(10 * 60_000), summary: "❯ 1. Yes" }, { toolId: "claude" }),
    ],
  });
}

let views: FakeViewFactory;

async function setup(client = seed()) {
  views = makeFakeViewFactory();
  render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} />);
  await flush();
  return client;
}

const rail = () => screen.getByRole("navigation");
const main = () => screen.getByRole("main");
const agentsPanel = () => within(main()).getByRole("region", { name: "Ajanlar" });
const waitingSection = () => within(rail()).getByRole("region", { name: "Seni bekleyen" });
const headerTitle = () => document.querySelector(".kp-header__title")?.textContent;
const viewOf = (terminalId: string) =>
  views.views.find((v) => !v.disposed && v.container?.closest(`[data-terminal-id="${terminalId}"]`));

async function selectProject(name: string) {
  fireEvent.click(within(rail()).getByRole("button", { name }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Ajanlar panel", () => {
  it("replaces Görev akışı and lists this project's terminals, card terminals included", async () => {
    await setup();
    await selectProject("Alfa");
    expect(within(main()).queryByText("Görev akışı")).toBeNull();
    const items = within(agentsPanel()).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const text = items.map((li) => li.textContent);
    // Kopyalama: right click on a row offers the terminal's command.
    for (const li of items) expect(li.querySelector("button")!.getAttribute("data-copy")).toBeTruthy();
    expect(text[0]).toContain("Claude");
    expect(text[0]).toContain("seni bekliyor");
    expect(text[0]).toContain("42 sn önce");
    expect(text[0]).toContain("Do you want to proceed?");
    expect(text[1]).toContain("Codex");
    expect(text[1]).toContain("Kart A");
    expect(text[1]).toContain("çalışıyor");
    expect(text[1]).toContain("5 dk önce");
    expect(text[2]).toContain("zsh");
    expect(text[2]).toContain("boşta");
    expect(within(agentsPanel()).queryByText("❯ 1. Yes")).toBeNull();
  });

  it("says so when the project has no terminals", async () => {
    const client = seed();
    client.terminals = [];
    await setup(client);
    await selectProject("Beta");
    expect(within(agentsPanel()).getByText("Bu projede terminal yok.")).toBeTruthy();
  });

  it("updates live from terminal.activity events", async () => {
    const client = await setup();
    await selectProject("Alfa");
    act(() =>
      client.emitEvent({
        type: "event",
        name: "terminal.activity",
        terminalId: "tp2",
        projectId: "p1",
        activity: { state: "running", since: ago(0), summary: "npm test" },
      }),
    );
    const item = within(agentsPanel()).getAllByRole("listitem")[2]!;
    expect(item.textContent).toContain("çalışıyor");
    expect(item.textContent).toContain("npm test");
    expect(item.textContent).toContain("az önce");
  });

  it("reloads on terminals.changed (a new terminal appears)", async () => {
    const client = await setup();
    await selectProject("Beta");
    client.terminals.push(makeProjectTerminal("tq2", "p2", "yeni"));
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p2" }));
    await flush();
    expect(within(agentsPanel()).getAllByRole("listitem")).toHaveLength(2);
  });

  it("clicking a project terminal focuses its panel", async () => {
    await setup();
    await selectProject("Alfa");
    fireEvent.click(within(agentsPanel()).getByRole("button", { name: /^Claude/ }));
    await flush();
    expect(viewOf("tp1")?.focuses).toBe(1);
  });

  it("clicking a card terminal opens the card and focuses its panel", async () => {
    await setup();
    await selectProject("Alfa");
    fireEvent.click(within(agentsPanel()).getByRole("button", { name: /^Codex/ }));
    await flush();
    expect(within(rail()).getByRole("button", { name: "Kart A" }).getAttribute("aria-current")).toBe("true");
    expect(viewOf("ta1")?.focuses).toBe(1);
  });
});

describe("rail", () => {
  it("shows running/waiting counters per project", async () => {
    await setup();
    expect(within(rail()).getByLabelText("Alfa: 1 çalışıyor, 1 seni bekliyor")).toBeTruthy();
    expect(within(rail()).getByLabelText("Beta: 0 çalışıyor, 1 seni bekliyor")).toBeTruthy();
  });

  it("lists waiting terminals across projects under Seni bekleyen, longest waiting first", async () => {
    await setup();
    const items = within(waitingSection()).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringMatching(/Claude.*Beta/),
      expect.stringMatching(/Claude.*Alfa/),
    ]);
  });

  it("clicking a waiting terminal selects its project and focuses the terminal", async () => {
    await setup();
    fireEvent.click(within(waitingSection()).getAllByRole("button")[0]!);
    await flush();
    expect(headerTitle()).toBe("Beta");
    expect(viewOf("tq1")?.focuses).toBe(1);
  });

  it("Seni bekleyen disappears when nothing waits", async () => {
    const client = await setup();
    for (const [terminalId, projectId] of [["tp1", "p1"], ["tq1", "p2"]] as const) {
      act(() =>
        client.emitEvent({ type: "event", name: "terminal.activity", terminalId, projectId, activity: { state: "idle", since: ago(0) } }),
      );
    }
    expect(within(rail()).queryByRole("region", { name: "Seni bekleyen" })).toBeNull();
  });
});

describe("agents monkey", () => {
  it("random activity events, unknown terminals, reloads and clicks keep the UI consistent", async () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const states = ["running", "waiting", "idle", "exited"] as const;
    const summaries = [undefined, "", "\u0000", "🚀çğış", "x".repeat(2000), "<script>alert(1)</script>"];
    const client = await setup();
    for (let step = 0; step < MONKEY_STEPS; step++) {
      const ids = ["tp1", "ta1", "tp2", "tq1", "ghost"];
      const r = rnd(10);
      await act(async () => {
        if (r < 6) {
          const id = ids[rnd(ids.length)]!;
          const t = client.terminals.find((x) => x.id === id);
          const summary = summaries[rnd(summaries.length)];
          client.emitEvent({
            type: "event",
            name: "terminal.activity",
            terminalId: id,
            projectId: t?.projectId ?? "p9",
            activity: { state: states[rnd(states.length)]!, since: ago(rnd(100_000)), ...(summary !== undefined ? { summary } : {}) },
          });
        } else if (r < 7) {
          client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1" });
        } else {
          const panelButtons = within(main()).queryAllByRole("region", { name: "Ajanlar" }).length
            ? within(agentsPanel()).queryAllByRole("button")
            : [];
          const buttons = [...within(rail()).queryAllByRole("button"), ...panelButtons].filter(
            (b) => !/Ayarlar|Yapılacaklar|Yeni kart/.test(b.textContent ?? ""),
          );
          if (buttons.length) fireEvent.click(buttons[rnd(buttons.length)]!);
        }
      });
      // İş P: a collapsed rail shows only the number of waiting sessions; expand it before comparing.
      const expand = within(rail()).queryByRole("button", { name: "Sol listeyi genişlet" });
      if (expand) await act(async () => void fireEvent.click(expand));
      // Counters agree with the waiting list.
      const waitingButtons = within(rail()).queryAllByRole("region", { name: "Seni bekleyen" }).length
        ? within(waitingSection()).getAllByRole("button").length
        : 0;
      const counted = within(rail())
        .queryAllByRole("img")
        .map((el) => Number(/(\d+) seni bekliyor/.exec(el.getAttribute("aria-label") ?? "")?.[1] ?? 0))
        .reduce((a, b) => a + b, 0);
      expect(counted).toBe(waitingButtons);
    }
  }, MONKEY_TIMEOUT_MS);
});
