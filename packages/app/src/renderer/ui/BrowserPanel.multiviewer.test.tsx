// "Tarayıcıda yakınlaştırıyorum, sonra kendiliğinden uzaklaşıyor": two apps show one project's browser. Each app
// used to keep its own zoom and push it (with its panel's size) whenever its panel was mounted, reconnected, shown
// or focused — so the app nobody was using kept undoing what the user did in the other one. Now:
// - the zoom is the engine's: the panel shows what the engine reports, sends only user steps (as such), and hands a
//   zoom it stored earlier over exactly once;
// - the page's size follows the panel the user last used: a panel reports its size as before, but only says "my
//   user did this" when they did — and fits whatever frames it gets when another app drives the page.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, type FrameDrawer } from "./BrowserPanel.tsx";
import { forgetActivity } from "./browser-activity.ts";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { FakeResizeObserver } from "./test-utils/fake-view.ts";
import { memoryPanelStates, ViewPrefsContext } from "./view-prefs-context.tsx";
import { BROWSER_ZOOM_KEY, createFontSizeStore, dispatchViewCommand } from "./view-prefs.ts";

const flush = () => act(async () => {});
const VIEW_CLASS = "kp-browser__view";
const P = "p1";
const DEFAULT = defaultUiConfig.browserZoom;
const LEVELS = defaultUiConfig.browserZoomLevels;
const up = (from: number, n = 1): number => LEVELS[Math.min(LEVELS.length - 1, Math.max(0, LEVELS.indexOf(from) + n))]!;

/** This app's panel (the picture area, CSS px) and the frames the fake drawer "decodes". */
let box = { width: 0, height: 0 };
let image = { width: 900, height: 600 };

interface Opts {
  running?: boolean;
  /** What this app kept in its own UI state before the engine owned the zoom. */
  stored?: unknown;
  /** The project's zoom in the engine (chosen by a user somewhere). */
  engineZoom?: number;
  /** Another app drives the page's viewport. */
  otherOwns?: boolean;
  /** The engine cannot be reached when the panel starts. */
  offline?: boolean;
}

function setup(opts: Opts = {}) {
  const project = makeProject(P, "Alfa");
  const client = new FakeEngineClient({ projects: [project] });
  if (opts.running !== false) client.browser.handlers["browser.open"]({ projectId: P });
  if (opts.engineZoom !== undefined) client.browser.zooms.set(P, opts.engineZoom);
  if (opts.otherOwns) client.browser.takeOver(P);
  if (opts.offline) client.fail("browser.zoom.set", "DISCONNECTED", "bağlantı yok");
  const panelState = memoryPanelStates();
  const prefs = panelState("browser", `project:${P}`);
  if (opts.stored !== undefined) prefs.set(BROWSER_ZOOM_KEY, opts.stored);
  const font = createFontSizeStore(panelState("terminals", "global"), defaultUiConfig);
  const draw: FrameDrawer = async () => ({ ...image });
  /** Requests and input events in the order the app sent them. */
  const sent: string[] = [];
  const request = client.request.bind(client);
  vi.spyOn(client, "request").mockImplementation(((method: string, params: Record<string, unknown>) => {
    if (method === "browser.viewport.set") sent.push(params.interaction === true ? "size+claim" : "size");
    if (method === "browser.zoom.set") sent.push(`zoom:${String(params.mode)}`);
    return (request as (m: string, p: unknown) => Promise<unknown>)(method, params);
  }) as typeof client.request);
  const input = client.sendBrowserInput.bind(client);
  vi.spyOn(client, "sendBrowserInput").mockImplementation((projectId, event) => {
    sent.push(event.type === "mouse" ? `mouse:${event.action}` : event.type);
    input(projectId, event);
  });
  const panel = () => (
    <ViewPrefsContext.Provider value={{ font, panelState }}>
      <BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} />
    </ViewPrefsContext.Provider>
  );
  const utils = render(panel());
  const zoomCalls = () => client.callsOf("browser.zoom.set").map(({ zoom, mode }) => ({ zoom, mode }));
  const sizes = () => client.callsOf("browser.viewport.set").map((c) => `${c.width}x${c.height}${c.interaction ? "!" : ""}`);
  /** Another app's user changed the project's zoom. */
  const zoomElsewhere = async (zoom: number) => {
    client.browser.zooms.set(P, zoom);
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: P }));
    await flush();
  };
  /** Another app's user used its panel: it drives the viewport now, and every app is told. */
  const takenOver = async () => {
    client.browser.takeOver(P);
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: P }));
    await flush();
  };
  return { client, prefs, sent, panel, zoomCalls, sizes, zoomElsewhere, takenOver, ...utils };
}

const canvas = () => screen.getByLabelText("Tarayıcı görüntüsü") as HTMLCanvasElement;
const view = () => canvas().parentElement!;
const shownZoom = () => Number(view().getAttribute("data-zoom"));
const drives = () => view().getAttribute("data-viewport-owner") === "true";
const cssSize = (el: HTMLElement) => ({ width: Number.parseFloat(el.style.width), height: Number.parseFloat(el.style.height) });

async function resized(next: { width: number; height: number }): Promise<void> {
  box = next;
  act(() => FakeResizeObserver.triggerAll());
  await act(async () => {
    await new Promise((r) => setTimeout(r, defaultUiConfig.resizeDebounceMs + 30));
  });
}

/** A click on the picture at (x, y) of the canvas box, as the user's mouse would do it. */
async function click(x: number, y: number): Promise<void> {
  fireEvent.mouseDown(canvas(), { clientX: x, clientY: y, button: 0, detail: 1 });
  fireEvent.mouseUp(canvas(), { clientX: x, clientY: y, button: 0, detail: 1 });
  await flush();
}

beforeEach(() => {
  box = { width: 700, height: 420 };
  image = { width: 900, height: 600 };
  forgetActivity();
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  for (const [prop, key] of [
    ["clientWidth", "width"],
    ["clientHeight", "height"],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, prop, "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(VIEW_CLASS) ? box[key] : 0;
    });
  }
  // jsdom has no layout: the canvas box is what its fitted CSS size says, at the page's origin.
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLCanvasElement) {
    const width = Number.parseFloat(this.style.width) || 0;
    const height = Number.parseFloat(this.style.height) || 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowserPanel: the zoom is the engine's — the panel reads it and never writes a copy back", () => {
  it("mount, reconnect, focus, re-show, a resize and a remount send no zoom at all", async () => {
    const { client, zoomCalls, panel, unmount } = setup({ engineZoom: 1 });
    await flush();
    act(() => client.emitReconnected());
    await flush();
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await resized({ width: 640, height: 400 });
    unmount();
    render(panel());
    await flush();
    act(() => client.emitReconnected());
    await flush();
    expect(zoomCalls()).toEqual([]);
    expect(shownZoom()).toBe(1);
    expect(client.browser.zoomOf(P)).toBe(1);
  });

  it("shows the project's zoom from the engine, and follows a change another app's user made", async () => {
    const { zoomCalls, zoomElsewhere } = setup({ engineZoom: 1.25 });
    await flush();
    expect(shownZoom()).toBe(1.25);
    await zoomElsewhere(0.9);
    expect(shownZoom()).toBe(0.9);
    expect(zoomCalls()).toEqual([]);
  });

  it("a project nobody zoomed shows the default, without telling the engine anything", async () => {
    const { zoomCalls } = setup();
    await flush();
    expect(shownZoom()).toBe(DEFAULT);
    expect(zoomCalls()).toEqual([]);
  });

  it("a user step starts from the engine's zoom and is sent as a user action; reset asks for the engine's default", async () => {
    const { client, zoomCalls, zoomElsewhere } = setup({ engineZoom: 1 });
    await flush();
    fireEvent.keyDown(canvas(), { key: "=", code: "Equal", metaKey: true });
    await flush();
    expect(zoomCalls()).toEqual([{ zoom: up(1), mode: "user" }]);
    expect(shownZoom()).toBe(up(1));
    // The other app zooms meanwhile: the next step here starts from there, not from this app's last value.
    await zoomElsewhere(0.75);
    act(() => dispatchViewCommand("browser.zoom.out"));
    await flush();
    expect(zoomCalls().at(-1)).toEqual({ zoom: up(0.75, -1), mode: "user" });
    act(() => dispatchViewCommand("browser.zoom.reset"));
    await flush();
    expect(zoomCalls().at(-1)).toEqual({ zoom: null, mode: "user" });
    expect(shownZoom()).toBe(DEFAULT);
    expect(client.browser.zoomOf(P)).toBe(DEFAULT);
  });

  it("quick steps end on the last one: an older answer from the engine does not undo what the user just chose", async () => {
    const { client, zoomCalls } = setup();
    await flush();
    act(() => dispatchViewCommand("browser.zoom.in"));
    // Before the engine answered: a state the engine sent earlier arrives (another change, a tab title).
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: P }));
    act(() => dispatchViewCommand("browser.zoom.in"));
    act(() => dispatchViewCommand("browser.zoom.in"));
    await flush();
    expect(zoomCalls().map((c) => c.zoom)).toEqual([up(DEFAULT), up(DEFAULT, 2), up(DEFAULT, 3)]);
    expect(shownZoom()).toBe(up(DEFAULT, 3));
    expect(client.browser.zoomOf(P)).toBe(up(DEFAULT, 3));
  });

  it("the zoom can be changed while the browser is closed (it is the project's), and is there when it opens", async () => {
    const { client, zoomCalls } = setup({ running: false });
    await flush();
    act(() => dispatchViewCommand("browser.zoom.in"));
    await flush();
    expect(zoomCalls()).toEqual([{ zoom: up(DEFAULT), mode: "user" }]);
    fireEvent.click(screen.getByRole("button", { name: "Tarayıcıyı aç" }));
    await flush();
    expect(shownZoom()).toBe(up(DEFAULT));
    expect(zoomCalls()).toHaveLength(1);
    expect(client.browser.zoomOf(P)).toBe(up(DEFAULT));
  });

  it("an engine that refuses the step shows why and the panel goes back to the engine's zoom", async () => {
    const { client, zoomCalls } = setup({ engineZoom: 1 });
    await flush();
    client.fail("browser.zoom.set", "INVALID", "olmadı");
    act(() => dispatchViewCommand("browser.zoom.in"));
    await flush();
    expect(zoomCalls()).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("olmadı");
    expect(shownZoom()).toBe(1);
  });
});

describe("BrowserPanel: a zoom this app stored before the engine owned it is handed over once", () => {
  it("nobody chose a zoom in the engine: the stored one becomes the project's, and the app's copy is removed", async () => {
    const { client, prefs, zoomCalls } = setup({ stored: 1.25 });
    await flush();
    expect(zoomCalls()).toEqual([{ zoom: 1.25, mode: "adopt" }]);
    expect(client.browser.zoomOf(P)).toBe(1.25);
    expect(shownZoom()).toBe(1.25);
    expect(prefs.get(BROWSER_ZOOM_KEY)).toBeUndefined();
    // Nothing is left to hand over: not on reconnect, not for the next panel.
    act(() => client.emitReconnected());
    await flush();
    expect(zoomCalls()).toHaveLength(1);
  });

  it("the engine already has the user's zoom (chosen in the other app): the stale copy is dropped, not applied", async () => {
    const { client, prefs, zoomCalls } = setup({ stored: 1.25, engineZoom: 0.9 });
    await flush();
    expect(zoomCalls()).toEqual([{ zoom: 1.25, mode: "adopt" }]);
    expect(client.browser.zoomOf(P)).toBe(0.9);
    expect(shownZoom()).toBe(0.9);
    expect(prefs.get(BROWSER_ZOOM_KEY)).toBeUndefined();
  });

  it("garbage in the old slot is just removed; a closed browser hands over too", async () => {
    const a = setup({ stored: "çok" });
    await flush();
    expect(a.zoomCalls()).toEqual([]);
    expect(a.prefs.get(BROWSER_ZOOM_KEY)).toBeUndefined();
    cleanup();
    const b = setup({ stored: 0.8, running: false });
    await flush();
    expect(b.zoomCalls()).toEqual([{ zoom: 0.8, mode: "adopt" }]);
    expect(b.prefs.get(BROWSER_ZOOM_KEY)).toBeUndefined();
  });

  it("the engine cannot be reached: the copy is kept and handed over after the reconnect", async () => {
    const { client, prefs, zoomCalls } = setup({ stored: 1.25, offline: true });
    await flush();
    expect(prefs.get(BROWSER_ZOOM_KEY)).toBe(1.25);
    expect(screen.queryByRole("alert")).toBeNull();
    client.restore("browser.zoom.set");
    act(() => client.emitReconnected());
    await flush();
    expect(zoomCalls()).toEqual([
      { zoom: 1.25, mode: "adopt" },
      { zoom: 1.25, mode: "adopt" },
    ]);
    expect(prefs.get(BROWSER_ZOOM_KEY)).toBeUndefined();
    expect(shownZoom()).toBe(1.25);
  });
});

describe("BrowserPanel: one viewer drives the page's size — the panel its user last used", () => {
  it("alone, the panel drives without any claim: its reports are plain sizes, as before", async () => {
    const { sizes } = setup();
    await flush();
    expect(sizes()).toEqual(["700x420"]);
    expect(drives()).toBe(true);
  });

  it("another app drives: mount, reconnect, focus, re-show and a resize report the size without a claim — the engine ignores them", async () => {
    const { client, sizes } = setup({ otherOwns: true });
    await flush();
    act(() => client.emitReconnected());
    await flush();
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    await resized({ width: 640, height: 400 });
    expect(sizes().length).toBeGreaterThanOrEqual(4);
    expect(sizes().some((s) => s.endsWith("!"))).toBe(false);
    expect(drives()).toBe(false);
    expect(client.browser.owned.has(P)).toBe(false);
  });

  it("the passive panel fits the other viewer's frames (letterboxed) and maps a click exactly", async () => {
    const { client } = setup({ otherOwns: true });
    await flush();
    // The owner's page is 900×600 CSS px; this panel is 700×420.
    client.browser.emitFrame(P, { deviceWidth: 900, deviceHeight: 600 });
    await flush();
    expect(cssSize(canvas())).toEqual({ width: 630, height: 420 });
    await click(315, 210);
    await click(630 * 0.25, 420 * 0.75);
    const downs = client.browser.inputs.map((i) => i.event).filter((e) => e.type === "mouse" && e.action === "down");
    expect(downs.map((e) => (e.type === "mouse" ? [e.x, e.y] : null))).toEqual([
      [450, 300],
      [225, 450],
    ]);
  });

  it("the passive viewer clicks: the press and the release go first, then the size with the claim — once", async () => {
    const { client, sent, sizes } = setup({ otherOwns: true });
    await flush();
    client.browser.emitFrame(P, { deviceWidth: 900, deviceHeight: 600 });
    await flush();
    sent.length = 0;
    await click(315, 210);
    expect(sent).toEqual(["mouse:down", "mouse:up", "size+claim"]);
    expect(sizes().at(-1)).toBe("700x420!");
    expect(client.browser.owned.has(P)).toBe(true);
    // The engine says this panel drives now: further clicks are just clicks.
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: P }));
    await flush();
    expect(drives()).toBe(true);
    sent.length = 0;
    await click(100, 100);
    await click(120, 100);
    expect(sent).toEqual(["mouse:down", "mouse:up", "mouse:down", "mouse:up"]);
  });

  it("nothing is reported between a press and its release — the page must not change under a click", async () => {
    const { client, sent, sizes } = setup({ otherOwns: true });
    await flush();
    client.browser.emitFrame(P, { deviceWidth: 900, deviceHeight: 600 });
    await flush();
    sent.length = 0;
    fireEvent.mouseDown(canvas(), { clientX: 315, clientY: 210, button: 0, detail: 1, buttons: 1 });
    // The click brings the window to the front, and the panel is resized meanwhile: both would report the size.
    act(() => void window.dispatchEvent(new Event("focus")));
    await resized({ width: 640, height: 400 });
    expect(sent).toEqual(["mouse:down"]);
    fireEvent.mouseUp(canvas(), { clientX: 315, clientY: 210, button: 0, detail: 1 });
    await flush();
    expect(sent).toEqual(["mouse:down", "mouse:up", "size+claim"]);
    expect(sizes().at(-1)).toBe("640x400!");
    // A release the window never saw (the button came up outside it): the next movement ends the press.
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: P }));
    await flush();
    expect(drives()).toBe(true);
    fireEvent.mouseDown(canvas(), { clientX: 10, clientY: 10, button: 0, detail: 1, buttons: 1 });
    await resized({ width: 660, height: 410 });
    expect(sizes().at(-1)).toBe("640x400!");
    fireEvent.mouseMove(document.body, { buttons: 0 });
    await flush();
    expect(sizes().at(-1)).toMatch(/^660x410/);
  });

  it("typing, the wheel, the address bar and a zoom step claim too; moving the mouse does not", async () => {
    for (const use of ["key", "wheel", "address", "zoom", "move"] as const) {
      const { client, sent, takenOver } = setup();
      await flush();
      client.browser.emitFrame(P, { deviceWidth: 900, deviceHeight: 600 });
      await flush();
      await takenOver();
      expect(drives(), use).toBe(false);
      sent.length = 0;
      if (use === "key") fireEvent.keyDown(canvas(), { key: "a", code: "KeyA" });
      if (use === "wheel") fireEvent.wheel(canvas(), { clientX: 10, clientY: 10, deltaY: 40 });
      if (use === "address") fireEvent.keyDown(screen.getByLabelText("Adres"), { key: "k", code: "KeyK" });
      if (use === "zoom") act(() => dispatchViewCommand("browser.zoom.in"));
      if (use === "move") fireEvent.mouseMove(canvas(), { clientX: 10, clientY: 10 });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      const want = { key: ["key", "size+claim"], wheel: ["wheel", "size+claim"], address: ["size+claim"], zoom: ["size+claim", "zoom:user"], move: ["mouse:move"] }[use];
      expect(sent, use).toEqual(want);
      cleanup();
    }
  });

  it("the user just worked in this window (clicked a project tab, dragged a splitter): the panel's own report claims", async () => {
    const { client, sizes, takenOver } = setup();
    await flush();
    await takenOver();
    // Unattended: a resize is reported, without a claim.
    await resized({ width: 640, height: 400 });
    expect(sizes().at(-1)).toBe("640x400");
    // The user presses something elsewhere in this window, and the panel's size changes because of it.
    fireEvent.mouseDown(document.body);
    await resized({ width: 600, height: 380 });
    expect(sizes().at(-1)).toBe("600x380!");
    expect(client.browser.owned.has(P)).toBe(true);
  });

  it("a window nobody can see never reports a size (it can never drive the page)", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { client, sizes } = setup();
    await flush();
    act(() => client.emitReconnected());
    await flush();
    await resized({ width: 640, height: 400 });
    expect(sizes()).toEqual([]);
    // Shown again: now it reports.
    visibility.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(sizes()).toEqual(["640x400"]);
  });

  it("monkey: whatever happens, zooms are only sent for user steps and a claim only follows the user's own input", async () => {
    const { client, sent, zoomCalls, takenOver, zoomElsewhere } = setup();
    await flush();
    client.browser.emitFrame(P, { deviceWidth: 900, deviceHeight: 600 });
    await flush();
    let seed = 20261117;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let steps = 0;
    /** Whether the user did something in this window since the last unattended stretch began. */
    let used = false;
    for (let i = 0; i < 80; i++) {
      const before = sent.length;
      const op = rnd(9);
      if (op === 0) act(() => client.emitReconnected());
      else if (op === 1) act(() => void window.dispatchEvent(new Event("focus")));
      else if (op === 2) await resized({ width: 300 + rnd(900), height: 200 + rnd(500) });
      else if (op === 3) await takenOver();
      else if (op === 4) await zoomElsewhere(LEVELS[rnd(LEVELS.length)]!);
      else if (op === 5) {
        // A long time passes with nobody at this window.
        forgetActivity();
        used = false;
      } else if (op === 6) {
        used = true;
        await click(rnd(300), rnd(200));
      } else if (op === 7) {
        used = true;
        fireEvent.keyDown(canvas(), { key: "a", code: "KeyA" });
      } else {
        used = true;
        steps++;
        act(() => dispatchViewCommand((["browser.zoom.in", "browser.zoom.out", "browser.zoom.reset"] as const)[rnd(3)]!));
      }
      await flush();
      const now = sent.slice(before);
      if (now.includes("size+claim")) expect(used, `op ${op} at ${i}: ${now.join(",")}`).toBe(true);
    }
    expect(zoomCalls().every((c) => c.mode === "user")).toBe(true);
    expect(zoomCalls()).toHaveLength(steps);
    expect(shownZoom()).toBe(client.browser.zoomOf(P));
  });
});
