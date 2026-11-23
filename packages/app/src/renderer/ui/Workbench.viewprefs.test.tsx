// İş Z inside the workbench: the terminal font size is global, persisted in the UI state and driven by menu
// commands; the browser zoom is per project (also when a card of it is selected).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import { defaultUiConfig } from "./config.ts";
import { defaultLayoutConfig } from "./layout/config.ts";
import { FakeEngineClient, makeCard, makeProject, makeProjectTerminal, makeTerminal } from "./test-utils/fake-client.ts";
import { fakeUiStateBridge, type FakeUiStateBridge } from "./test-utils/fake-ui-state.ts";
import { FakeResizeObserver, makeFakeViewFactory, type FakeViewFactory } from "./test-utils/fake-view.ts";
import { dispatchViewCommand } from "./view-prefs.ts";

const flush = () => act(async () => {});
const config = { ...defaultLayoutConfig, saveDebounceMs: 5 };
let views: FakeViewFactory;

function seed() {
  return new FakeEngineClient({
    projects: [makeProject("p1", "Alfa")],
    cards: [makeCard("a", "p1", "Kart A")],
    terminals: [makeProjectTerminal("tp1", "p1", "P-1"), makeTerminal("ta1", "a", "A-1", "p1")],
  });
}

async function setup(bridge: FakeUiStateBridge | null) {
  views = makeFakeViewFactory();
  const client = seed();
  const r = render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} uiState={bridge} layoutConfig={config} />);
  await flush();
  return { client, ...r };
}

const rail = () => screen.getByRole("navigation");
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, config.saveDebounceMs * 4));
  });
const live = () => views.views.filter((v) => !v.disposed);

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workbench: terminal font size", () => {
  it("menu commands change every terminal view live and the size survives a restart", async () => {
    const bridge = fakeUiStateBridge();
    const first = await setup(bridge);
    fireEvent.click(within(rail()).getByRole("button", { name: "Alfa" }));
    await flush();
    expect(live().length).toBeGreaterThan(0);
    expect(live().every((v) => v.fontSizes.at(-1) === defaultUiConfig.terminalFontSize)).toBe(true);
    act(() => dispatchViewCommand("terminal.font.larger"));
    act(() => dispatchViewCommand("terminal.font.larger"));
    expect(live().every((v) => v.fontSizes.at(-1) === 14)).toBe(true);
    await settle();
    expect(bridge.saved.at(-1)).toMatchObject({ panels: { terminals: { global: { fontSize: 14 } } } });
    first.unmount();
    await flush();
    // After unmount the bus no longer reaches the old workbench.
    act(() => dispatchViewCommand("terminal.font.smaller"));

    await setup(bridge);
    expect(live().length).toBeGreaterThan(0);
    expect(live().every((v) => v.fontSizes[0] === 14)).toBe(true);
    // The same size for a card's terminals: the setting is global.
    fireEvent.click(within(rail()).getByRole("button", { name: "Kart A" }));
    await flush();
    expect(live().every((v) => v.fontSizes.at(-1) === 14)).toBe(true);
    act(() => dispatchViewCommand("terminal.font.reset"));
    expect(live().every((v) => v.fontSizes.at(-1) === defaultUiConfig.terminalFontSize)).toBe(true);
  });
});
