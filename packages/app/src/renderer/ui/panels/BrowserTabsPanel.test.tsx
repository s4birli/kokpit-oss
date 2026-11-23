// Adım 7 İş B: the Tarayıcı panel as a layout PanelDefinition — Chrome's tabs as a tab strip (select / + / ×),
// updates from browser.changed, and the active tab persisted through ctx.state.
import type { BrowserState, Project } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUiConfig } from "../config.ts";
import type { PanelContext, PanelStateStore } from "../layout/contract.ts";
import { FakeEngineClient, makeCard, makeProject } from "../test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "../test-utils/fake-view.ts";
import { browserPanel } from "./BrowserTabsPanel.tsx";

const flush = () => act(async () => {});

class MemoryState implements PanelStateStore {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    const v = this.data.get(key);
    // Round-trip through JSON like the host's userData store.
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
  }
  set(key: string, value: unknown): void {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

function tabsState(n: number, active = 1): BrowserState {
  return {
    running: true,
    tabs: Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, title: `Sayfa ${i + 1}`, url: `https://ornek.test/${i + 1}` })),
    activeTabId: `T${active}`,
  };
}

function ctxFor(client: FakeEngineClient, project: Project | null, state: PanelStateStore): PanelContext {
  return {
    client,
    config: defaultUiConfig,
    createView: makeFakeViewFactory().factory,
    project,
    card: null,
    state,
    reveal: () => {},
    select: () => {},
  };
}

function setup(opts: { tabs?: BrowserState; state?: MemoryState; project?: Project } = {}) {
  const project = opts.project ?? makeProject("p1", "Alfa");
  const client = new FakeEngineClient({ projects: [project] });
  if (opts.tabs) client.browser.running.set("p1", opts.tabs);
  const state = opts.state ?? new MemoryState();
  const utils = render(browserPanel.render(ctxFor(client, project, state)));
  return { client, project, state, ...utils };
}

const strip = () => screen.getByRole("group", { name: "Sekmeler" });

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("browserPanel definition", () => {
  it("is the Tarayıcı panel, available whenever a project is selected (also with a card)", () => {
    expect(browserPanel.id).toBe("browser");
    expect(browserPanel.title).toBe("Tarayıcı");
    expect(browserPanel.available({ project: null, card: null })).toBe(false);
    const p = makeProject("p1");
    expect(browserPanel.available({ project: p, card: null })).toBe(true);
    expect(browserPanel.available({ project: p, card: makeCard("c1", "p1") })).toBe(true);
  });

  it("without a project it renders a note instead of a browser", () => {
    const client = new FakeEngineClient({});
    render(browserPanel.render(ctxFor(client, null, new MemoryState())));
    expect(screen.getByText(/proje seçin/i)).toBeTruthy();
    expect(client.callsOf("browser.tabs")).toEqual([]);
  });
});

describe("BrowserTabsPanel: tab strip", () => {
  it("shows every Chrome tab above the address bar: title, URL tooltip, active highlighted", async () => {
    setup({ tabs: tabsState(12, 3) });
    await flush();
    const tabs = within(strip()).getAllByRole("button", { name: /^Sayfa \d+$/ });
    expect(tabs).toHaveLength(12);
    expect(tabs[0]!.getAttribute("title")).toBe("https://ornek.test/1");
    expect(tabs.filter((t) => t.getAttribute("aria-pressed") === "true").map((t) => t.textContent)).toEqual(["Sayfa 3"]);
    // Strip comes before the address bar in the document.
    const address = screen.getByLabelText("Adres");
    expect(strip().compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Kept: Uzantılar, back/forward/reload. The profile is the project's own — the project tab names it.
    expect(screen.queryByText(/profil/i)).toBeNull();
    for (const name of ["Uzantılar", "Geri", "İleri", "Yenile", "Yeni sekme"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("a tab without a title shows its URL, a blank one 'Yeni sekme'", async () => {
    setup({
      tabs: {
        running: true,
        tabs: [
          { id: "A", title: "", url: "https://yalniz-adres.test/" },
          { id: "B", title: "", url: "" },
        ],
        activeTabId: "A",
      },
    });
    await flush();
    expect(within(strip()).getByRole("button", { name: "https://yalniz-adres.test/" })).toBeTruthy();
    expect(within(strip()).getAllByRole("button", { name: "Yeni sekme" }).length).toBeGreaterThanOrEqual(1);
  });

  it("updates from browser.changed (new tab, closed tab, new title)", async () => {
    const { client } = setup({ tabs: tabsState(2) });
    await flush();
    client.browser.running.set("p1", {
      running: true,
      tabs: [
        { id: "T2", title: "Değişti", url: "https://ornek.test/2" },
        { id: "T9", title: "Dışarıdan açıldı", url: "https://ornek.test/9" },
      ],
      activeTabId: "T9",
    });
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));
    await flush();
    const names = within(strip())
      .getAllByRole("button", { pressed: false })
      .concat(within(strip()).getAllByRole("button", { pressed: true }))
      .map((b) => b.textContent);
    expect(names).toContain("Değişti");
    expect(names).toContain("Dışarıdan açıldı");
    expect(within(strip()).queryByRole("button", { name: "Sayfa 1" })).toBeNull();
    expect(within(strip()).getByRole("button", { name: "Dışarıdan açıldı" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("click selects, + opens a new tab, × closes that tab", async () => {
    const { client } = setup({ tabs: tabsState(3) });
    await flush();
    fireEvent.click(within(strip()).getByRole("button", { name: "Sayfa 2" }));
    await flush();
    expect(client.callsOf("browser.selectTab")).toEqual([{ projectId: "p1", tabId: "T2" }]);
    expect(within(strip()).getByRole("button", { name: "Sayfa 2" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Yeni sekme" }));
    await flush();
    expect(client.callsOf("browser.newTab")).toEqual([{ projectId: "p1" }]);
    expect(within(strip()).getAllByRole("button", { name: /^(Sayfa \d+|about:blank)$/ })).toHaveLength(4);

    fireEvent.click(within(strip()).getByRole("button", { name: "Sekmeyi kapat: Sayfa 1" }));
    await flush();
    expect(client.callsOf("browser.closeTab")).toEqual([{ projectId: "p1", tabId: "T1" }]);
    expect(within(strip()).queryByRole("button", { name: "Sayfa 1" })).toBeNull();
    // The × of a tab does not also select it.
    expect(client.callsOf("browser.selectTab")).toHaveLength(1);
  });

  it("closing the last tab leaves the engine's blank tab in the strip", async () => {
    const { client } = setup({ tabs: tabsState(1) });
    await flush();
    fireEvent.click(within(strip()).getByRole("button", { name: "Sekmeyi kapat: Sayfa 1" }));
    await flush();
    expect(client.callsOf("browser.closeTab")).toHaveLength(1);
    const left = within(strip()).getAllByRole("button", { pressed: true });
    expect(left.map((b) => b.textContent)).toEqual(["about:blank"]);
  });

  /** The strip's tab ids (the DOM carries them, so a tab can be told from another with the same title), in order. */
  const stripIds = () => Array.from(strip().querySelectorAll(".kp-browser__tab"), (el) => el.getAttribute("data-tab-id"));
  const closeOf = (id: string) => strip().querySelector(`.kp-browser__tab[data-tab-id="${id}"] .kp-browser__tab-close`)!;

  it("one click on × closes exactly that tab, also when the strip re-renders under the pointer before the answer", async () => {
    const { client } = setup({ tabs: tabsState(5, 2) });
    await flush();
    expect(stripIds()).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    const release = client.hold(["browser.closeTab"]);
    fireEvent.click(closeOf("T2"));
    await flush();
    // The engine is half-way (the neighbour is active, the closing tab still listed) and says so; the panel
    // refetches and renders again — the pointer has not moved and no new click happened.
    client.browser.running.set("p1", tabsState(5, 3));
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));
    await flush();
    expect(stripIds()).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    release();
    await flush();
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));
    await flush();
    expect(client.callsOf("browser.closeTab")).toEqual([{ projectId: "p1", tabId: "T2" }]);
    expect(stripIds()).toEqual(["T1", "T3", "T4", "T5"]);
    expect(client.callsOf("browser.selectTab")).toEqual([]);
  });

  it("only a click closes: the button that slides under the pointer gets the release of the same press, and stays", async () => {
    const { client } = setup({ tabs: tabsState(4, 4) });
    await flush();
    const first = closeOf("T1");
    fireEvent.pointerDown(first);
    fireEvent.mouseDown(first);
    fireEvent.pointerUp(first);
    fireEvent.mouseUp(first);
    fireEvent.click(first);
    await flush();
    expect(stripIds()).toEqual(["T2", "T3", "T4"]);
    // T2's × is now where T1's was. A late release, a hover, a press without release: none of them is a click.
    const slid = closeOf("T2");
    fireEvent.pointerUp(slid);
    fireEvent.mouseUp(slid);
    fireEvent.mouseOver(slid);
    fireEvent.mouseMove(slid);
    fireEvent.pointerDown(slid);
    fireEvent.mouseDown(slid);
    await flush();
    expect(client.callsOf("browser.closeTab")).toEqual([{ projectId: "p1", tabId: "T1" }]);
    expect(stripIds()).toEqual(["T2", "T3", "T4"]);
  });

  it("closing tab after tab: each click removes one tab, and the blank one appears only after the last", async () => {
    const { client } = setup({ tabs: tabsState(6, 3) });
    await flush();
    for (let left = 6; left >= 1; left--) {
      const ids = stripIds();
      expect(ids).toHaveLength(left);
      fireEvent.click(closeOf(ids[0]!));
      await flush();
      const after = stripIds();
      if (left > 1) expect(after).toEqual(ids.slice(1));
      else expect(after).toHaveLength(1);
      expect(client.callsOf("browser.closeTab")).toHaveLength(6 - left + 1);
    }
    expect(client.callsOf("browser.closeTab").map((c) => c.tabId)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
    expect(within(strip()).getAllByRole("button", { pressed: true }).map((b) => b.textContent)).toEqual(["about:blank"]);
  });

  it("an engine error on + (tab limit) is shown", async () => {
    const { client } = setup({ tabs: tabsState(2) });
    client.fail("browser.newTab", "INVALID", "En fazla 50 sekme açılabilir");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Yeni sekme" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("En fazla 50 sekme");
  });

  it("monkey: rapid clicks on many tabs only request known tab ids; a hostile title is shown as text", async () => {
    const hostile = tabsState(10);
    hostile.tabs[4] = { id: "T5", title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)" };
    const { client, container } = setup({ tabs: hostile });
    await flush();
    expect(container.querySelector("img")).toBeNull();
    const buttons = within(strip()).getAllByRole("button");
    for (let i = 0; i < 50; i++) fireEvent.click(buttons[(i * 7) % buttons.length]!);
    await flush();
    const known = new Set(hostile.tabs.map((t) => t.id));
    for (const c of client.callsOf("browser.selectTab")) expect(known.has(c.tabId)).toBe(true);
    for (const c of client.callsOf("browser.closeTab")) expect(known.has(c.tabId)).toBe(true);
  });
});

describe("BrowserTabsPanel: active tab persisted through ctx.state", () => {
  it("round-trip: the selected tab is stored; after a remount it is selected again", async () => {
    const state = new MemoryState();
    const first = setup({ tabs: tabsState(5, 1), state });
    await flush();
    fireEvent.click(within(strip()).getByRole("button", { name: "Sayfa 4" }));
    await flush();
    expect(state.get("activeTab")).toEqual({ tabId: "T4", url: "https://ornek.test/4" });
    first.unmount();

    // Something else (another client, an agent) made T1 active meanwhile.
    const client = new FakeEngineClient({ projects: [first.project] });
    client.browser.running.set("p1", tabsState(5, 1));
    render(browserPanel.render(ctxFor(client, first.project, state)));
    await flush();
    expect(client.callsOf("browser.selectTab")).toEqual([{ projectId: "p1", tabId: "T4" }]);
    expect(within(strip()).getByRole("button", { name: "Sayfa 4" }).getAttribute("aria-pressed")).toBe("true");
    expect(state.get("activeTab")).toEqual({ tabId: "T4", url: "https://ornek.test/4" });
  });

  it("falls back to the URL when the tab id is gone (Chrome restarted)", async () => {
    const state = new MemoryState();
    state.set("activeTab", { tabId: "eski", url: "https://ornek.test/3" });
    const { client } = setup({ tabs: tabsState(4, 1), state });
    await flush();
    expect(client.callsOf("browser.selectTab")).toEqual([{ projectId: "p1", tabId: "T3" }]);
  });

  it("neither id nor URL exists any more: nothing is selected, the stored value follows the real active tab", async () => {
    const state = new MemoryState();
    state.set("activeTab", { tabId: "eski", url: "https://yok.test/" });
    const { client } = setup({ tabs: tabsState(3, 2), state });
    await flush();
    expect(client.callsOf("browser.selectTab")).toEqual([]);
    expect(state.get("activeTab")).toEqual({ tabId: "T2", url: "https://ornek.test/2" });
  });

  it("stored value already active: no extra select request", async () => {
    const state = new MemoryState();
    state.set("activeTab", { tabId: "T2", url: "https://ornek.test/2" });
    const { client } = setup({ tabs: tabsState(3, 2), state });
    await flush();
    expect(client.callsOf("browser.selectTab")).toEqual([]);
  });

  it("monkey: a malformed stored value is ignored", async () => {
    for (const bad of [null, 42, "T1", { tabId: 7 }, { url: {} }, []]) {
      const state = new MemoryState();
      state.set("activeTab", bad);
      const { client, unmount } = setup({ tabs: tabsState(3, 2), state });
      await flush();
      expect(client.callsOf("browser.selectTab"), JSON.stringify(bad)).toEqual([]);
      unmount();
    }
  });

  it("browser closed at mount: restored when the user opens it", async () => {
    const state = new MemoryState();
    state.set("activeTab", { tabId: "x", url: "https://ornek.test/2" });
    const project = makeProject("p1", "Alfa");
    const client = new FakeEngineClient({ projects: [project] });
    client.respond("browser.open", () => {
      client.browser.running.set("p1", tabsState(3, 1));
      return { browser: tabsState(3, 1) };
    });
    render(browserPanel.render(ctxFor(client, project, state)));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Tarayıcıyı aç" }));
    await flush();
    expect(client.callsOf("browser.selectTab")).toEqual([{ projectId: "p1", tabId: "T2" }]);
  });
});
