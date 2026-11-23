import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeTerminal } from "./test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "./test-utils/fake-view.ts";
import { memoryPanelStates, ViewPrefsContext } from "./view-prefs-context.tsx";
import { createFontSizeStore } from "./view-prefs.ts";

const flush = () => act(async () => {});

function setup(opts: { dims?: { cols: number; rows: number } | null } = {}) {
  const term = makeTerminal("t1", "c1", "kabuk");
  const client = new FakeEngineClient({ terminals: [term] });
  const views = makeFakeViewFactory(opts.dims === undefined ? { cols: 100, rows: 30 } : opts.dims);
  const onClosed = vi.fn();
  const utils = render(
    <TerminalPanel client={client} terminal={term} createView={views.factory} config={defaultUiConfig} onClosed={onClosed} />,
  );
  return { client, views, term, onClosed, ...utils };
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TerminalPanel", () => {
  it("attaches on mount with the fitted size and shows title and running status", async () => {
    const { client } = setup();
    await flush();
    expect(client.callsOf("terminal.attach")).toEqual([{ terminalId: "t1", cols: 100, rows: 30 }]);
    expect(screen.getByText("kabuk")).toBeTruthy();
    expect(screen.getByText("çalışıyor")).toBeTruthy();
  });

  it("falls back to configured size when the container cannot be measured", async () => {
    const { client } = setup({ dims: null });
    await flush();
    expect(client.callsOf("terminal.attach")).toEqual([
      { terminalId: "t1", ...defaultUiConfig.fallbackDims },
    ]);
  });

  it("resets before writing a replay and appends live output", async () => {
    const { client, views } = setup();
    await flush();
    const v = views.views[0]!;
    act(() => client.emitOutput("t1", "eski"));
    act(() => client.emitOutput("t1", "geçmiş", true));
    expect(v.resets).toBe(1);
    expect(v.screen).toBe("geçmiş");
    act(() => client.emitOutput("t1", " canlı"));
    expect(v.screen).toBe("geçmiş canlı");
  });

  it("a replay in parts resets once and shows every part in order", async () => {
    const { client, views } = setup();
    await flush();
    const v = views.views[0]!;
    act(() => client.emitOutput("t1", "eski ekran"));
    act(() => client.emitOutput("t1", "bir ", true));
    act(() => client.emitOutput("t1", "iki ", true, true));
    act(() => client.emitOutput("t1", "üç", true, true));
    act(() => client.emitOutput("t1", " canlı"));
    expect(v.resets).toBe(1);
    expect(v.screen).toBe("bir iki üç canlı");
    expect(v.replayWrites).toEqual(["bir ", "iki ", "üç"]);
  });

  it("history that could not be loaded is said so, with a way to try again — never a silently blank terminal", async () => {
    const { client, views } = setup();
    await flush();
    expect(screen.queryByText(/Geçmiş yüklenemedi/)).toBeNull();
    act(() => client.emitOutputLost("t1"));
    act(() => client.emitOutputLost("t1"));
    expect(screen.getAllByText(/Geçmiş yüklenemedi/)).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("Geçmiş yüklenemedi");

    // Live output still shows while the notice is up.
    act(() => client.emitOutput("t1", "canlı"));
    expect(views.views[0]!.screen).toBe("canlı");
    expect(screen.getByText(/Geçmiş yüklenemedi/)).toBeTruthy();

    // "Yeniden dene" asks the engine for the history again; the replay that follows clears the notice.
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    await flush();
    expect(client.callsOf("terminal.attach")).toHaveLength(2);
    act(() => client.emitOutput("t1", "geçmiş", true));
    expect(screen.queryByText(/Geçmiş yüklenemedi/)).toBeNull();
    expect(views.views[0]!.screen).toBe("geçmiş");
  });

  it("a retry that loses the history again shows the notice again", async () => {
    const { client } = setup();
    await flush();
    act(() => client.emitOutputLost("t1"));
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    await flush();
    act(() => client.emitOutputLost("t1"));
    expect(screen.getByText(/Geçmiş yüklenemedi/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yeniden dene" })).toBeTruthy();
  });

  it("losses of another terminal do not show here; the listener goes away with the panel", async () => {
    const { client, unmount } = setup();
    await flush();
    act(() => client.emitOutputLost("t2"));
    expect(screen.queryByText(/Geçmiş yüklenemedi/)).toBeNull();
    unmount();
    expect(() => client.emitOutputLost("t1")).not.toThrow();
  });

  it("ignores output of other terminals", async () => {
    const { client, views } = setup();
    await flush();
    act(() => client.emitOutput("t2", "başkası"));
    expect(views.views[0]!.screen).toBe("");
  });

  it("sends typed input to the engine", async () => {
    const { client, views } = setup();
    await flush();
    views.views[0]!.type("ls\r");
    expect(client.inputs).toEqual([{ terminalId: "t1", data: "ls\r" }]);
  });

  it("sends resize debounced and only when the size changed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, views } = setup();
    await flush();
    const v = views.views[0]!;
    FakeResizeObserver.triggerAll();
    vi.advanceTimersByTime(defaultUiConfig.resizeDebounceMs + 1);
    expect(client.resizes).toEqual([]);

    v.dims = { cols: 120, rows: 40 };
    FakeResizeObserver.triggerAll();
    FakeResizeObserver.triggerAll();
    expect(client.resizes).toEqual([]);
    vi.advanceTimersByTime(defaultUiConfig.resizeDebounceMs + 1);
    expect(client.resizes).toEqual([{ terminalId: "t1", cols: 120, rows: 40 }]);

    v.dims = null;
    FakeResizeObserver.triggerAll();
    vi.advanceTimersByTime(defaultUiConfig.resizeDebounceMs + 1);
    expect(client.resizes).toHaveLength(1);
  });

  it("works without ResizeObserver", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { client } = setup();
    await flush();
    expect(client.callsOf("terminal.attach")).toHaveLength(1);
  });

  it("shows exit code when the terminal exits", async () => {
    const { client } = setup();
    await flush();
    act(() => client.emitExit("t1", 3));
    expect(screen.getByText("kapandı (çıkış 3)")).toBeTruthy();
  });

  it("re-attaches after reconnect; replay replaces the screen without duplicates", async () => {
    const { client, views } = setup();
    await flush();
    const v = views.views[0]!;
    act(() => client.emitOutput("t1", "abc", true));
    act(() => client.setState("reconnecting"));
    act(() => client.emitReconnected());
    await flush();
    expect(client.callsOf("terminal.attach")).toHaveLength(2);
    act(() => client.emitOutput("t1", "abcdef", true));
    expect(v.screen).toBe("abcdef");
  });

  it("attaches once the connection opens if mounted while disconnected", async () => {
    const term = makeTerminal("t1", "c1");
    const client = new FakeEngineClient({ terminals: [term] });
    client.state = "connecting";
    const views = makeFakeViewFactory();
    render(<TerminalPanel client={client} terminal={term} createView={views.factory} config={defaultUiConfig} />);
    await flush();
    act(() => client.setState("open"));
    await flush();
    const attaches = client.calls.filter((c) => c.method === "terminal.attach");
    expect(attaches).toHaveLength(2); // first rejected (DISCONNECTED), second succeeded
  });

  it("header shows the agent state (same words as the Ajanlar panel) and follows terminal.activity", async () => {
    const term = { ...makeTerminal("t1", "c1"), activity: { state: "idle" as const, since: new Date(0).toISOString() } };
    const client = new FakeEngineClient({ terminals: [term] });
    render(<TerminalPanel client={client} terminal={term} createView={makeFakeViewFactory().factory} config={defaultUiConfig} />);
    await flush();
    expect(screen.getByText("boşta")).toBeTruthy();
    act(() =>
      client.emitEvent({
        type: "event",
        name: "terminal.activity",
        terminalId: "t1",
        projectId: term.projectId,
        cardId: "c1",
        activity: { state: "waiting", since: new Date(1).toISOString() },
      }),
    );
    expect(screen.getByText("seni bekliyor")).toBeTruthy();
    // another terminal's activity does not change this header
    act(() =>
      client.emitEvent({
        type: "event",
        name: "terminal.activity",
        terminalId: "t2",
        projectId: term.projectId,
        activity: { state: "running", since: new Date(2).toISOString() },
      }),
    );
    expect(screen.getByText("seni bekliyor")).toBeTruthy();
    act(() => client.emitExit("t1", 0));
    expect(screen.getByText("kapandı (çıkış 0)")).toBeTruthy();
  });

  it("detaches, unsubscribes and disposes on unmount", async () => {
    const { client, views, unmount } = setup();
    await flush();
    unmount();
    await flush();
    expect(client.callsOf("terminal.detach")).toEqual([{ terminalId: "t1" }]);
    expect(views.views[0]!.disposed).toBe(true);
    expect(client.listenerCounts()).toMatchObject({ output: 0, exit: 0, reconnect: 0, state: 0 });
    client.emitOutput("t1", "geç");
    expect(views.views[0]!.writesAfterDispose).toEqual([]);
  });

  it("ignores detach errors on unmount", async () => {
    const { client, unmount } = setup();
    await flush();
    client.fail("terminal.detach", "NOT_FOUND", "yok");
    unmount();
    await flush();
  });

  it("shows attach errors inline", async () => {
    const term = makeTerminal("t1", "c1");
    const client = new FakeEngineClient({ terminals: [term] });
    client.fail("terminal.attach", "TERMINAL_EXITED", "terminal bitti");
    render(<TerminalPanel client={client} terminal={term} createView={makeFakeViewFactory().factory} config={defaultUiConfig} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("terminal bitti");
  });

  it("close asks for confirmation, then calls terminal.close", async () => {
    const { client, onClosed } = setup();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Terminali kapat" }));
    expect(client.callsOf("terminal.close")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Kapatmayı onayla" }));
    await flush();
    expect(client.callsOf("terminal.close")).toEqual([{ terminalId: "t1" }]);
    expect(onClosed).toHaveBeenCalledWith("t1");
  });
  it("bare mode leaves the header to the host (İş T tabs) but still streams and reports errors", async () => {
    const term = makeTerminal("t1", "c1", "kabuk");
    const client = new FakeEngineClient({ terminals: [term] });
    client.fail("terminal.attach", "TERMINAL_EXITED", "terminal bitti");
    const views = makeFakeViewFactory();
    render(<TerminalPanel client={client} terminal={term} createView={views.factory} config={defaultUiConfig} bare />);
    await flush();
    expect(screen.queryByRole("button", { name: "Terminali kapat" })).toBeNull();
    expect(screen.queryByText("kabuk")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("terminal bitti");
    act(() => client.emitOutput("t1", "çıktı"));
    expect(views.views[0]!.screen).toBe("çıktı");
  });

  describe("İş Z: font size", () => {
    function setupFont(initial?: number) {
      const state = memoryPanelStates()("terminals", "global");
      if (initial !== undefined) state.set("fontSize", initial);
      const font = createFontSizeStore(state, defaultUiConfig);
      const term = makeTerminal("t1", "c1", "kabuk");
      const client = new FakeEngineClient({ terminals: [term] });
      const views = makeFakeViewFactory({ cols: 100, rows: 30 });
      render(
        <ViewPrefsContext.Provider value={{ font, panelState: memoryPanelStates() }}>
          <TerminalPanel client={client} terminal={term} createView={views.factory} config={defaultUiConfig} />
        </ViewPrefsContext.Provider>,
      );
      return { client, views, font };
    }

    it("applies the stored size before the first fit (attach uses dims at that size)", async () => {
      const { views } = setupFont(15);
      await flush();
      const v = views.views[0]!;
      expect(v.fontSizes).toEqual([15]);
    });

    it("a change applies live: new size, refit, resize sent to the engine right away", async () => {
      const { client, views, font } = setupFont();
      await flush();
      const v = views.views[0]!;
      expect(v.fontSizes).toEqual([defaultUiConfig.terminalFontSize]);
      v.dimsAfterFont = { cols: 90, rows: 27 };
      act(() => font.apply("larger"));
      expect(v.fontSizes).toEqual([12, 13]);
      expect(client.resizes).toEqual([{ terminalId: "t1", cols: 90, rows: 27 }]);
      // Same dims after another change → no extra resize.
      act(() => font.apply("larger"));
      expect(v.fontSizes).toEqual([12, 13, 14]);
      expect(client.resizes).toHaveLength(1);
    });

    it("stops listening after unmount", async () => {
      const { views, font } = setupFont();
      await flush();
      cleanup();
      act(() => font.apply("smaller"));
      expect(views.views[0]!.fontSizes).toEqual([12]);
    });
  });
});
