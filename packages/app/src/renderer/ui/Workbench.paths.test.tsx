// Yollar inside the workbench: a file path a terminal printed opens where its kind says — a page in THAT
// terminal's project browser (the Tarayıcı panel comes up), a file of the project in Dosyalar (selected, large) —
// and `open` run inside a terminal brings the Tarayıcı panel up too. The terminal renderer is a fake: "the user
// activated a path" is the call a real terminal makes after a ⌘ click (terminal-links.test.ts).
import type { FileLocation } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import { FakeEngineClient, makeCard, makeProject, makeProjectTerminal, makeSshProject, makeTerminal } from "./test-utils/fake-client.ts";
import { fakeUiStateBridge } from "./test-utils/fake-ui-state.ts";
import { FakeResizeObserver, makeFakeViewFactory, type FakeViewFactory } from "./test-utils/fake-view.ts";
import { defaultLayoutConfig } from "./layout/config.ts";
import { isDockTab } from "./test-utils/terminal-tabs.ts";
import { menuToggle } from "./test-utils/fake-menu.ts";
import type { TerminalPathHost } from "./link-opener.ts";
import { linksConfig } from "../engine/links-ipc.ts";

const flush = () => act(async () => {});
const REPORT = "~/Documents/Acme-ux-2026-11-05/index.html";
const PAGE: FileLocation = { path: "/Users/ada/Documents/Acme-ux-2026-11-05/index.html", kind: "page", browser: true };
const SOURCE: FileLocation = { path: "/p1/src/derin/app.ts", kind: "file", rootPath: "src/derin/app.ts", browser: false };
const FOLDER: FileLocation = { path: "/p1/src/derin", kind: "dir", rootPath: "src/derin", browser: false };
const CARD_SOURCE: FileLocation = { path: "/w/a/src/derin/app.ts", kind: "file", rootPath: "src/derin/app.ts", cardId: "a", browser: false };
const HIDDEN: FileLocation = { path: "/Users/ada/.ssh/a.html", kind: "page", browser: false, browserRefusal: "Gizli (noktayla başlayan) klasör ve dosyalar önizlenmez" };

function seed() {
  const client = new FakeEngineClient({
    projects: [makeProject("p1", "Alfa"), makeProject("p2", "Beta"), makeProject("pc", "İstemci", { browser: { runOn: "client" } }), makeSshProject("ps", "Uzak", "h1")],
    cards: [makeCard("a", "p1", "Kart A")],
    terminals: [makeProjectTerminal("tp1", "p1", "P-1"), makeProjectTerminal("tp2", "p2", "P-2"), makeProjectTerminal("tpc", "pc", "PC-1"), makeProjectTerminal("tps", "ps", "PS-1"), makeTerminal("ta1", "a", "A-1", "p1")],
    files: { "README.md": "# Alfa\n", "src/derin/app.ts": "export const a = 1;\n", "src/derin/b.ts": "b\n" },
  });
  client.files.locations = { [REPORT]: PAGE, "src/derin/app.ts": SOURCE, "src/derin": FOLDER, "kart/app.ts": CARD_SOURCE, "~/.ssh/a.html": HIDDEN };
  client.browser.fileProjects = { tp1: "p1", tp2: "p2", ta1: "p1" };
  return client;
}

let views: FakeViewFactory;
let local: [string, string | undefined][];
const config = { ...defaultLayoutConfig, saveDebounceMs: 5 };

async function setup(client = seed()) {
  views = makeFakeViewFactory();
  render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} uiState={fakeUiStateBridge()} layoutConfig={config} engineUrl="ws://100.64.0.7:7420" />);
  await flush();
  return client;
}

const rail = () => screen.getByRole("navigation");
const dockTabs = () => screen.queryAllByRole("tab").filter(isDockTab).map((t) => t.getAttribute("aria-label"));
const pathsOf = (terminalId: string): TerminalPathHost => {
  const view = views.views.find((v) => !v.disposed && v.container?.closest(`[data-terminal-id="${terminalId}"]`));
  if (!view?.links?.path) throw new Error(`terminal ${terminalId} has no path host`);
  return view.links.path;
};
async function select(name: string) {
  fireEvent.click(within(rail()).getByRole("button", { name }));
  await flush();
}
/** What a ⌘ click on a path in that terminal ends in; the message when it is refused. */
async function activate(host: TerminalPathHost, path: string, how: "auto" | "browser" | "files" = "auto"): Promise<string | null> {
  let refusal: string | null = null;
  await act(async () => {
    await host.open({ path, tail: "" }, how).catch((err: unknown) => {
      refusal = (err as Error).message;
    });
  });
  await flush();
  await flush();
  return refusal;
}
const filesPanel = () => screen.queryByRole("region", { name: "Dosyalar" });
const preview = () => within(filesPanel()!).queryByRole("region", { name: "Önizleme" });

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  local = [];
  vi.stubGlobal("kokpit", {
    links: { openExternal: async () => {}, menu: async () => null },
    browser: { openLocal: async (projectId: string, url?: string) => void local.push([projectId, url]) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Yollar: terminaldeki dosya yolu", () => {
  it("the user's case: the page opens in the terminal's project browser and the Tarayıcı panel comes up — also when it was closed", async () => {
    const client = await setup();
    await select("Alfa");
    menuToggle("Tarayıcı");
    await flush();
    expect(dockTabs()).not.toContain("Tarayıcı");
    expect(await activate(pathsOf("tp1"), REPORT)).toBeNull();
    expect(client.callsOf("files.locate")).toEqual([{ terminalId: "tp1", path: REPORT }]);
    expect(client.callsOf("browser.openFile")).toEqual([{ terminalId: "tp1", path: REPORT }]);
    expect(dockTabs()).toContain("Tarayıcı");
    const tabs = (await client.request("browser.tabs", { projectId: "p1" })).browser.tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.url).toMatch(/\/files\/preview\/[^/]+\/index\.html$/);
    expect(local).toEqual([]);
  });

  it("a file of the project opens in Dosyalar: its folders open, the file is selected and shown large; Esc brings the panel back", async () => {
    const client = await setup();
    await select("Alfa");
    expect(await activate(pathsOf("tp1"), "src/derin/app.ts")).toBeNull();
    expect(client.callsOf("browser.openFile")).toEqual([]);
    expect(dockTabs()).toContain("Dosyalar");
    const tree = within(filesPanel()!).getByRole("list", { name: "Dosya ağacı" });
    expect(within(tree).getByRole("button", { name: "src" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(tree).getByRole("button", { name: "derin" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(tree).getByRole("button", { name: "app.ts" }).getAttribute("aria-current")).toBe("true");
    expect(preview()!.classList.contains("kp-files__preview--large")).toBe(true);
    expect(preview()!.querySelector("code")!.textContent).toBe("export const a = 1;\n");
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(preview()!.classList.contains("kp-files__preview--large")).toBe(false);
  });

  it("the menu's “Dosyalar'da göster” on a folder opens it in the tree and selects nothing", async () => {
    await setup();
    await select("Alfa");
    expect(await activate(pathsOf("tp1"), "src/derin", "files")).toBeNull();
    const tree = within(filesPanel()!).getByRole("list", { name: "Dosya ağacı" });
    expect(within(tree).getByRole("button", { name: "derin" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(tree).getByRole("button", { name: "b.ts" })).toBeTruthy();
    expect(preview()).toBeNull();
  });

  it("a card's terminal shows the card's file in the card's Dosyalar", async () => {
    await setup();
    await select("Kart A");
    expect(await activate(pathsOf("ta1"), "kart/app.ts")).toBeNull();
    expect(preview()!.classList.contains("kp-files__preview--large")).toBe(true);
    expect(within(filesPanel()!).getByRole("button", { name: "app.ts" }).getAttribute("aria-current")).toBe("true");
  });

  it("the terminal's own project decides: a file of Alfa asked while Beta is on screen is not shown in Beta's Dosyalar", async () => {
    const client = await setup();
    await select("Alfa");
    const alfa = pathsOf("tp1");
    await select("Beta");
    expect(await activate(alfa, "src/derin/app.ts")).toContain("ekranda olmayan bir projede");
    expect(preview()).toBeNull();
    // A page of Alfa still opens in Alfa's browser, and Beta's layout is left alone.
    menuToggle("Tarayıcı");
    await flush();
    // Two requests in a row are a double click to the opener: the second one comes a moment later.
    await act(async () => void (await new Promise((r) => setTimeout(r, linksConfig.rate.minIntervalMs + 20))));
    expect(await activate(alfa, REPORT)).toBeNull();
    expect(dockTabs()).not.toContain("Tarayıcı");
    expect((await client.request("browser.tabs", { projectId: "p2" })).browser.running).toBe(false);
    expect((await client.request("browser.tabs", { projectId: "p1" })).browser.running).toBe(true);
  });

  it("a refused or missing path opens nothing and says why", async () => {
    const client = await setup();
    await select("Alfa");
    expect(await activate(pathsOf("tp1"), "~/.ssh/a.html")).toContain("Gizli");
    expect(await activate(pathsOf("tp1"), "~/yok/index.html")).toBe("Dosya bulunamadı");
    expect(client.callsOf("browser.openFile")).toEqual([]);
    expect((await client.request("browser.tabs", { projectId: "p1" })).browser.running).toBe(false);
  });

  it("browser on this machine: the preview address is joined to the engine's and handed to the local Chrome", async () => {
    const client = await setup();
    await select("İstemci");
    expect(await activate(pathsOf("tpc"), REPORT)).toBeNull();
    expect(client.callsOf("browser.openFile")).toEqual([]);
    expect(local).toHaveLength(1);
    expect(local[0]![0]).toBe("pc");
    expect(local[0]![1]).toMatch(/^http:\/\/100\.64\.0\.7:7420\/files\/preview\/[^/]+\/index\.html$/);
  });

  it("SSH project: nothing is asked of the engine and nothing opens", async () => {
    const client = await setup();
    await select("Uzak");
    expect(await activate(pathsOf("tps"), REPORT)).toContain("uzak sunucuda");
    expect(client.callsOf("files.locate")).toEqual([]);
    expect(client.callsOf("browser.openFile")).toEqual([]);
  });
});

describe("Yollar: terminalde çalışan open", () => {
  it("the engine's “show the browser” brings the Tarayıcı panel up for the project on screen — not for another one", async () => {
    const client = await setup();
    await select("Alfa");
    menuToggle("Tarayıcı");
    await flush();
    act(() => client.emitEvent({ type: "event", name: "browser.reveal", projectId: "p2" }));
    await flush();
    expect(dockTabs()).not.toContain("Tarayıcı");
    act(() => client.emitEvent({ type: "event", name: "browser.reveal", projectId: "p1" }));
    await flush();
    expect(dockTabs()).toContain("Tarayıcı");
  });
});
