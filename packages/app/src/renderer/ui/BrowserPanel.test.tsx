import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { BrowserPanel, type FrameDrawer } from "./BrowserPanel.tsx";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { FakeResizeObserver } from "./test-utils/fake-view.ts";

const flush = () => act(async () => {});

function setup(opts: { runOn?: "engine" | "client"; running?: boolean; openLocal?: (id: string) => Promise<void> } = {}) {
  const project = makeProject("p1", "Alfa", opts.runOn ? { browser: { runOn: opts.runOn } } : {});
  const client = new FakeEngineClient({ projects: [project] });
  if (opts.running) client.browser.handlers["browser.open"]({ projectId: "p1" });
  const drawn: string[] = [];
  const draw: FrameDrawer = async (_canvas, data) => {
    drawn.push(data);
    return { width: 1280, height: 800 };
  };
  const utils = render(
    <BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} openLocal={opts.openLocal} />,
  );
  return { client, project, drawn, ...utils };
}

const canvas = () => screen.getByLabelText("Tarayıcı görüntüsü") as HTMLCanvasElement;

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

describe("BrowserPanel (engine)", () => {
  it("closed: heading Tarayıcı, asks the engine for state, offers to open", async () => {
    const { client } = setup();
    await flush();
    expect(screen.getByRole("heading", { name: "Tarayıcı" })).toBeTruthy();
    expect(client.callsOf("browser.tabs")).toEqual([{ projectId: "p1" }]);
    expect(client.callsOf("browser.screencast.start")).toEqual([]);
    expect(screen.getByRole("button", { name: "Tarayıcıyı aç" })).toBeTruthy();
  });

  it("opening starts the screencast; frames are drawn, counted and acked", async () => {
    const { client, drawn } = setup();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Tarayıcıyı aç" }));
    await flush();
    expect(client.callsOf("browser.open")).toEqual([{ projectId: "p1" }]);
    const [start] = client.callsOf("browser.screencast.start");
    expect(start).toMatchObject({ projectId: "p1", quality: defaultUiConfig.browserQuality });
    expect(start!.maxWidth).toBeGreaterThanOrEqual(1);
    const f = client.browser.emitFrame("p1");
    await flush();
    expect(drawn).toEqual([f.data]);
    expect(canvas().getAttribute("data-frames")).toBe("1");
    // The page size the drawn picture shows (what a click is mapped against), for tests that must wait for it.
    expect(canvas().getAttribute("data-frame-size")).toBe("1280x800");
    expect(client.browser.acks).toEqual([{ projectId: "p1", frameId: f.frameId }]);
    client.browser.emitFrame("p1", { deviceWidth: 996, deviceHeight: 567 });
    await flush();
    expect(canvas().getAttribute("data-frame-size")).toBe("996x567");
    expect(screen.getByRole("button", { name: "Tarayıcıyı kapat" })).toBeTruthy();
  });

  it("already running: screencast starts on mount; tabs listed with the active one pressed", async () => {
    const { client } = setup({ running: true });
    await flush();
    expect(client.callsOf("browser.screencast.start")).toHaveLength(1);
    const tabs = screen.getByRole("group", { name: "Sekmeler" });
    expect(within(tabs).getByRole("button", { name: "about:blank" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("address bar: Enter navigates (bare host gets https://); bad input shows an error, sends nothing", async () => {
    const { client } = setup({ running: true });
    await flush();
    const address = screen.getByLabelText("Adres");
    fireEvent.change(address, { target: { value: "example.com" } });
    fireEvent.submit(address.closest("form")!);
    await flush();
    expect(client.callsOf("browser.navigate")).toEqual([{ projectId: "p1", url: "https://example.com" }]);
    fireEvent.change(address, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(address.closest("form")!);
    await flush();
    expect(client.callsOf("browser.navigate")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBeTruthy();
  });

  it("back / forward / reload / tab select / close reach the engine", async () => {
    const { client } = setup({ running: true });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Geri" }));
    fireEvent.click(screen.getByRole("button", { name: "İleri" }));
    fireEvent.click(screen.getByRole("button", { name: "Yenile" }));
    fireEvent.click(screen.getByRole("button", { name: "about:blank" }));
    await flush();
    expect(client.callsOf("browser.back")).toHaveLength(1);
    expect(client.callsOf("browser.forward")).toHaveLength(1);
    expect(client.callsOf("browser.reload")).toHaveLength(1);
    expect(client.callsOf("browser.selectTab")).toEqual([{ projectId: "p1", tabId: "T1" }]);
    fireEvent.click(screen.getByRole("button", { name: "Tarayıcıyı kapat" }));
    await flush();
    expect(client.callsOf("browser.close")).toEqual([{ projectId: "p1" }]);
    expect(screen.getByRole("button", { name: "Tarayıcıyı aç" })).toBeTruthy();
  });

  it("forwards mouse, wheel, keys and paste scaled to page coordinates", async () => {
    const { client } = setup({ running: true });
    await flush();
    client.browser.emitFrame("p1");
    await flush();
    const c = canvas();
    // The canvas is shown at 640x400 CSS px; the page is 1280x800.
    c.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 400, right: 650, bottom: 420, x: 10, y: 20, toJSON() {} });
    fireEvent.mouseDown(c, { clientX: 330, clientY: 220, button: 0, detail: 1 });
    expect(document.activeElement).toBe(c);
    fireEvent.mouseUp(c, { clientX: 330, clientY: 220, button: 0, detail: 1 });
    fireEvent.mouseMove(c, { clientX: 20, clientY: 30 });
    fireEvent.mouseMove(c, { clientX: 30, clientY: 40 });
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    fireEvent.wheel(c, { clientX: 330, clientY: 220, deltaY: 120, deltaMode: 0 });
    fireEvent.keyDown(c, { key: "a", code: "KeyA", keyCode: 65 });
    fireEvent.keyUp(c, { key: "a", code: "KeyA", keyCode: 65 });
    fireEvent.paste(c, { clipboardData: { getData: () => "yapıştır" } });
    const events = client.browser.inputs.map((i) => i.event);
    expect(events[0]).toMatchObject({ type: "mouse", action: "down", x: 640, y: 400, button: "left", clickCount: 1 });
    expect(events[1]).toMatchObject({ type: "mouse", action: "up", x: 640, y: 400 });
    // Two moves in one animation frame → one move event with the latest position.
    const moves = events.filter((e) => e.type === "mouse" && e.action === "move");
    expect(moves).toEqual([expect.objectContaining({ x: 40, y: 40 })]);
    expect(events).toContainEqual(expect.objectContaining({ type: "wheel", x: 640, y: 400, deltaY: 120 }));
    expect(events).toContainEqual(expect.objectContaining({ type: "key", action: "down", key: "a", code: "KeyA" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "key", action: "up", key: "a" }));
    // Kopyalama: pasted text travels as one browser.paste request, not as a (10 000-character) input event.
    await flush();
    expect(events.some((e) => e.type === "text")).toBe(false);
    expect(client.browser.clipboard.calls).toEqual([["paste", "p1", "yapıştır"]]);
  });

  it("a press lands where the user clicked even if focusing scrolls the panel (no scroll on focus)", async () => {
    const { client } = setup({ running: true });
    await flush();
    client.browser.emitFrame("p1");
    await flush();
    const c = canvas();
    let top = 20;
    c.getBoundingClientRect = () => ({ left: 10, top, width: 640, height: 400, right: 650, bottom: top + 400, x: 10, y: top, toJSON() {} });
    // A real browser scrolls a focused element into view unless told not to; model that: the canvas moves 215px up.
    const realFocus = HTMLElement.prototype.focus;
    const focusArgs: unknown[] = [];
    c.focus = function (opts?: FocusOptions) {
      focusArgs.push(opts);
      if (!opts?.preventScroll) top -= 215;
      realFocus.call(this, opts);
    };
    fireEvent.mouseDown(c, { clientX: 330, clientY: 220, button: 0, detail: 1 });
    expect(focusArgs).toEqual([{ preventScroll: true }]);
    expect(document.activeElement).toBe(c);
    expect(client.browser.inputs[0]!.event).toMatchObject({ type: "mouse", action: "down", x: 640, y: 400 });
  });

  it("no frame yet: pointer input is not sent (nothing to map against)", async () => {
    const { client } = setup({ running: true });
    await flush();
    fireEvent.mouseDown(canvas(), { clientX: 10, clientY: 10, button: 0, detail: 1 });
    expect(client.browser.inputs).toEqual([]);
  });

  it("a tab click marks the tab at once, before the engine answers; a refused click shows the engine's tabs again", async () => {
    const { client } = setup({ running: true });
    await flush();
    await act(async () => void (await client.request("browser.newTab", { projectId: "p1", url: "https://b.test/" })));
    await act(async () => void (await client.request("browser.selectTab", { projectId: "p1", tabId: "T1" })));
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));
    await flush();
    const tabs = screen.getByRole("group", { name: "Sekmeler" });
    const pressed = () => within(tabs).getAllByRole("button", { pressed: true }).map((b) => b.textContent);
    expect(pressed()).toEqual(["about:blank"]);
    // A slow engine (another page is still being brought to the front): the strip follows the click anyway.
    const release = client.hold(["browser.selectTab"]);
    fireEvent.click(within(tabs).getByRole("button", { name: "https://b.test/" }));
    await flush();
    expect(pressed()).toEqual(["https://b.test/"]);
    release();
    await flush();
    expect(pressed()).toEqual(["https://b.test/"]);
    // The engine refuses (the tab was closed meanwhile): the error is shown and the strip is the engine's again.
    client.fail("browser.selectTab", "NOT_FOUND", "Sekme bulunamadı");
    fireEvent.click(within(tabs).getByRole("button", { name: "about:blank" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Sekme bulunamadı");
    expect(pressed()).toEqual(["https://b.test/"]);
  });

  it("a screencast start the engine refused is asked again when the engine announces a change", async () => {
    const { client } = setup();
    await flush();
    client.fail("browser.screencast.start", "INTERNAL", "Session with given id not found.");
    fireEvent.click(screen.getByRole("button", { name: "Tarayıcıyı aç" }));
    await flush();
    expect(client.callsOf("browser.screencast.start")).toHaveLength(1);
    client.restore("browser.screencast.start");
    // The engine switched tabs (or attached again): the panel asks for the picture again, once.
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));
    await flush();
    expect(client.callsOf("browser.screencast.start")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
    // Once it runs, changes do not restart it.
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));
    await flush();
    expect(client.callsOf("browser.screencast.start")).toHaveLength(2);
  });

  it("browser.changed for this project refetches; other projects' events are ignored", async () => {
    const { client } = setup({ running: true });
    await flush();
    const before = client.callsOf("browser.tabs").length;
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "other" }));
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));
    await flush();
    expect(client.callsOf("browser.tabs").length).toBe(before + 1);
  });

  it("restarts the screencast after a reconnect, and stops it on unmount", async () => {
    const { client, unmount } = setup({ running: true });
    await flush();
    act(() => client.emitReconnected());
    await flush();
    expect(client.callsOf("browser.screencast.start")).toHaveLength(2);
    unmount();
    await flush();
    expect(client.callsOf("browser.screencast.stop")).toEqual([{ projectId: "p1" }]);
    expect(client.browser.frameListeners.get("p1")?.size ?? 0).toBe(0);
  });

  it("performans: out of sight (hidden dock tab / other view) the screencast stops after the grace; agents keep the browser", async () => {
    const observers: { cb: IntersectionObserverCallback; el?: Element }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly o: { cb: IntersectionObserverCallback; el?: Element };
        constructor(cb: IntersectionObserverCallback) {
          this.o = { cb };
          observers.push(this.o);
        }
        observe(el: Element) {
          this.o.el = el;
        }
        disconnect() {}
      },
    );
    const inView = (on: boolean) =>
      act(() => {
        for (const o of observers) if (o.el) o.cb([{ target: o.el, isIntersecting: on } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
    const { client } = setup({ running: true });
    await flush();
    expect(client.callsOf("browser.screencast.start")).toHaveLength(1);
    vi.useFakeTimers();
    try {
      inView(false);
      act(() => void vi.advanceTimersByTime(defaultUiConfig.streamHideGraceMs));
      expect(client.callsOf("browser.screencast.stop")).toEqual([{ projectId: "p1" }]);
      // The browser itself stays open for the agents driving it over CDP: only the frames stop.
      expect(client.callsOf("browser.close")).toEqual([]);
      inView(true);
      expect(client.callsOf("browser.screencast.start")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("performans: a drawn frame of the same size re-renders nothing (the counter is written to the canvas directly)", async () => {
    const project = makeProject("p1", "Alfa");
    const client = new FakeEngineClient({ projects: [project] });
    client.browser.handlers["browser.open"]({ projectId: "p1" });
    let commits = 0;
    const draw: FrameDrawer = async () => ({ width: 1280, height: 800 });
    render(
      <Profiler id="browser" onRender={() => void commits++}>
        <BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} />
      </Profiler>,
    );
    await flush();
    client.browser.emitFrame("p1");
    await flush();
    await flush();
    const before = commits;
    for (let i = 0; i < 10; i++) {
      client.browser.emitFrame("p1");
      await flush();
    }
    expect(commits - before).toBe(0);
    expect(canvas().getAttribute("data-frames")).toBe("11");
  });

  it("an engine error on open is shown", async () => {
    const { client } = setup();
    client.fail("browser.open", "INTERNAL", "Chrome başlatılamadı");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Tarayıcıyı aç" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Chrome başlatılamadı");
  });
});

describe("BrowserPanel (client)", () => {
  it("explains the agent cannot drive it and opens the local Chrome", async () => {
    const openLocal = vi.fn(async () => {});
    const { client } = setup({ runOn: "client", openLocal });
    await flush();
    expect(screen.getByText(/ajan bu tarayıcıyı süremez/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tarayıcıyı aç" }));
    await flush();
    expect(openLocal).toHaveBeenCalledWith("p1");
    expect(client.callsOf("browser.tabs")).toEqual([]);
    expect(client.callsOf("browser.open")).toEqual([]);
  });

  it("without a local bridge it says so", async () => {
    setup({ runOn: "client" });
    await flush();
    expect((screen.getByRole("button", { name: "Tarayıcıyı aç" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the local open error", async () => {
    setup({ runOn: "client", openLocal: async () => Promise.reject(new Error("Chrome bulunamadı")) });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Tarayıcıyı aç" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Chrome bulunamadı");
  });
});
