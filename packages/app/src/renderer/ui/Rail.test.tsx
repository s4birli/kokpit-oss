// The rail and "Seni bekleyen": expanded it is a capped list (full text of every row in its tooltip); collapsed it is
// only a count badge inside the strip. The badge opens the list with the focus on the first session; a session
// chosen from a list opened that way gets its terminal and the rail goes back to the strip.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rail, RAIL_TEXT, type RailProps } from "./Rail.tsx";
import { WAITING_LIMITS, waitingBadgeLabel, type WaitingAgent, type WaitingBgAgent } from "./RailAgents.tsx";
import { makeBgAgent, makeProject, makeProjectTerminal } from "./test-utils/fake-client.ts";

afterEach(cleanup);

const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const SINCE = "2026-01-01T00:05:00.000Z";
const LONG = "BoşluksuzÇokUzunAjanAdı".repeat(4);

function agent(id: string, label: string, projectName: string, cardName?: string): WaitingAgent {
  return {
    terminal: { ...makeProjectTerminal(id, "p1", label), activity: { state: "waiting", since: SINCE } },
    label,
    projectName,
    ...(cardName !== undefined ? { cardName } : {}),
  };
}
const bgAgent = (id: string, name: string): WaitingBgAgent => ({
  session: makeBgAgent(id, "waiting", { name, waitingReason: "approval", startedAt: SINCE }),
  projectName: "Beta",
});

const AGENTS = [agent("t1", "Claude", "Alfa", "Kart A"), agent("t2", LONG, "Beta")];
const BACKGROUND = [bgAgent("b1", "gece işi")];

const base: RailProps = {
  projects: [makeProject("p1", "Alfa"), makeProject("p2", "Beta")],
  cardsByProject: {},
  error: null,
  cardErrors: {},
  selectedCardId: null,
  selectedProjectId: null,
  onSelectCard: () => {},
  onSelectProject: () => {},
  onCreateCard: async () => {},
  view: "work",
  onViewChange: () => {},
  onOpenSettings: () => {},
  now: NOW,
};

const makeSpies = () => ({
  onSelectAgent: vi.fn<NonNullable<RailProps["onSelectAgent"]>>(),
  onSelectBgAgent: vi.fn<NonNullable<RailProps["onSelectBgAgent"]>>(),
});
type Spies = ReturnType<typeof makeSpies>;

/** The rail as the workbench holds it: collapsed is the parent's state. */
function Host({ start, spies, extra }: { start: boolean; spies: Spies; extra?: Partial<RailProps> }) {
  const [collapsed, setCollapsed] = useState(start);
  return (
    <Rail
      {...base}
      waitingAgents={AGENTS}
      waitingBgAgents={BACKGROUND}
      onSelectAgent={spies.onSelectAgent}
      onSelectBgAgent={spies.onSelectBgAgent}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
      {...extra}
    />
  );
}

function mount(start: boolean, extra?: Partial<RailProps>): Spies {
  const spies = makeSpies();
  render(<Host start={start} spies={spies} {...(extra ? { extra } : {})} />);
  return spies;
}

const rail = () => screen.getByRole("navigation", { name: "Kokpit" });
const isCollapsed = () => rail().classList.contains("kp-rail--collapsed");
const badge = () => within(rail()).queryByRole("button", { name: /oturum seni bekliyor$/ });
const section = () => within(rail()).queryByRole("region", { name: "Seni bekleyen" });
const rows = () => within(section()!).getAllByRole("button");

describe("Rail collapsed", () => {
  it("shows only the expand button and a badge with the number of waiting sessions — no Seni bekleyen block", () => {
    mount(true);
    expect(isCollapsed()).toBe(true);
    expect(section()).toBeNull();
    expect(within(rail()).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([RAIL_TEXT.expand, "3 oturum seni bekliyor"]);
    expect(badge()!.textContent).toBe("3");
    // Nothing else of the rail survives collapsing.
    expect(within(rail()).queryByRole("group", { name: "Görünüm" })).toBeNull();
    expect(within(rail()).queryByRole("heading")).toBeNull();
    expect(within(rail()).queryByText("Alfa")).toBeNull();
  });

  it("the badge's tooltip lists the sessions: name, project › card, background reason", () => {
    mount(true);
    expect(badge()!.getAttribute("title")!.split("\n")).toEqual([
      "3 oturum seni bekliyor",
      "Claude — Alfa › Kart A",
      `${LONG} — Beta`,
      "gece işi — Beta · onay bekliyor",
    ]);
  });

  it("a long tooltip is cut after the configured number of sessions and says how many more wait", () => {
    const many = Array.from({ length: WAITING_LIMITS.tooltipMax + 4 }, (_, i) => agent(`m${i}`, `Ajan ${i}`, "Alfa"));
    mount(true, { waitingAgents: many, waitingBgAgents: [] });
    const lines = badge()!.getAttribute("title")!.split("\n");
    expect(lines).toHaveLength(WAITING_LIMITS.tooltipMax + 2);
    expect(lines[0]).toBe(waitingBadgeLabel(many.length));
    expect(lines.at(-1)).toBe("… ve 4 oturum daha");
  });

  it("the badge's number is capped; its name still says the real count", () => {
    const many = Array.from({ length: WAITING_LIMITS.badgeMax + 1 }, (_, i) => agent(`m${i}`, `Ajan ${i}`, "Alfa"));
    mount(true, { waitingAgents: many, waitingBgAgents: [] });
    expect(badge()!.textContent).toBe(`${WAITING_LIMITS.badgeMax}+`);
    expect(badge()!.getAttribute("aria-label")).toBe(`${WAITING_LIMITS.badgeMax + 1} oturum seni bekliyor`);
  });

  it("no badge when nothing waits", () => {
    mount(true, { waitingAgents: [], waitingBgAgents: [] });
    expect(badge()).toBeNull();
    expect(within(rail()).getAllByRole("button")).toHaveLength(1);
  });

  it("the badge opens the list with the focus on the first session; choosing it selects the terminal and collapses the rail again", () => {
    const spies = mount(true);
    fireEvent.click(badge()!);
    expect(isCollapsed()).toBe(false);
    expect(badge()).toBeNull();
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.click(rows()[0]!);
    expect(spies.onSelectAgent).toHaveBeenCalledTimes(1);
    expect(spies.onSelectAgent).toHaveBeenCalledWith(AGENTS[0]!.terminal);
    expect(isCollapsed()).toBe(true);
  });

  it("a background session chosen from a list opened by the badge collapses the rail again too", () => {
    const spies = mount(true);
    fireEvent.click(badge()!);
    fireEvent.click(rows()[2]!);
    expect(spies.onSelectBgAgent).toHaveBeenCalledWith(BACKGROUND[0]!.session);
    expect(isCollapsed()).toBe(true);
  });

  it("a rail the user collapsed and expanded with « » stays open after a session is chosen", () => {
    const spies = mount(true);
    fireEvent.click(badge()!);
    fireEvent.click(within(rail()).getByRole("button", { name: RAIL_TEXT.collapse }));
    fireEvent.click(within(rail()).getByRole("button", { name: RAIL_TEXT.expand }));
    expect(document.activeElement).not.toBe(rows()[0]);
    fireEvent.click(rows()[0]!);
    expect(spies.onSelectAgent).toHaveBeenCalledTimes(1);
    expect(isCollapsed()).toBe(false);
  });

  it("using the rail for something else after the badge opened it keeps it open", () => {
    mount(true);
    fireEvent.click(badge()!);
    fireEvent.click(within(rail()).getByRole("button", { name: "Alfa" }));
    fireEvent.click(rows()[0]!);
    expect(isCollapsed()).toBe(false);
  });
});

describe("Rail opened by the badge, then nothing waits", () => {
  it("a session that starts waiting later does not collapse the rail when chosen", () => {
    const onSelectAgent = vi.fn<NonNullable<RailProps["onSelectAgent"]>>();
    function Later() {
      const [collapsed, setCollapsed] = useState(true);
      const [agents, setAgents] = useState(AGENTS);
      return (
        <>
          <button type="button" onClick={() => setAgents([])}>
            boşalt
          </button>
          <button type="button" onClick={() => setAgents(AGENTS)}>
            doldur
          </button>
          <Rail {...base} waitingAgents={agents} onSelectAgent={onSelectAgent} collapsed={collapsed} onToggleCollapsed={() => setCollapsed((c) => !c)} />
        </>
      );
    }
    render(<Later />);
    fireEvent.click(badge()!);
    fireEvent.click(screen.getByRole("button", { name: "boşalt" }));
    expect(section()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "doldur" }));
    fireEvent.click(rows()[0]!);
    expect(onSelectAgent).toHaveBeenCalledTimes(1);
    expect(isCollapsed()).toBe(false);
  });
});

describe("Rail expanded", () => {
  it("lists the waiting sessions without taking the focus; choosing one leaves the rail open", () => {
    const spies = mount(false);
    expect(badge()).toBeNull();
    expect(rows()).toHaveLength(3);
    expect(rail().contains(document.activeElement)).toBe(false);
    fireEvent.click(rows()[1]!);
    expect(spies.onSelectAgent).toHaveBeenCalledWith(AGENTS[1]!.terminal);
    expect(isCollapsed()).toBe(false);
  });

  it("every row carries its full text as a tooltip (names are cut with an ellipsis)", () => {
    mount(false);
    expect(rows().map((r) => r.getAttribute("title"))).toEqual(["Claude — Alfa › Kart A", `${LONG} — Beta`, "gece işi — Beta · onay bekliyor"]);
    expect(rows()[0]!.textContent).toBe("ClaudeAlfa › Kart A5 dk önce");
  });

  it("without a collapse handler the rail is always expanded", () => {
    render(<Rail {...base} waitingAgents={AGENTS} onSelectAgent={() => {}} collapsed={true} />);
    expect(isCollapsed()).toBe(false);
    expect(section()).not.toBeNull();
  });
});
