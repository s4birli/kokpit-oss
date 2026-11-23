// İş C — Harita panel inside the project view.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import { defaultUiConfig } from "./config.ts";
import {
  FAKE_MAP_UPDATE_COMMAND,
  FakeEngineClient,
  makeCard,
  makeHost,
  makeProject,
  makeProjectTerminal,
  makeSshProject,
} from "./test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "./test-utils/fake-view.ts";
import { menuTitles, menuToggle } from "./test-utils/fake-menu.ts";

const flush = () => act(async () => {});

function seed() {
  return new FakeEngineClient({
    projects: [makeProject("p1", "Alfa"), makeSshProject("p3", "Uzak", "h1", "/srv/app")],
    cards: [makeCard("a", "p1", "Kart A")],
    terminals: [makeProjectTerminal("tp1", "p1", "P-1")],
    hosts: [makeHost("h1", "oracle")],
  });
}

async function setup(client = seed()) {
  const views = makeFakeViewFactory();
  render(<Workbench client={client} engineUrl="ws://127.0.0.1:7420" onOpenSettings={() => {}} createView={views.factory} />);
  await flush();
  return client;
}

async function select(name: string) {
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name }));
  await flush();
}

const mapPanel = () => screen.queryByRole("region", { name: "Harita" });

beforeEach(() => vi.stubGlobal("ResizeObserver", FakeResizeObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openMap = async () => {
  menuToggle("Harita");
  await flush();
};

describe("Workbench: Harita", () => {
  it("is closed by default; Görünüm › Harita opens it as a tab next to Tarayıcı", async () => {
    await setup();
    await select("Alfa");
    expect(mapPanel()).toBeNull();
    await openMap();
    expect(mapPanel()).not.toBeNull();
    // A tab in the Tarayıcı group: both tabs share one tab list.
    const mapTab = screen.getByRole("tab", { name: "Harita" });
    expect(within(mapTab.closest('[role="tablist"]') as HTMLElement).getByRole("tab", { name: "Tarayıcı" })).toBeTruthy();
  });

  it("is not shown for ssh projects or cards", async () => {
    await setup();
    await select("Alfa");
    await openMap();
    // İş D: the ssh project has its own layout — Harita was opened in Alfa's, not here — and cannot open one.
    await select("Uzak");
    expect(mapPanel()).toBeNull();
    expect(menuTitles()).not.toContain("Harita");
    // A card shares its project's layout: the open Harita tab says it has nothing to show for a card.
    await select("Kart A");
    expect(mapPanel()).toBeNull();
    expect(screen.getByText("Bu panel seçili proje için kullanılamaz.")).toBeTruthy();
  });

  it("'Haritayı güncelle' opens a project terminal with the configured command and shows it", async () => {
    const client = await setup();
    await select("Alfa");
    await openMap();
    fireEvent.click(within(mapPanel()!).getByRole("button", { name: "Haritayı güncelle" }));
    await flush();
    expect(client.callsOf("terminal.open")).toEqual([
      { projectId: "p1", ...defaultUiConfig.fallbackDims, command: FAKE_MAP_UPDATE_COMMAND },
    ]);
    expect(screen.getAllByRole("region", { name: `Terminal: ${FAKE_MAP_UPDATE_COMMAND}` })).toHaveLength(1);
  });
});
