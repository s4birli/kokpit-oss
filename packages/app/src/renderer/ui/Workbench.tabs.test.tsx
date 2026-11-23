// İş P — proje sekmeleri inside the workbench: open from the rail, switch, close, reorder, persistence, the
// collapsible rail.
import type { Project } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import { FakeEngineClient, makeCard, makeProject, makeProjectTerminal, makeTerminal } from "./test-utils/fake-client.ts";
import { fakeUiStateBridge, type FakeUiStateBridge } from "./test-utils/fake-ui-state.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "./test-utils/fake-view.ts";
import { defaultLayoutConfig } from "./layout/config.ts";
import { activeTerminalTitle, isDockTab } from "./test-utils/terminal-tabs.ts";
import { defaultProjectTabsText } from "./ProjectTabs.tsx";

const flush = () => act(async () => {});
const config = { ...defaultLayoutConfig, saveDebounceMs: 5 };

function seed() {
  return new FakeEngineClient({
    projects: [makeProject("p1", "Alfa"), makeProject("p2", "Beta"), makeProject("p3", "Gama")],
    cards: [makeCard("a", "p1", "Kart A")],
    terminals: [
      makeProjectTerminal("tp1", "p1", "P-1"),
      makeTerminal("ta1", "a", "A-1", "p1"),
      makeProjectTerminal("tq1", "p2", "Q-1"),
      makeProjectTerminal("tr1", "p3", "R-1"),
    ],
  });
}

async function setup(bridge: FakeUiStateBridge | null = null, client = seed()) {
  const views = makeFakeViewFactory();
  const r = render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} uiState={bridge} layoutConfig={config} />);
  await flush();
  return { client, ...r };
}

const rail = () => screen.getByRole("navigation");
const strip = () => screen.queryByRole("toolbar", { name: defaultProjectTabsText.label });
const tabTitles = () => Array.from(strip()?.querySelectorAll(".kp-ptab__main") ?? [], (b) => b.textContent);
const activeTab = () => strip()?.querySelector('.kp-ptab__main[aria-current="page"]')?.textContent ?? null;
const tabButton = (name: string) => within(strip()!).getByRole("button", { name });
const tabOf = (title: string) => tabButton(title).closest<HTMLElement>(".kp-ptab")!;
const headerTitle = () => document.querySelector(".kp-header__title")?.textContent;
const dockTabs = () => screen.queryAllByRole("tab").filter(isDockTab).map((t) => t.getAttribute("aria-label"));

async function click(el: HTMLElement) {
  fireEvent.click(el);
  await flush();
}
const openInRail = (name: string) => click(within(rail()).getByRole("button", { name }));
const closeTab = (title: string) => click(within(strip()!).getByRole("button", { name: defaultProjectTabsText.close(title) }));
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, config.saveDebounceMs * 4))));

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workbench: proje sekmeleri", () => {
  it("no tabs until a project is opened; opening from the rail adds and activates its tab (no duplicates)", async () => {
    await setup();
    expect(strip()).toBeNull();
    expect(headerTitle()).toBe("Proje seçilmedi");
    await openInRail("Alfa");
    await openInRail("Beta");
    await openInRail("Alfa");
    expect(tabTitles()).toEqual(["Alfa", "Beta"]);
    expect(activeTab()).toBe("Alfa");
    expect(headerTitle()).toBe("Alfa");
  });

  it("switching tabs shows each project's own terminals and restores its selected card", async () => {
    await setup();
    await openInRail("Kart A");
    expect(headerTitle()).toBe("Kart A");
    expect(activeTerminalTitle()).toBe("A-1");
    await openInRail("Beta");
    expect(tabTitles()).toEqual(["Alfa", "Beta"]);
    expect(activeTerminalTitle()).toBe("Q-1");
    await click(tabButton("Alfa"));
    expect(headerTitle()).toBe("Kart A");
    expect(activeTerminalTitle()).toBe("A-1");
    expect(within(rail()).getByRole("button", { name: "Kart A" }).getAttribute("aria-current")).toBe("true");
    // The project's own name in the rail, on its active tab, goes back to the project itself.
    await openInRail("Alfa");
    expect(headerTitle()).toBe("Alfa");
    expect(activeTerminalTitle()).toBe("P-1");
  });

  it("closing the active tab activates its neighbour and deletes nothing; the last close leaves no selection", async () => {
    const { client } = await setup();
    for (const p of ["Alfa", "Beta", "Gama"]) await openInRail(p);
    await click(tabButton("Beta"));
    await closeTab("Beta");
    expect(tabTitles()).toEqual(["Alfa", "Gama"]);
    expect(activeTab()).toBe("Gama");
    expect(headerTitle()).toBe("Gama");
    await closeTab("Alfa");
    expect(activeTab()).toBe("Gama");
    tabOf("Gama").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await flush();
    expect(strip()).toBeNull();
    expect(headerTitle()).toBe("Proje seçilmedi");
    expect(within(rail()).getByRole("button", { name: "Beta" })).toBeTruthy();
    expect(client.calls.filter((c) => /delete|remove/.test(c.method))).toEqual([]);
  });

  it("drag and the keyboard reorder tabs", async () => {
    await setup();
    for (const p of ["Alfa", "Beta", "Gama"]) await openInRail(p);
    fireEvent.dragStart(tabOf("Gama"));
    fireEvent.dragOver(tabOf("Alfa"));
    fireEvent.drop(tabOf("Alfa"));
    await flush();
    expect(tabTitles()).toEqual(["Gama", "Alfa", "Beta"]);
    fireEvent.keyDown(tabButton("Gama"), { key: "ArrowRight", altKey: true, shiftKey: true });
    await flush();
    expect(tabTitles()).toEqual(["Alfa", "Gama", "Beta"]);
    expect(activeTab()).toBe("Gama");
  });

  it("open tabs, their order, the active one and its card survive a restart", async () => {
    const bridge = fakeUiStateBridge();
    const first = await setup(bridge);
    for (const p of ["Alfa", "Beta", "Gama"]) await openInRail(p);
    await openInRail("Kart A");
    await click(tabButton("Beta"));
    fireEvent.keyDown(tabButton("Beta"), { key: "ArrowLeft", altKey: true, shiftKey: true });
    await settle();
    first.unmount();
    await flush();

    await setup(bridge);
    expect(tabTitles()).toEqual(["Beta", "Alfa", "Gama"]);
    expect(activeTab()).toBe("Beta");
    expect(headerTitle()).toBe("Beta");
    await click(tabButton("Alfa"));
    expect(headerTitle()).toBe("Kart A");
  });

  it("first launch with tabs: the previously selected project becomes the only tab", async () => {
    await setup(fakeUiStateBridge({ version: 1, layouts: {}, panels: {}, selection: { kind: "project", projectId: "p2" } }));
    expect(tabTitles()).toEqual(["Beta"]);
    expect(headerTitle()).toBe("Beta");
  });

  it("first launch with a previously selected card: its project's tab opens on that card", async () => {
    await setup(fakeUiStateBridge({ version: 1, layouts: {}, panels: {}, selection: { kind: "card", cardId: "a" } }));
    expect(tabTitles()).toEqual(["Alfa"]);
    expect(headerTitle()).toBe("Kart A");
  });


  it("a deleted card's tab falls back to its project; a vanished project's tab closes", async () => {
    const { client } = await setup();
    await openInRail("Kart A");
    await openInRail("Gama");
    await act(async () => {
      client.cards = client.cards.filter((c) => c.id !== "a");
      client.emitEvent({ type: "event", name: "cards.changed", projectId: "p1" });
      client.projects = client.projects.filter((p) => p.id !== "p3");
      client.emitEvent({ type: "event", name: "projects.changed" });
    });
    await flush();
    expect(tabTitles()).toEqual(["Alfa"]);
    expect(headerTitle()).toBe("Alfa");
  });
});

describe("Workbench: daraltılabilir sol liste", () => {
  it("collapses and expands; the state survives a restart", async () => {
    const bridge = fakeUiStateBridge();
    const first = await setup(bridge);
    const collapse = within(rail()).getByRole("button", { name: "Sol listeyi daralt" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    await click(collapse);
    expect(within(rail()).queryByRole("button", { name: "Alfa" })).toBeNull();
    expect(within(rail()).getByRole("button", { name: "Sol listeyi genişlet" }).getAttribute("aria-expanded")).toBe("false");
    await settle();
    first.unmount();
    await flush();

    await setup(bridge);
    expect(within(rail()).queryByRole("button", { name: "Alfa" })).toBeNull();
    await click(within(rail()).getByRole("button", { name: "Sol listeyi genişlet" }));
    expect(within(rail()).getByRole("button", { name: "Alfa" })).toBeTruthy();
  });

  it("collapsed, Seni bekleyen is a count badge: it opens the list, the chosen terminal gets its tab and the rail collapses again", async () => {
    const client = seed();
    client.terminals.push({ ...makeProjectTerminal("tw1", "p2", "W-1"), activity: { state: "waiting", since: new Date(0).toISOString() } });
    await setup(null, client);
    await click(within(rail()).getByRole("button", { name: "Sol listeyi daralt" }));
    expect(within(rail()).queryByRole("region", { name: "Seni bekleyen" })).toBeNull();
    await click(within(rail()).getByRole("button", { name: "1 oturum seni bekliyor" }));
    const waiting = within(rail()).getByRole("region", { name: "Seni bekleyen" });
    await click(within(waiting).getAllByRole("button")[0]!);
    expect(tabTitles()).toEqual(["Beta"]);
    expect(activeTerminalTitle()).toBe("W-1");
    expect(within(rail()).getByRole("button", { name: "Sol listeyi genişlet" })).toBeTruthy();
    expect(within(rail()).queryByRole("button", { name: "Alfa" })).toBeNull();
  });
});
