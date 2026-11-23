// Bağlantılar inside the workbench: a link of a terminal opens in THAT TERMINAL'S project browser, the Tarayıcı
// panel is brought up for it, and each kind of project sends its links to the right place. The terminal renderer is
// a fake: "the user activated a link" is the call a real terminal makes after a ⌘ click (terminal-links.test.ts).
import type { Project } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import { FakeEngineClient, makeCard, makeProject, makeProjectTerminal, makeSshProject, makeTerminal } from "./test-utils/fake-client.ts";
import { fakeUiStateBridge } from "./test-utils/fake-ui-state.ts";
import { FakeResizeObserver, makeFakeViewFactory, type FakeViewFactory } from "./test-utils/fake-view.ts";
import { defaultLayoutConfig } from "./layout/config.ts";
import { isDockTab } from "./test-utils/terminal-tabs.ts";
import { menuChecked, menuToggle } from "./test-utils/fake-menu.ts";
import type { TerminalLinkHost } from "./link-opener.ts";

const flush = () => act(async () => {});
const LINK = "http://localhost:3000/sayfa?x=1";

function seed() {
  return new FakeEngineClient({
    projects: [makeProject("p1", "Alfa"), makeProject("p2", "Beta"), makeProject("pc", "İstemci", { browser: { runOn: "client" } }), makeSshProject("ps", "Uzak", "h1")],
    cards: [makeCard("a", "p1", "Kart A")],
    terminals: [
      makeProjectTerminal("tp1", "p1", "P-1"),
      makeProjectTerminal("tp2", "p2", "P-2"),
      makeProjectTerminal("tpc", "pc", "PC-1"),
      makeProjectTerminal("tps", "ps", "PS-1"),
      makeTerminal("ta1", "a", "A-1", "p1"),
    ],
  });
}

let views: FakeViewFactory;
let external: string[];
let local: [string, string | undefined][];
const config = { ...defaultLayoutConfig, saveDebounceMs: 5 };

async function setup(client = seed()) {
  views = makeFakeViewFactory();
  render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} uiState={fakeUiStateBridge()} layoutConfig={config} />);
  await flush();
  return client;
}

const rail = () => screen.getByRole("navigation");
const dockTabs = () => screen.queryAllByRole("tab").filter(isDockTab).map((t) => t.getAttribute("aria-label"));
const linksOf = (terminalId: string): TerminalLinkHost => {
  const view = views.views.find((v) => !v.disposed && v.container?.closest(`[data-terminal-id="${terminalId}"]`));
  if (!view?.links) throw new Error(`terminal ${terminalId} has no link host`);
  return view.links;
};
async function select(name: string) {
  fireEvent.click(within(rail()).getByRole("button", { name }));
  await flush();
}
/** What a ⌘ click on a link in that terminal ends in. */
async function activate(host: TerminalLinkHost, where: "project" | "external" = "project", url = LINK) {
  await act(async () => {
    await host.open(url, where);
  });
  await flush();
}
const browserSection = () => document.querySelector("section.kp-browser");

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  external = [];
  local = [];
  vi.stubGlobal("kokpit", {
    links: { openExternal: async (url: string) => void external.push(url), menu: async () => null },
    browser: { openLocal: async (projectId: string, url?: string) => void local.push([projectId, url]) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Bağlantılar: terminaldeki bağlantı projenin tarayıcısında açılır", () => {
  it("a link of a project terminal: the engine opens it in that project's Chrome and the Tarayıcı panel shows its tab", async () => {
    const client = await setup();
    await select("Alfa");
    expect(client.callsOf("browser.openUrl")).toEqual([]);
    await activate(linksOf("tp1"));
    expect(client.callsOf("browser.openUrl")).toEqual([{ projectId: "p1", url: LINK }]);
    expect(dockTabs()).toContain("Tarayıcı");
    // The engine announces the change (the fake one does not by itself); the panel then shows the browser
    // running, the link's tab in front.
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));
    await flush();
    const active = browserSection()!.querySelector('.kp-browser__tab-select[aria-pressed="true"]');
    expect(active?.textContent).toBe(LINK);
    expect(external).toEqual([]);
    expect(local).toEqual([]);
  });

  it("a panel the user closed in this project's layout is opened again for the link", async () => {
    const client = await setup();
    await select("Alfa");
    menuToggle("Tarayıcı");
    await flush();
    expect(dockTabs()).not.toContain("Tarayıcı");
    expect(menuChecked("Tarayıcı")).toBe(false);
    await activate(linksOf("tp1"));
    expect(client.callsOf("browser.openUrl")).toHaveLength(1);
    expect(dockTabs()).toContain("Tarayıcı");
    expect(menuChecked("Tarayıcı")).toBe(true);
  });

  it("a card's terminal uses the card's project browser", async () => {
    const client = await setup();
    await select("Kart A");
    await activate(linksOf("ta1"));
    expect(client.callsOf("browser.openUrl")).toEqual([{ projectId: "p1", url: LINK }]);
    expect(dockTabs()).toContain("Tarayıcı");
  });

  it("the terminal's own project decides, not the selection: a link of Alfa asked while Beta is on screen opens in Alfa's browser and leaves Beta's layout alone", async () => {
    const client = await setup();
    await select("Alfa");
    const alfa = linksOf("tp1");
    await select("Beta");
    menuToggle("Tarayıcı");
    await flush();
    expect(dockTabs()).not.toContain("Tarayıcı");
    await activate(alfa);
    expect(client.callsOf("browser.openUrl")).toEqual([{ projectId: "p1", url: LINK }]);
    // Beta's panel would show Beta's browser: it is not brought up for Alfa's link.
    expect(dockTabs()).not.toContain("Tarayıcı");
    expect((await client.request("browser.tabs", { projectId: "p2" })).browser.running).toBe(false);
    expect((await client.request("browser.tabs", { projectId: "p1" })).browser.tabs.map((t) => t.url)).toEqual([LINK]);
  });

  it("the default-browser escape hatch never asks the engine", async () => {
    const client = await setup();
    await select("Alfa");
    await activate(linksOf("tp1"), "external");
    expect(external).toEqual([LINK]);
    expect(client.callsOf("browser.openUrl")).toEqual([]);
  });

  it("a project whose browser runs on this machine: its local profile Chrome gets the link", async () => {
    const client = await setup();
    await select("İstemci");
    await activate(linksOf("tpc"));
    expect(local).toEqual([["pc", LINK]]);
    expect(client.callsOf("browser.openUrl")).toEqual([]);
    expect(external).toEqual([]);
  });

  it("an SSH project: the default browser", async () => {
    const client = await setup();
    await select("Uzak");
    await activate(linksOf("tps"));
    expect(external).toEqual([LINK]);
    expect(client.callsOf("browser.openUrl")).toEqual([]);
    expect(local).toEqual([]);
  });

  it("nothing but http(s) leaves the workbench, whatever the project", async () => {
    const client = await setup();
    for (const [name, terminal] of [
      ["Alfa", "tp1"],
      ["İstemci", "tpc"],
      ["Uzak", "tps"],
    ] as const) {
      await select(name);
      for (const url of ["javascript:alert(1)", "file:///etc/passwd", "vscode://file/x", "kokpit-test-scheme://calistir", "mailto:a@b.example"]) {
        for (const where of ["project", "external"] as const) await expect(linksOf(terminal).open(url, where)).rejects.toThrow();
      }
    }
    expect(client.callsOf("browser.openUrl")).toEqual([]);
    expect(external).toEqual([]);
    expect(local).toEqual([]);
  });

  it("an engine refusal reaches the terminal as a message and does not bring the panel up", async () => {
    const client = await setup();
    await select("Alfa");
    menuToggle("Tarayıcı");
    await flush();
    client.fail("browser.openUrl", "INVALID", "En fazla 50 sekme açılabilir");
    await expect(linksOf("tp1").open(LINK, "project")).rejects.toThrow("Bağlantı açılamadı: En fazla 50 sekme açılabilir");
    await flush();
    expect(dockTabs()).not.toContain("Tarayıcı");
  });
});
