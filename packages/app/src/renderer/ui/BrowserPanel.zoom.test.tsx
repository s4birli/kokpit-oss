// İş Z: page zoom of the Tarayıcı panel — the project's, owned and persisted by the engine; the panel shows it and
// sends the user's steps (shortcuts, menu commands) — and the user's search engine. Two apps on one browser:
// BrowserPanel.multiviewer.test.tsx.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, type FrameDrawer } from "./BrowserPanel.tsx";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { FakeResizeObserver } from "./test-utils/fake-view.ts";
import { memoryPanelStates, ViewPrefsContext } from "./view-prefs-context.tsx";
import { BROWSER_ZOOM_KEY, createFontSizeStore, dispatchViewCommand, SEARCH_URL_KEY } from "./view-prefs.ts";

const flush = () => act(async () => {});

function setup(opts: { running?: boolean; stored?: unknown; searchUrl?: string } = {}) {
  const project = makeProject("p1", "Alfa");
  const client = new FakeEngineClient({ projects: [project] });
  if (opts.running !== false) client.browser.handlers["browser.open"]({ projectId: "p1" });
  const panelState = memoryPanelStates();
  if (opts.stored !== undefined) panelState("browser", "project:p1").set(BROWSER_ZOOM_KEY, opts.stored);
  if (opts.searchUrl !== undefined) panelState("browser", "global").set(SEARCH_URL_KEY, opts.searchUrl);
  const font = createFontSizeStore(panelState("terminals", "global"), defaultUiConfig);
  const draw: FrameDrawer = async () => ({ width: 1280, height: 800 });
  const utils = render(
    <ViewPrefsContext.Provider value={{ font, panelState }}>
      <BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} />
    </ViewPrefsContext.Provider>,
  );
  /** The user's zoom steps as the engine got them (null = "back to the default"). */
  const zooms = () => client.callsOf("browser.zoom.set").map((p) => p.zoom);
  const modes = () => client.callsOf("browser.zoom.set").map((p) => p.mode);
  /** What this app keeps of the zoom in its own UI state: nothing, the zoom is the engine's. */
  const stored = () => panelState("browser", "project:p1").get(BROWSER_ZOOM_KEY);
  /** The project's zoom in the engine. */
  const engineZoom = () => client.browser.zoomOf("p1");
  return { client, zooms, modes, stored, engineZoom, ...utils };
}

/** The zoom in effect, as the page view carries it (the toolbar has no zoom readout). */
const shownZoom = () => Number(screen.getByLabelText("Tarayıcı görüntüsü").parentElement!.getAttribute("data-zoom"));

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

/** The configured default zoom and its neighbours in the configured levels (`n` steps up or down, clamped). */
const ZOOM = defaultUiConfig.browserZoom;
const zoomStep = (from: number, n: number): number => {
  const levels = defaultUiConfig.browserZoomLevels;
  return levels[Math.min(levels.length - 1, Math.max(0, levels.indexOf(from) + n))]!;
};

describe("BrowserPanel: zoom", () => {
  it("a running browser nobody zoomed is shown at the default (zoomed out); the panel sends no zoom of its own", async () => {
    const { zooms } = setup();
    await flush();
    expect(zooms()).toEqual([]);
    expect(shownZoom()).toBe(defaultUiConfig.browserZoom);
  });

  it("the toolbar has no zoom controls and no profile text (room for the page); the other controls stay", async () => {
    setup();
    await flush();
    expect(screen.queryByRole("group", { name: "Yakınlaştırma" })).toBeNull();
    for (const name of ["Yakınlaştır", "Uzaklaştır", /sıfırla/]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByText(/profil/i)).toBeNull();
    for (const name of ["Geri", "İleri", "Yenile", "Uzantılar", "Tarayıcıyı kapat"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.getByLabelText("Adres")).toBeTruthy();
  });

  it("a zoom this app stored earlier is handed to the engine once (and shown); garbage is dropped", async () => {
    const a = setup({ stored: 1.25 });
    await flush();
    expect([a.zooms(), a.modes()]).toEqual([[1.25], ["adopt"]]);
    expect(shownZoom()).toBe(1.25);
    expect(a.stored()).toBeUndefined();
    cleanup();
    const s = setup({ stored: "çok" });
    await flush();
    expect(s.zooms()).toEqual([]);
    expect(shownZoom()).toBe(defaultUiConfig.browserZoom);
    expect(s.stored()).toBeUndefined();
  });

  it("the Görünüm commands step through the configured levels and reach the engine, which keeps the zoom", async () => {
    const { zooms, modes, stored, engineZoom } = setup();
    await flush();
    act(() => dispatchViewCommand("browser.zoom.in"));
    await flush();
    act(() => dispatchViewCommand("browser.zoom.in"));
    await flush();
    expect(engineZoom()).toBe(zoomStep(ZOOM, 2));
    expect(shownZoom()).toBe(zoomStep(ZOOM, 2));
    act(() => dispatchViewCommand("browser.zoom.out"));
    await flush();
    expect(engineZoom()).toBe(zoomStep(ZOOM, 1));
    act(() => dispatchViewCommand("browser.zoom.reset"));
    await flush();
    // Reset asks for the engine's default (null) instead of naming a value.
    expect(zooms()).toEqual([zoomStep(ZOOM, 1), zoomStep(ZOOM, 2), zoomStep(ZOOM, 1), null]);
    expect(modes().every((m) => m === "user")).toBe(true);
    // The app keeps no copy.
    expect(stored()).toBeUndefined();
    expect(shownZoom()).toBe(defaultUiConfig.browserZoom);
    expect(engineZoom()).toBe(defaultUiConfig.browserZoom);
  });

  it("Cmd+= / Cmd+- / Cmd+0 on the page view zoom instead of reaching the page", async () => {
    const { client, zooms } = setup();
    await flush();
    const canvas = screen.getByLabelText("Tarayıcı görüntüsü");
    fireEvent.keyDown(canvas, { key: "=", code: "Equal", metaKey: true });
    await flush();
    fireEvent.keyDown(canvas, { key: "-", code: "Minus", metaKey: true });
    fireEvent.keyDown(canvas, { key: "-", code: "Minus", metaKey: true });
    await flush();
    fireEvent.keyDown(canvas, { key: "0", code: "Digit0", ctrlKey: true });
    await flush();
    expect(zooms()).toEqual([zoomStep(ZOOM, 1), ZOOM, zoomStep(ZOOM, -1), null]);
    expect(shownZoom()).toBe(ZOOM);
    expect(client.browser.inputs.filter((i) => i.event.type === "key")).toEqual([]);
    // Ordinary keys still reach the page.
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    expect(client.browser.inputs.filter((i) => i.event.type === "key")).toHaveLength(1);
  });

  it("menu commands browser.zoom.in/out/reset drive it", async () => {
    const { zooms } = setup();
    await flush();
    act(() => dispatchViewCommand("browser.zoom.in"));
    await flush();
    act(() => dispatchViewCommand("browser.zoom.out"));
    await flush();
    act(() => dispatchViewCommand("browser.zoom.out"));
    await flush();
    act(() => dispatchViewCommand("browser.zoom.reset"));
    await flush();
    expect(zooms()).toEqual([zoomStep(ZOOM, 1), ZOOM, zoomStep(ZOOM, -1), null]);
  });

  it("closed browser: nothing is sent, and opening it sends no zoom either (the engine has the project's)", async () => {
    const { zooms } = setup({ running: false });
    await flush();
    expect(zooms()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Tarayıcıyı aç" }));
    await flush();
    expect(zooms()).toEqual([]);
    expect(shownZoom()).toBe(ZOOM);
  });

  it("monkey: random steps keep the zoom within the configured levels", async () => {
    const { zooms } = setup();
    await flush();
    const cmds = ["browser.zoom.in", "browser.zoom.out", "browser.zoom.reset"] as const;
    for (let i = 0; i < 60; i++) {
      act(() => dispatchViewCommand(cmds[(i * 7) % 3 === 0 ? 2 : (i * 13) % 2]!));
    }
    await flush();
    const lv = defaultUiConfig.browserZoomLevels;
    // A level, or null = "the default".
    for (const z of zooms()) if (z !== null) expect(lv).toContain(z);
    expect(zooms().length).toBe(60);
    expect(lv).toContain(shownZoom());
  });
});

// ---- Chrome-like gestures: keys on every layout, trackpad pinch / Ctrl + wheel, the zoom bubble ----

const LEVELS = defaultUiConfig.browserZoomLevels;
const PINCH = defaultUiConfig.browserPinchStepDelta;
const BUBBLE_MS = defaultUiConfig.browserZoomBubbleMs;
const canvasEl = () => screen.getByLabelText("Tarayıcı görüntüsü");
const bubble = () => screen.queryByRole("group", { name: "Yakınlaştırma" });
/** One pinch "frame" (Chromium: a ctrlKey wheel event; deltaY < 0 = fingers apart). */
const pinch = (deltaY: number): boolean => fireEvent.wheel(canvasEl(), { clientX: 10, clientY: 10, deltaY, deltaMode: 0, ctrlKey: true });
const pageWheels = (client: FakeEngineClient) => client.browser.inputs.filter((i) => i.event.type === "wheel");
const pageKeys = (client: FakeEngineClient) => client.browser.inputs.filter((i) => i.event.type === "key");
/** A frame is drawn and the picture has a size: an ordinary wheel maps to a page point and is forwarded. */
async function framed(client: FakeEngineClient): Promise<void> {
  client.browser.emitFrame("p1");
  await flush();
  canvasEl().getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, x: 0, y: 0, toJSON() {} });
}

describe("BrowserPanel: Chrome-like zoom gestures", () => {
  it("Turkish Q keys (Cmd + the '-' on the Equal key, Cmd+Shift+0 = '=') and the keypad zoom; none reaches the page", async () => {
    const { client, zooms } = setup();
    await flush();
    const c = canvasEl();
    fireEvent.keyDown(c, { key: "=", code: "Digit0", metaKey: true, shiftKey: true });
    await flush();
    fireEvent.keyDown(c, { key: "-", code: "Equal", metaKey: true });
    await flush();
    fireEvent.keyDown(c, { key: "+", code: "NumpadAdd", metaKey: true });
    await flush();
    fireEvent.keyDown(c, { key: "0", code: "Numpad0", metaKey: true });
    await flush();
    expect(zooms()).toEqual([zoomStep(ZOOM, 1), ZOOM, zoomStep(ZOOM, 1), null]);
    expect(pageKeys(client)).toEqual([]);
  });

  it("a zoom key released after Cmd is not sent to the page either (no stray key-up)", async () => {
    const { client } = setup();
    await flush();
    const c = canvasEl();
    fireEvent.keyDown(c, { key: "=", code: "Equal", metaKey: true });
    // Cmd comes up first, then "=" — without Cmd it would look like an ordinary key-up.
    fireEvent.keyUp(c, { key: "=", code: "Equal" });
    await flush();
    expect(pageKeys(client)).toEqual([]);
    // the next ordinary "=" is the page's again
    fireEvent.keyDown(c, { key: "=", code: "Equal" });
    fireEvent.keyUp(c, { key: "=", code: "Equal" });
    expect(pageKeys(client).map((k) => (k.event as { action: string }).action)).toEqual(["down", "up"]);
  });

  it("a pinch (ctrlKey wheel) steps the zoom like the keys and never reaches the page as a scroll", async () => {
    const { client, zooms, modes } = setup();
    await flush();
    await framed(client);
    await flush();
    // fingers apart, in many small frames: two steps
    for (let i = 0; i < 8; i++) expect(pinch(-PINCH / 4)).toBe(false); // default prevented: Kokpit itself is not zoomed or scrolled
    await flush();
    expect(zooms()).toEqual([zoomStep(ZOOM, 1), zoomStep(ZOOM, 2)]);
    expect(modes().every((m) => m === "user")).toBe(true);
    expect(shownZoom()).toBe(zoomStep(ZOOM, 2));
    // together again: one step back
    pinch(PINCH);
    await flush();
    expect(zooms().at(-1)).toBe(zoomStep(ZOOM, 1));
    expect(pageWheels(client)).toEqual([]);
    // an ordinary wheel still scrolls the page
    fireEvent.wheel(canvasEl(), { clientX: 10, clientY: 10, deltaY: 40, deltaMode: 0 });
    expect(pageWheels(client)).toHaveLength(1);
  });

  it("a pinch before the first frame (nothing to map a point to) is still a zoom, not a scroll", async () => {
    const { client, zooms } = setup();
    await flush();
    expect(pinch(-PINCH)).toBe(false);
    await flush();
    expect(zooms()).toEqual([zoomStep(ZOOM, 1)]);
    expect(pageWheels(client)).toEqual([]);
  });

  it("Ctrl + a mouse wheel notch is one step per notch, as in Chrome", async () => {
    const { zooms } = setup();
    await flush();
    pinch(-120);
    await flush();
    pinch(-120);
    await flush();
    pinch(120);
    await flush();
    expect(zooms()).toEqual([zoomStep(ZOOM, 1), zoomStep(ZOOM, 2), zoomStep(ZOOM, 1)]);
  });

  it("at the largest level a pinch sends nothing more, and pinching back works at once", async () => {
    const { client, zooms } = setup();
    client.browser.zooms.set("p1", LEVELS[LEVELS.length - 1]!);
    await flush();
    for (let i = 0; i < 10; i++) pinch(-PINCH);
    await flush();
    expect(zooms()).toEqual([]);
    pinch(PINCH);
    await flush();
    expect(zooms()).toEqual([LEVELS[LEVELS.length - 2]]);
    expect(pageWheels(client)).toEqual([]);
  });

  it("a zoom step at either end sends nothing (Cmd+= at the largest level)", async () => {
    const { client, zooms } = setup();
    client.browser.zooms.set("p1", LEVELS[0]!);
    await flush();
    fireEvent.keyDown(canvasEl(), { key: "-", code: "Minus", metaKey: true });
    await flush();
    expect(zooms()).toEqual([]);
    expect(shownZoom()).toBe(LEVELS[0]);
  });

  it("monkey: random pinches and wheels — no ctrlKey wheel reaches the page, the zoom stays a level", async () => {
    const { client, zooms } = setup();
    await flush();
    await framed(client);
    await flush();
    let seed = 11;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    let plain = 0;
    for (let i = 0; i < 200; i++) {
      const ctrl = rnd() < 0.7;
      if (!ctrl) plain++;
      fireEvent.wheel(canvasEl(), { clientX: 10, clientY: 10, deltaY: (rnd() - 0.5) * 8 * PINCH, deltaMode: Math.floor(rnd() * 3), ctrlKey: ctrl });
      if (i % 17 === 0) await flush();
    }
    await flush();
    expect(pageWheels(client)).toHaveLength(plain);
    for (const z of zooms()) expect(LEVELS).toContain(z);
    expect(LEVELS).toContain(shownZoom());
  });
});

describe("BrowserPanel: the zoom bubble", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("is not there until the zoom changes; then shows the new % top right and hides after the configured time", async () => {
    setup();
    await flush();
    expect(bubble()).toBeNull();
    fireEvent.keyDown(canvasEl(), { key: "=", code: "Equal", metaKey: true });
    await flush();
    const b = bubble()!;
    expect(b).toBeTruthy();
    expect(within(b).getByText(`%${Math.round(zoomStep(ZOOM, 1) * 100)}`)).toBeTruthy();
    act(() => vi.advanceTimersByTime(BUBBLE_MS - 1));
    expect(bubble()).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(bubble()).toBeNull();
  });

  it("appears for the Görünüm menu and a pinch too", async () => {
    setup();
    await flush();
    act(() => dispatchViewCommand("browser.zoom.out"));
    await flush();
    expect(within(bubble()!).getByText(`%${Math.round(zoomStep(ZOOM, -1) * 100)}`)).toBeTruthy();
    act(() => vi.advanceTimersByTime(BUBBLE_MS));
    expect(bubble()).toBeNull();
    pinch(-PINCH);
    await flush();
    expect(within(bubble()!).getByText(`%${Math.round(ZOOM * 100)}`)).toBeTruthy();
  });

  it("stays while hovered; its − + Sıfırla buttons zoom (user steps) and keep it open; leaving hides it later", async () => {
    const { zooms } = setup();
    await flush();
    fireEvent.keyDown(canvasEl(), { key: "=", code: "Equal", metaKey: true });
    await flush();
    const b = bubble()!;
    fireEvent.mouseEnter(b);
    act(() => vi.advanceTimersByTime(BUBBLE_MS * 5));
    expect(bubble()).toBeTruthy();
    fireEvent.click(within(b).getByRole("button", { name: "Yakınlaştır" }));
    await flush();
    fireEvent.click(within(b).getByRole("button", { name: "Uzaklaştır" }));
    await flush();
    fireEvent.click(within(b).getByRole("button", { name: "Sıfırla" }));
    await flush();
    expect(zooms()).toEqual([zoomStep(ZOOM, 1), zoomStep(ZOOM, 2), zoomStep(ZOOM, 1), null]);
    expect(within(bubble()!).getByText(`%${Math.round(ZOOM * 100)}`)).toBeTruthy();
    act(() => vi.advanceTimersByTime(BUBBLE_MS * 5));
    expect(bubble()).toBeTruthy();
    fireEvent.mouseLeave(bubble()!);
    act(() => vi.advanceTimersByTime(BUBBLE_MS));
    expect(bubble()).toBeNull();
  });

  it("pressing its buttons does not take the focus from the page (Cmd+= keeps working)", async () => {
    setup();
    await flush();
    const c = canvasEl();
    c.focus();
    fireEvent.keyDown(c, { key: "=", code: "Equal", metaKey: true });
    await flush();
    const plus = within(bubble()!).getByRole("button", { name: "Yakınlaştır" });
    // the browser's default action of a press is to focus the button: it is prevented
    expect(fireEvent.mouseDown(plus)).toBe(false);
  });

  it("another app's zoom change does not pop it up here", async () => {
    const { client } = setup();
    await flush();
    client.browser.zooms.set("p1", 1.25);
    act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));
    await flush();
    expect(shownZoom()).toBe(1.25);
    expect(bubble()).toBeNull();
  });
});

describe("BrowserPanel: search engine", () => {
  it("a word is searched with the user's search engine when one is stored", async () => {
    const { client } = setup({ searchUrl: "http://127.0.0.1:9/ara?q=%s" });
    await flush();
    const address = screen.getByLabelText("Adres");
    fireEvent.change(address, { target: { value: "kedi maması" } });
    fireEvent.submit(address.closest("form")!);
    await flush();
    expect(client.callsOf("browser.navigate")).toEqual([{ projectId: "p1", url: "http://127.0.0.1:9/ara?q=kedi%20mamas%C4%B1" }]);
  });
});
