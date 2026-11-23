// İş H: the account name shows subtly on the project's tab and on background agents of non-default accounts.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BgAgentsSection } from "./BgAgentsSection.tsx";
import { ProjectTabs } from "./ProjectTabs.tsx";
import { FakeEngineClient, makeBgAgent, makeProject } from "./test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "./test-utils/fake-view.ts";
import { Workbench } from "./Workbench.tsx";

beforeEach(() => vi.stubGlobal("ResizeObserver", FakeResizeObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});


const usageWindow = (messages: number, cacheRead: number) => ({ totals: { messages, input: 0, output: 0, cacheWrite: 0, cacheRead }, byModel: [], topProjects: [] });
const usageAccount = (accountId: string, name: string, session: number) => ({
  accountId,
  name,
  windows: { session: usageWindow(3, session), today: usageWindow(5, 3_400_000), week: usageWindow(9, 30_000_000) },
  updatedAt: "2026-11-18T12:00:00.000Z",
  indexing: false,
});
const USAGE = {
  accounts: [usageAccount("benim", "Benim", 500), usageAccount("work", "Work", 1_200_000)],
  sessionWindowHours: 5,
  longWindowDays: 7,
  refreshIntervalMs: 60_000,
  probeAvailable: false,
};

describe("Claude kullanımı on the account badge", () => {
  const handlers = { onActivate: () => {}, onClose: () => {}, onMove: () => {} };

  it("the badge's tooltip carries the account's usage; hovering it asks for fresh numbers", () => {
    const onAccountHover = vi.fn();
    render(
      <ProjectTabs
        items={[{ projectId: "p1", title: "Alfa", accountName: "Work", accountUsage: "Son 5 saat: 1,2 Mn token" }]}
        active="p1"
        {...handlers}
        onAccountHover={onAccountHover}
      />,
    );
    const badge = screen.getByText("Work");
    expect(badge.getAttribute("title")).toBe("Claude hesabı\nSon 5 saat: 1,2 Mn token");
    fireEvent.mouseEnter(badge);
    expect(onAccountHover).toHaveBeenCalledWith("p1");
  });

  it("Workbench puts the engine's numbers into the tooltip of a non-default account's badge", async () => {
    const client = new FakeEngineClient({
      projects: [makeProject("p1", "Alfa", { claudeAccountId: "work" })],
      claudeAccounts: [
        { id: "benim", name: "Benim", configDir: "/u/.claude", isDefault: true },
        { id: "work", name: "Work", configDir: "/u/.claude-work" },
      ],
    });
    client.respond("claudeUsage.get", () => USAGE);
    const views = makeFakeViewFactory();
    render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} uiState={null} selectProject={{ projectId: "p1", seq: 1 }} />);
    await act(async () => {});
    await act(async () => {});
    const badge = within(document.querySelector('.kp-ptab[data-project-id="p1"]') as HTMLElement).getByText("Work");
    const title = badge.getAttribute("title") ?? "";
    expect(title).toContain("Claude hesabı");
    expect(title).toContain("Son 5 saat: 1,2 Mn token · Bugün: 3,4 Mn · Son 7 gün: 30 Mn");
    expect(title).toContain("Kokpit'in bu Mac'teki sayımı");
    // No polling from the work view: one read on connect, another only when hovered or when the engine announces news.
    const before = client.callsOf("claudeUsage.get").length;
    fireEvent.mouseEnter(badge);
    await act(async () => {});
    expect(client.callsOf("claudeUsage.get").length).toBe(before + 1);
    client.emitEvent({ type: "event", name: "claudeUsage.changed" });
    await act(async () => {});
    expect(client.callsOf("claudeUsage.get").length).toBe(before + 2);
  });
});

describe("Claude account badges (İş H)", () => {
  it("a project's tab shows the account only when given", () => {
    const handlers = { onActivate: () => {}, onClose: () => {}, onMove: () => {} };
    const tab = { projectId: "p1", title: "Alfa", location: "Mac mini: /x" };
    const { rerender } = render(<ProjectTabs items={[tab]} active="p1" {...handlers} />);
    expect(screen.queryByTitle("Claude hesabı")).toBeNull();
    rerender(<ProjectTabs items={[{ ...tab, accountName: "Work" }, { projectId: "p2", title: "Beta" }]} active="p1" {...handlers} />);
    const badge = screen.getByTitle("Claude hesabı");
    expect(badge.textContent).toBe("Work");
    expect(badge.closest("[data-project-id]")?.getAttribute("data-project-id")).toBe("p1");
    // The badge is not part of the tab's name.
    expect(screen.getByRole("button", { name: "Alfa" })).toBeTruthy();
  });

  it("background agents carry their account badge", () => {
    render(
      <BgAgentsSection
        sessions={[makeBgAgent("a1", "running", { name: "Mine" }), makeBgAgent("k1", "running", { name: "Onun", accountId: "work" })]}
        projectId={undefined}
        placeOf={() => "Diğer"}
        accountOf={(s) => (s.accountId === "work" ? "Work" : undefined)}
        now={0}
        onAttach={async () => {}}
        onLogs={async () => ({ text: "", truncated: false })}
        onStop={async () => {}}
      />,
    );
    const row = (id: string) => document.querySelector(`[data-bg-agent-id="${id}"]`) as HTMLElement;
    expect(within(row("k1")).getByTitle("Claude hesabı").textContent).toBe("Work");
    expect(within(row("a1")).queryByTitle("Claude hesabı")).toBeNull();
  });

  it("Workbench wires the accounts: the tab of a Work project shows Work, a default-account one nothing", async () => {
    const client = new FakeEngineClient({
      projects: [makeProject("p1", "Alfa", { claudeAccountId: "work" }), makeProject("p2", "Beta")],
      claudeAccounts: [
        { id: "benim", name: "Benim", configDir: "/u/.claude", isDefault: true },
        { id: "work", name: "Work", configDir: "/u/.claude-work" },
      ],
    });
    const views = makeFakeViewFactory();
    render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} uiState={null} selectProject={{ projectId: "p1", seq: 1 }} />);
    await act(async () => {});
    await act(async () => {});
    const tabOf = (id: string) => document.querySelector(`.kp-ptab[data-project-id="${id}"]`) as HTMLElement;
    expect(within(tabOf("p1")).getByTitle("Claude hesabı").textContent).toBe("Work");
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Beta" }));
    await act(async () => {});
    expect(within(tabOf("p2")).queryByTitle("Claude hesabı")).toBeNull();
    expect(screen.getAllByTitle("Claude hesabı")).toHaveLength(1);
  });
});
