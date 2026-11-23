import type { Card, Project, TerminalInfo } from "@kokpit/shared";
import { t as msg } from "../../../i18n/index.ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUiConfig } from "../config.ts";
import type { PanelContext, PanelStateStore } from "../layout/contract.ts";
import {
  FakeEngineClient,
  makeCard,
  makeProject,
  makeProjectTerminal,
  makeTerminal,
  makeTool,
} from "../test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory, type FakeTerminalView } from "../test-utils/fake-view.ts";
import { PREFS_KEY } from "./terminal-tabs.ts";
import { terminalsPanel, TerminalsPanel } from "./TerminalsPanel.tsx";
import { clipboardConfig } from "../../engine/clipboard-ipc.ts";

const flush = () => act(async () => {});
const MONKEY_STEPS = 120;
/** Generous: the full suite runs many jsdom files in parallel. */
const MONKEY_TIMEOUT_MS = 30_000;

/** Like the host's store: JSON in, JSON out. */
class FakeStore implements PanelStateStore {
  readonly data = new Map<string, string>();
  sets = 0;
  get<T>(key: string): T | undefined {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  set(key: string, value: unknown): void {
    this.sets++;
    this.data.set(key, JSON.stringify(value));
  }
}

const P1 = makeProject("p1", "Acme");

interface SetupOpts {
  terminals?: TerminalInfo[];
  project?: Project | null;
  card?: Card | null;
  store?: FakeStore;
  client?: FakeEngineClient;
}

function setup(opts: SetupOpts = {}) {
  const client = opts.client ?? new FakeEngineClient({ projects: [P1], terminals: opts.terminals ?? [] });
  const views = makeFakeViewFactory();
  const store = opts.store ?? new FakeStore();
  const reveal = vi.fn();
  const select = vi.fn();
  const base: PanelContext = {
    client,
    config: defaultUiConfig,
    createView: views.factory,
    project: opts.project === undefined ? P1 : opts.project,
    card: opts.card ?? null,
    state: store,
    reveal,
    select,
    focus: null,
  };
  const utils = render(<TerminalsPanel ctx={base} />);
  const rerender = (patch: Partial<PanelContext>) => utils.rerender(<TerminalsPanel ctx={{ ...base, ...patch }} />);
  return { ...utils, client, views, store, reveal, select, ctx: base, rerender };
}

/** The view showing a terminal (found through its TerminalPanel's data attribute). */
function viewOf(views: FakeTerminalView[], terminalId: string): FakeTerminalView {
  const live = views.filter((v) => !v.disposed && v.container?.closest(`[data-terminal-id="${terminalId}"]`));
  expect(live).toHaveLength(1);
  return live[0]!;
}

const tab = (name: string | RegExp) => screen.getByRole("tab", { name });
const tabNames = () => screen.queryAllByRole("tab").map((t) => t.getAttribute("data-title"));
const selected = () => screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
const pane = (terminalId: string) =>
  document.querySelector(`[data-terminal-id="${terminalId}"]`)!.closest("[role=tabpanel]") as HTMLElement;
const visible = (terminalId: string) => pane(terminalId).getAttribute("data-pane") !== "hidden";

async function openViaMenu(command?: string) {
  fireEvent.click(screen.getByRole("button", { name: "+ Yeni terminal ▾" }));
  const menu = screen.getByRole("group", { name: "Yeni terminal" });
  if (command !== undefined) {
    fireEvent.change(within(menu).getByLabelText("Başlangıç komutu"), { target: { value: command } });
  }
  fireEvent.click(within(menu).getByRole("button", { name: "Yeni terminal" }));
  await flush();
}

async function confirmClose(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `${name} sekmesini kapat` }));
  fireEvent.click(screen.getByRole("button", { name: "Kapatmayı onayla" }));
  await flush();
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("terminalsPanel definition", () => {
  it("is the 'terminals' panel; without a selection it asks for one", () => {
    expect(terminalsPanel.id).toBe("terminals");
    expect(terminalsPanel.title).toBe("Terminal");
    expect(terminalsPanel.available({ project: null, card: null })).toBe(true);
    expect(terminalsPanel.available({ project: P1, card: null })).toBe(true);
  });
});

describe("TerminalsPanel", () => {
  it("asks for a selection when there is no project", () => {
    setup({ project: null });
    expect(screen.getByText("Soldan bir proje ya da kart seç.")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows one tab per terminal of the project, the first one active", async () => {
    setup({ terminals: [makeProjectTerminal("t1", "p1", "kabuk"), makeProjectTerminal("t2", "p1", "claude")] });
    await flush();
    expect(tabNames()).toEqual(["kabuk", "claude"]);
    expect(selected().map((t) => t.getAttribute("data-title"))).toEqual(["kabuk"]);
    // Kopyalama: right click on a tab offers the terminal's command; the tooltip names the selection modifier.
    expect(Array.from(document.querySelectorAll('[role="tab"]'), (t) => t.getAttribute("data-copy"))).toEqual(["kabuk", "claude"]);
    expect(selected()[0]!.getAttribute("title")).toContain(msg("terminal.clipboard.selectionHint"));
    expect(visible("t1")).toBe(true);
    expect(visible("t2")).toBe(false);
  });

  it("lists a card's terminals when a card is selected", async () => {
    const card = makeCard("c1", "p1", "özellik");
    setup({
      card,
      terminals: [makeTerminal("ct", "c1", "kart kabuğu", "p1"), makeProjectTerminal("pt", "p1", "proje kabuğu")],
    });
    await flush();
    expect(tabNames()).toEqual(["kart kabuğu"]);
  });

  it("opening two terminals from the menu gives two tabs, the newest active", async () => {
    const { client } = setup();
    await flush();
    expect(screen.getByText("Bu projede terminal yok.")).toBeTruthy();
    await openViaMenu("echo bir");
    await openViaMenu("echo iki");
    expect(tabNames()).toEqual(["echo bir", "echo iki"]);
    expect(selected()[0]!.getAttribute("data-title")).toBe("echo iki");
    expect(client.callsOf("terminal.open")).toEqual([
      { projectId: "p1", ...defaultUiConfig.fallbackDims, command: "echo bir" },
      { projectId: "p1", ...defaultUiConfig.fallbackDims, command: "echo iki" },
    ]);
    expect(screen.queryByRole("group", { name: "Yeni terminal" })).toBeNull();
  });

  it("a terminal opened from the menu goes after the tabs already there", async () => {
    setup({ terminals: [makeProjectTerminal("t1", "p1", "kabuk"), makeProjectTerminal("t2", "p1", "claude")] });
    await flush();
    await openViaMenu("echo son");
    expect(tabNames()).toEqual(["kabuk", "claude", "echo son"]);
    expect(selected().map((t) => t.getAttribute("data-title"))).toEqual(["echo son"]);
  });

  it("the menu preselects the default tool and opens a card terminal in the card", async () => {
    const card = makeCard("c1", "p1");
    const client = new FakeEngineClient({
      projects: [P1],
      cards: [card],
      tools: [makeTool("claude", "Claude Code"), makeTool("codex", "Codex")],
      settings: { defaultToolId: "codex" },
    });
    setup({ client, card });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "+ Yeni terminal ▾" }));
    const menu = screen.getByRole("group", { name: "Yeni terminal" });
    expect((within(menu).getByLabelText("Araç") as HTMLSelectElement).value).toBe("codex");
    fireEvent.click(within(menu).getByRole("button", { name: "Yeni terminal" }));
    await flush();
    expect(client.callsOf("terminal.open")).toEqual([{ cardId: "c1", ...defaultUiConfig.fallbackDims, toolId: "codex" }]);
    expect(tabNames()).toEqual(["codex-komutu"]);
  });

  it("an empty panel offers the launcher itself, with the default tool; it goes behind the menu once a terminal opens", async () => {
    const client = new FakeEngineClient({
      projects: [P1],
      tools: [makeTool("claude", "Claude Code"), makeTool("codex", "Codex")],
      settings: { defaultToolId: "codex" },
    });
    setup({ client });
    // Not before the engine answered: a project with terminals must not flash the launcher.
    expect(screen.queryByRole("group", { name: "Yeni terminal" })).toBeNull();
    await flush();
    const start = screen.getByRole("group", { name: "Yeni terminal" });
    expect(within(start).getByText("Bu projede terminal yok.")).toBeTruthy();
    expect((within(start).getByLabelText("Araç") as HTMLSelectElement).value).toBe("codex");
    const toggle = screen.getByRole("button", { name: "+ Yeni terminal ▾" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The button does not open a second launcher: it puts the focus in the one on screen.
    fireEvent.click(toggle);
    expect(screen.getAllByRole("group", { name: "Yeni terminal" })).toHaveLength(1);
    expect(document.activeElement).toBe(within(start).getByLabelText("Başlangıç komutu"));
    fireEvent.click(within(start).getByRole("button", { name: "Yeni terminal" }));
    await flush();
    expect(client.callsOf("terminal.open")).toEqual([{ projectId: "p1", ...defaultUiConfig.fallbackDims, toolId: "codex" }]);
    expect(tabNames()).toEqual(["codex-komutu"]);
    expect(screen.queryByRole("group", { name: "Yeni terminal" })).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("an empty card says so and opens the terminal in the card", async () => {
    const card = makeCard("c1", "p1");
    const { client } = setup({ card });
    await flush();
    const start = screen.getByRole("group", { name: "Yeni terminal" });
    expect(within(start).getByText("Bu kartta terminal yok.")).toBeTruthy();
    fireEvent.change(within(start).getByLabelText("Başlangıç komutu"), { target: { value: "echo kart" } });
    fireEvent.click(within(start).getByRole("button", { name: "Yeni terminal" }));
    await flush();
    expect(client.callsOf("terminal.open")).toEqual([{ cardId: "c1", ...defaultUiConfig.fallbackDims, command: "echo kart" }]);
  });

  it("an empty panel shows the engine's error next to its launcher", async () => {
    const { client } = setup();
    await flush();
    client.fail("terminal.open", "INVALID", "klasör yok");
    const start = screen.getByRole("group", { name: "Yeni terminal" });
    fireEvent.click(within(start).getByRole("button", { name: "Yeni terminal" }));
    await flush();
    expect(within(screen.getByRole("group", { name: "Yeni terminal" })).getByRole("alert").textContent).toBe("Terminal açılamadı: klasör yok");
    expect(tabNames()).toEqual([]);
  });

  it("Escape closes the menu", async () => {
    setup({ terminals: [makeProjectTerminal("t1", "p1", "kabuk")] });
    await flush();
    const toggle = screen.getByRole("button", { name: "+ Yeni terminal ▾" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(screen.getByRole("group", { name: "Yeni terminal" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Yeni terminal" })).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the engine's error when opening fails and keeps the menu open", async () => {
    const { client } = setup({ terminals: [makeProjectTerminal("t1", "p1", "kabuk")] });
    await flush();
    client.fail("terminal.open", "INVALID", "olmadı");
    await openViaMenu("x");
    expect(screen.getByRole("alert").textContent).toContain("olmadı");
    expect(screen.getByRole("group", { name: "Yeni terminal" })).toBeTruthy();
  });

  it("switching tabs never writes one terminal's output into another and keeps both attached", async () => {
    const { client, views } = setup({
      terminals: [makeProjectTerminal("t1", "p1", "A"), makeProjectTerminal("t2", "p1", "B")],
    });
    await flush();
    act(() => client.emitOutput("t1", "a1"));
    act(() => client.emitOutput("t2", "b1"));
    fireEvent.click(tab(/^B/));
    expect(visible("t2")).toBe(true);
    expect(visible("t1")).toBe(false);
    act(() => client.emitOutput("t1", "a2"));
    act(() => client.emitOutput("t2", "b2"));
    fireEvent.click(tab(/^A/));
    act(() => client.emitOutput("t1", "a3"));
    expect(viewOf(views.views, "t1").screen).toBe("a1a2a3");
    expect(viewOf(views.views, "t2").screen).toBe("b1b2");
    // No remount and no re-attach on switching: one view and one attach per terminal.
    expect(views.views).toHaveLength(2);
    expect(client.callsOf("terminal.attach").map((c) => c.terminalId).sort()).toEqual(["t1", "t2"]);
    // A replay replaces the screen instead of duplicating it.
    act(() => client.emitOutput("t2", "B-tümü", true));
    expect(viewOf(views.views, "t2").screen).toBe("B-tümü");
  });

  it("typed input goes to the terminal of the view it was typed in", async () => {
    const { client, views } = setup({
      terminals: [makeProjectTerminal("t1", "p1", "A"), makeProjectTerminal("t2", "p1", "B")],
    });
    await flush();
    fireEvent.click(tab(/^B/));
    viewOf(views.views, "t2").type("ls\r");
    expect(client.inputs).toEqual([{ terminalId: "t2", data: "ls\r" }]);
  });

  it("clicking a tab focuses its terminal", async () => {
    const { views } = setup({ terminals: [makeProjectTerminal("t1", "p1", "A"), makeProjectTerminal("t2", "p1", "B")] });
    await flush();
    fireEvent.click(tab(/^B/));
    expect(viewOf(views.views, "t2").focuses).toBe(1);
  });

  it("close asks for confirmation, calls terminal.close and activates the neighbour", async () => {
    const { client, views } = setup({
      terminals: [
        makeProjectTerminal("t1", "p1", "A"),
        makeProjectTerminal("t2", "p1", "B"),
        makeProjectTerminal("t3", "p1", "C"),
      ],
    });
    await flush();
    fireEvent.click(tab(/^B/));
    fireEvent.click(screen.getByRole("button", { name: "B sekmesini kapat" }));
    expect(client.callsOf("terminal.close")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Vazgeç" }));
    expect(screen.queryByRole("button", { name: "Kapatmayı onayla" })).toBeNull();
    await confirmClose("B");
    expect(client.callsOf("terminal.close")).toEqual([{ terminalId: "t2" }]);
    expect(tabNames()).toEqual(["A", "C"]);
    expect(selected()[0]!.getAttribute("data-title")).toBe("C");
    expect(views.views.filter((v) => v.disposed)).toHaveLength(1);
  });

  it("a failed close says so and keeps the tab", async () => {
    const { client } = setup({ terminals: [makeProjectTerminal("t1", "p1", "A")] });
    await flush();
    client.fail("terminal.close", "NOT_FOUND", "yok böyle");
    await confirmClose("A");
    expect(screen.getByRole("alert").textContent).toContain("yok böyle");
    expect(tabNames()).toEqual(["A"]);
  });

  it("böl shows two terminals side by side; the partner can be changed; off hides it again", async () => {
    setup({
      terminals: [
        makeProjectTerminal("t1", "p1", "A"),
        makeProjectTerminal("t2", "p1", "B"),
        makeProjectTerminal("t3", "p1", "C"),
      ],
    });
    await flush();
    const split = screen.getByRole("button", { name: "Böl" });
    expect(split.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(split);
    expect(split.getAttribute("aria-pressed")).toBe("true");
    expect(pane("t1").getAttribute("data-pane")).toBe("a");
    expect(pane("t2").getAttribute("data-pane")).toBe("b");
    expect(screen.getByRole("separator", { name: "Bölmeyi boyutlandır" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Yanındaki terminal"), { target: { value: "t3" } });
    expect(pane("t3").getAttribute("data-pane")).toBe("b");
    expect(visible("t2")).toBe(false);

    // Clicking the partner's tab swaps the panes.
    fireEvent.click(tab(/^C/));
    expect(pane("t3").getAttribute("data-pane")).toBe("a");
    expect(pane("t1").getAttribute("data-pane")).toBe("b");

    fireEvent.click(split);
    expect(screen.queryByRole("separator")).toBeNull();
    expect(visible("t1")).toBe(false);
    expect(visible("t3")).toBe(true);
  });

  it("böl is disabled with fewer than two terminals", async () => {
    setup({ terminals: [makeProjectTerminal("t1", "p1", "A")] });
    await flush();
    expect((screen.getByRole("button", { name: "Böl" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the divider resizes with the keyboard, within the configured bounds", async () => {
    setup({ terminals: [makeProjectTerminal("t1", "p1", "A"), makeProjectTerminal("t2", "p1", "B")] });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Böl" }));
    const sep = screen.getByRole("separator", { name: "Bölmeyi boyutlandır" });
    expect(sep.getAttribute("aria-valuenow")).toBe(String(defaultUiConfig.terminalSplitRatio * 100));
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(Number(sep.getAttribute("aria-valuenow"))).toBeCloseTo(
      (defaultUiConfig.terminalSplitRatio + defaultUiConfig.terminalSplitKeyStep) * 100,
    );
    for (let i = 0; i < 50; i++) fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(Number(sep.getAttribute("aria-valuenow"))).toBeCloseTo(defaultUiConfig.terminalSplitMinRatio * 100);
  });

  it("the divider follows the pointer", async () => {
    setup({ terminals: [makeProjectTerminal("t1", "p1", "A"), makeProjectTerminal("t2", "p1", "B")] });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Böl" }));
    const sep = screen.getByRole("separator", { name: "Bölmeyi boyutlandır" });
    const stage = sep.parentElement!;
    stage.getBoundingClientRect = () => ({ left: 100, width: 1000, top: 0, height: 500 }) as DOMRect;
    fireEvent.pointerDown(sep, { clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 400, pointerId: 1 });
    expect(Number(sep.getAttribute("aria-valuenow"))).toBeCloseTo(30);
    fireEvent.pointerMove(window, { clientX: 900, pointerId: 1 });
    expect(Number(sep.getAttribute("aria-valuenow"))).toBeCloseTo(30);
  });

  it("persists order, active tab and split partner, and restores them", async () => {
    const terminals = [
      makeProjectTerminal("t1", "p1", "A"),
      makeProjectTerminal("t2", "p1", "B"),
      makeProjectTerminal("t3", "p1", "C"),
    ];
    const store = new FakeStore();
    const first = setup({ terminals, store });
    await flush();
    // Drag C before A.
    fireEvent.dragStart(tab(/^C/));
    fireEvent.dragOver(tab(/^A/));
    fireEvent.drop(tab(/^A/));
    fireEvent.click(tab(/^B/));
    fireEvent.click(screen.getByRole("button", { name: "Böl" }));
    fireEvent.change(screen.getByLabelText("Yanındaki terminal"), { target: { value: "t1" } });
    expect(store.get(PREFS_KEY)).toEqual({ order: ["t3", "t1", "t2"], active: "t2", split: "t1", ratio: null });
    first.unmount();

    setup({ client: first.client, store });
    await flush();
    expect(tabNames()).toEqual(["C", "A", "B"]);
    expect(selected()[0]!.getAttribute("data-title")).toBe("B");
    expect(pane("t2").getAttribute("data-pane")).toBe("a");
    expect(pane("t1").getAttribute("data-pane")).toBe("b");
  });

  it("drops unknown ids on restore, but never before the list has loaded", async () => {
    const store = new FakeStore();
    store.set(PREFS_KEY, { order: ["gone", "t2", "t1"], active: "gone", split: "gone2", ratio: 0.3 });
    store.sets = 0;
    const client = new FakeEngineClient({
      projects: [P1],
      terminals: [makeProjectTerminal("t1", "p1", "A"), makeProjectTerminal("t2", "p1", "B")],
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    client.respond("terminals.list", async (params) => {
      await gate;
      return { terminals: client.terminals.filter((t) => t.projectId === params.projectId) };
    });
    setup({ client, store });
    await flush();
    expect(store.sets).toBe(0);
    release();
    await flush();
    expect(tabNames()).toEqual(["B", "A"]);
    expect(selected()[0]!.getAttribute("data-title")).toBe("B");
    expect(store.get(PREFS_KEY)).toEqual({ order: ["t2", "t1"], active: "t2", split: null, ratio: 0.3 });
  });

  it("survives a malformed stored value", async () => {
    const store = new FakeStore();
    store.data.set(PREFS_KEY, JSON.stringify({ order: "t1", active: 5, split: [], ratio: "yarım" }));
    setup({ store, terminals: [makeProjectTerminal("t1", "p1", "A")] });
    await flush();
    expect(tabNames()).toEqual(["A"]);
  });

  it("a focus request activates that tab and focuses its terminal, once per seq", async () => {
    const { rerender, views } = setup({
      terminals: [makeProjectTerminal("t1", "p1", "A"), makeProjectTerminal("t2", "p1", "B")],
    });
    await flush();
    rerender({ focus: { terminalId: "t2", seq: 1 } });
    expect(selected()[0]!.getAttribute("data-title")).toBe("B");
    expect(viewOf(views.views, "t2").focuses).toBe(1);
    fireEvent.click(tab(/^A/));
    rerender({ focus: { terminalId: "t2", seq: 1 } });
    expect(selected()[0]!.getAttribute("data-title")).toBe("A");
    rerender({ focus: { terminalId: "t2", seq: 2 } });
    expect(selected()[0]!.getAttribute("data-title")).toBe("B");
    expect(viewOf(views.views, "t2").focuses).toBe(2);
  });

  it("a focus request for a terminal that is not loaded yet applies when it arrives", async () => {
    const { client, rerender } = setup({ terminals: [makeProjectTerminal("t1", "p1", "A")] });
    await flush();
    rerender({ focus: { terminalId: "t9", seq: 1 } });
    expect(selected()[0]!.getAttribute("data-title")).toBe("A");
    client.terminals.push(makeProjectTerminal("t9", "p1", "Z"));
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1" }));
    await flush();
    expect(selected()[0]!.getAttribute("data-title")).toBe("Z");
  });

  it("terminals.changed adds and removes tabs", async () => {
    const { client } = setup({ terminals: [makeProjectTerminal("t1", "p1", "A")] });
    await flush();
    client.terminals.push(makeProjectTerminal("t2", "p1", "B"));
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1" }));
    await flush();
    expect(tabNames()).toEqual(["A", "B"]);
    client.terminals = client.terminals.filter((t) => t.id !== "t1");
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1" }));
    await flush();
    expect(tabNames()).toEqual(["B"]);
    expect(selected()[0]!.getAttribute("data-title")).toBe("B");
  });

  it("the tab dot follows terminal.activity and exit", async () => {
    const { client } = setup({
      terminals: [
        { ...makeProjectTerminal("t1", "p1", "A"), activity: { state: "idle", since: new Date(0).toISOString() } },
        makeProjectTerminal("t2", "p1", "B"),
      ],
    });
    await flush();
    expect(tab(/^A/).getAttribute("data-state")).toBe("idle");
    expect(tab(/^A/).textContent).toContain("boşta");
    expect(tab(/^B/).getAttribute("data-state")).toBe("running");
    act(() =>
      client.emitEvent({
        type: "event",
        name: "terminal.activity",
        terminalId: "t1",
        projectId: "p1",
        activity: { state: "waiting", since: new Date(1).toISOString() },
      }),
    );
    expect(tab(/^A/).getAttribute("data-state")).toBe("waiting");
    expect(tab(/^A/).textContent).toContain("seni bekliyor");
    act(() => client.emitExit("t2", 0));
    expect(tab(/^B/).getAttribute("data-state")).toBe("exited");
    // A late activity event does not revive an exited terminal.
    act(() =>
      client.emitEvent({
        type: "event",
        name: "terminal.activity",
        terminalId: "t2",
        projectId: "p1",
        activity: { state: "running", since: new Date(2).toISOString() },
      }),
    );
    expect(tab(/^B/).getAttribute("data-state")).toBe("exited");
  });

  it("arrow keys move between tabs; only the active tab is in the tab order", async () => {
    setup({
      terminals: [
        makeProjectTerminal("t1", "p1", "A"),
        makeProjectTerminal("t2", "p1", "B"),
        makeProjectTerminal("t3", "p1", "C"),
      ],
    });
    await flush();
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(tab(/^A/), { key: "ArrowRight" });
    expect(selected()[0]!.getAttribute("data-title")).toBe("B");
    expect(document.activeElement).toBe(tab(/^B/));
    fireEvent.keyDown(tab(/^B/), { key: "End" });
    expect(selected()[0]!.getAttribute("data-title")).toBe("C");
    fireEvent.keyDown(tab(/^C/), { key: "ArrowRight" });
    expect(selected()[0]!.getAttribute("data-title")).toBe("A");
    fireEvent.keyDown(tab(/^A/), { key: "ArrowLeft" });
    expect(selected()[0]!.getAttribute("data-title")).toBe("C");
    fireEvent.keyDown(tab(/^C/), { key: "Home" });
    expect(selected()[0]!.getAttribute("data-title")).toBe("A");
  });

  it("switching project shows that project's tabs with its own stored state", async () => {
    const P2 = makeProject("p2", "İkinci");
    const client = new FakeEngineClient({
      projects: [P1, P2],
      terminals: [makeProjectTerminal("t1", "p1", "A"), makeProjectTerminal("t2", "p2", "B")],
    });
    const { rerender, store } = setup({ client });
    await flush();
    const other = new FakeStore();
    rerender({ project: P2, state: other });
    await flush();
    expect(tabNames()).toEqual(["B"]);
    expect(other.get<{ active: string }>(PREFS_KEY)?.active).toBe("t2");
    expect(store.get<{ active: string }>(PREFS_KEY)?.active).toBe("t1");
  });

  it("monkey: random opens, closes, switches, splits and output never mix terminals", async () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const { client, views } = setup();
    await flush();
    const written = new Map<string, string>();
    let n = 0;
    for (let step = 0; step < MONKEY_STEPS; step++) {
      const ids = client.terminals.filter((t) => t.projectId === "p1").map((t) => t.id);
      const op = rnd(7);
      if (op === 0 || ids.length === 0) {
        await openViaMenu(`cmd${n++}`);
      } else if (op === 1) {
        // Opened elsewhere (e.g. the Ajanlar panel): only an event tells us.
        client.terminals.push(makeProjectTerminal(`ext${n++}`, "p1", `ext${n}`));
        act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1" }));
        await flush();
      } else if (op === 2) {
        const id = ids[rnd(ids.length)]!;
        const title = client.terminals.find((t) => t.id === id)!.title;
        await confirmClose(title);
        written.delete(id);
      } else if (op === 3) {
        const tabs = screen.getAllByRole("tab");
        fireEvent.click(tabs[rnd(tabs.length)]!);
      } else if (op === 4) {
        const b = screen.getByRole("button", { name: "Böl" }) as HTMLButtonElement;
        if (!b.disabled) fireEvent.click(b);
      } else {
        const id = ids[rnd(ids.length)]!;
        const chunk = `<${id}:${step}>`;
        act(() => client.emitOutput(id, chunk));
        written.set(id, (written.get(id) ?? "") + chunk);
      }
      const live = client.terminals.filter((t) => t.projectId === "p1");
      expect(tabNames().sort()).toEqual(live.map((t) => t.title).sort());
      if (live.length > 0) expect(selected()).toHaveLength(1);
      for (const t of live) expect(viewOf(views.views, t.id).screen).toBe(written.get(t.id) ?? "");
      expect(document.querySelectorAll('[role=tabpanel]:not([data-pane="hidden"])').length).toBeLessThanOrEqual(2);
    }
    expect(views.views.every((v) => v.writesAfterDispose.length === 0)).toBe(true);
  }, MONKEY_TIMEOUT_MS);
});
