// "Tarayıcı her zaman panele sığsın": the picture is fitted into the panel's picture area, and the engine is told
// that area's size (the page viewport follows it) — only while it is measurable, never 0×0.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, type FrameDrawer } from "./BrowserPanel.tsx";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { FakeResizeObserver } from "./test-utils/fake-view.ts";

const flush = () => act(async () => {});
const DPR = 2;
const VIEW_CLASS = "kp-browser__view";

/** The picture area's size as the layout would report it (jsdom has no layout). */
let box = { width: 0, height: 0 };
/** Size of the frames the fake drawer "decodes". */
let image = { width: 1280, height: 800 };

function setup(opts: { project?: string } = {}) {
  const id = opts.project ?? "p1";
  const project = makeProject(id, "Alfa");
  const client = new FakeEngineClient({ projects: [project] });
  client.browser.handlers["browser.open"]({ projectId: id });
  const draw: FrameDrawer = async () => ({ ...image });
  const panel = () => <BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} />;
  const utils = render(panel());
  return { client, panel, ...utils };
}

const canvas = () => screen.getByLabelText("Tarayıcı görüntüsü") as HTMLCanvasElement;
const cssSize = (el: HTMLElement) => ({ width: Number.parseFloat(el.style.width), height: Number.parseFloat(el.style.height) });

/** Lets the debounced resize handler run. */
async function resized(next: { width: number; height: number }): Promise<void> {
  box = next;
  act(() => FakeResizeObserver.triggerAll());
  await act(async () => {
    await new Promise((r) => setTimeout(r, defaultUiConfig.resizeDebounceMs + 30));
  });
}

beforeEach(() => {
  box = { width: 0, height: 0 };
  image = { width: 1280, height: 800 };
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("devicePixelRatio", DPR);
  for (const [prop, key] of [
    ["clientWidth", "width"],
    ["clientHeight", "height"],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, prop, "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(VIEW_CLASS) ? box[key] : 0;
    });
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowserPanel: the page viewport follows the panel", () => {
  it("a measurable panel: its size goes to the engine before the screencast starts, bounded by the panel's device px", async () => {
    box = { width: 667, height: 380 };
    const { client } = setup();
    await flush();
    expect(client.callsOf("browser.viewport.set")).toEqual([{ projectId: "p1", width: 667, height: 380 }]);
    expect(client.callsOf("browser.screencast.start")).toEqual([
      { projectId: "p1", maxWidth: 667 * DPR, maxHeight: 380 * DPR, quality: defaultUiConfig.browserQuality },
    ]);
    const order = client.calls.map((c) => c.method).filter((m) => m === "browser.viewport.set" || m === "browser.screencast.start");
    expect(order).toEqual(["browser.viewport.set", "browser.screencast.start"]);
  });

  it("a hidden (0×0) or uselessly small panel never pushes a size", async () => {
    const { client } = setup();
    await flush();
    expect(client.callsOf("browser.viewport.set")).toEqual([]);
    await resized({ width: defaultUiConfig.browserMinViewport - 1, height: 400 });
    await resized({ width: 400, height: defaultUiConfig.browserMinViewport - 1 });
    expect(client.callsOf("browser.viewport.set")).toEqual([]);
    // It becomes visible: now the size is sent, and the screencast is bounded by it.
    await resized({ width: 500, height: 300 });
    expect(client.callsOf("browser.viewport.set")).toEqual([{ projectId: "p1", width: 500, height: 300 }]);
    expect(client.callsOf("browser.screencast.start").at(-1)).toMatchObject({ maxWidth: 500 * DPR, maxHeight: 300 * DPR });
  });

  it("resizes are debounced into one request; hiding sends nothing and showing again asserts the size", async () => {
    box = { width: 667, height: 380 };
    const { client } = setup();
    await flush();
    box = { width: 700, height: 390 };
    act(() => FakeResizeObserver.triggerAll());
    box = { width: 800, height: 400 };
    act(() => FakeResizeObserver.triggerAll());
    await resized({ width: 900, height: 420 });
    expect(client.callsOf("browser.viewport.set").slice(1)).toEqual([{ projectId: "p1", width: 900, height: 420 }]);
    // The same size again: nothing to say.
    await resized({ width: 900, height: 420 });
    expect(client.callsOf("browser.viewport.set")).toHaveLength(2);
    // Hidden (another dock tab, another view): the engine keeps the last size — agents keep a stable viewport.
    await resized({ width: 0, height: 0 });
    expect(client.callsOf("browser.viewport.set")).toHaveLength(2);
    const starts = client.callsOf("browser.screencast.start").length;
    // Shown again at the same size: asserted again (heals whatever happened meanwhile), no screencast restart.
    await resized({ width: 900, height: 420 });
    expect(client.callsOf("browser.viewport.set").at(-1)).toEqual({ projectId: "p1", width: 900, height: 420 });
    expect(client.callsOf("browser.viewport.set").map((c) => `${c.width}x${c.height}`)).toEqual(["667x380", "900x420", "900x420"]);
    expect(client.callsOf("browser.screencast.start")).toHaveLength(starts);
  });

  it("the size is asserted again on reconnect and when the window gets focus or becomes visible", async () => {
    box = { width: 667, height: 380 };
    const { client } = setup();
    await flush();
    act(() => client.emitReconnected());
    await flush();
    expect(client.callsOf("browser.viewport.set")).toHaveLength(2);
    expect(client.callsOf("browser.screencast.start")).toHaveLength(2);
    act(() => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(client.callsOf("browser.viewport.set")).toHaveLength(3);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(client.callsOf("browser.viewport.set")).toHaveLength(4);
    expect(client.callsOf("browser.viewport.set").at(-1)).toEqual({ projectId: "p1", width: 667, height: 380 });
    // Neither restarts the screencast.
    expect(client.callsOf("browser.screencast.start")).toHaveLength(2);
  });

  it("an engine that refuses the size (older engine) is not shown as an error", async () => {
    box = { width: 667, height: 380 };
    const project = makeProject("p1", "Alfa");
    const client = new FakeEngineClient({ projects: [project] });
    client.browser.handlers["browser.open"]({ projectId: "p1" });
    client.fail("browser.viewport.set", "INVALID", "unknown method");
    render(<BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={async () => ({ ...image })} />);
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.callsOf("browser.screencast.start")).toHaveLength(1);
  });
});

describe("BrowserPanel: the picture always fits the panel", () => {
  it("a frame wider than the panel is letterboxed: scaled to the panel's height, never larger than the panel", async () => {
    box = { width: 934, height: 215 };
    image = { width: 1600, height: 891 };
    const { client } = setup();
    await flush();
    client.browser.emitFrame("p1", { deviceWidth: 1600, deviceHeight: 891 });
    await flush();
    const size = cssSize(canvas());
    expect(size.height).toBe(215);
    expect(size.width).toBe(Math.floor((1600 * 215) / 891));
    expect(size.width).toBeLessThanOrEqual(box.width);
  });

  it("a frame taller than the panel is scaled to the panel's width; a small frame is scaled up to fill", async () => {
    box = { width: 400, height: 600 };
    image = { width: 1600, height: 891 };
    const { client } = setup();
    await flush();
    client.browser.emitFrame("p1");
    await flush();
    expect(cssSize(canvas())).toEqual({ width: 400, height: Math.floor((891 * 400) / 1600) });
    image = { width: 200, height: 300 };
    client.browser.emitFrame("p1");
    await flush();
    expect(cssSize(canvas())).toEqual({ width: 400, height: 600 });
  });

  it("the panel is resized: the picture is refitted at once (before the debounced engine request)", async () => {
    box = { width: 800, height: 500 };
    image = { width: 1000, height: 625 };
    const { client } = setup();
    await flush();
    client.browser.emitFrame("p1");
    await flush();
    expect(cssSize(canvas())).toEqual({ width: 800, height: 500 });
    box = { width: 800, height: 250 };
    act(() => FakeResizeObserver.triggerAll());
    expect(cssSize(canvas())).toEqual({ width: 400, height: 250 });
    expect(client.callsOf("browser.viewport.set")).toHaveLength(1);
  });

  it("monkey: whatever the panel and the frame, the canvas never exceeds the panel and keeps the frame's shape", async () => {
    box = { width: 500, height: 300 };
    const { client } = setup();
    await flush();
    for (let i = 1; i <= 40; i++) {
      box = { width: 64 + ((i * 7919) % 2400), height: 64 + ((i * 104729) % 1400) };
      image = { width: 16 + ((i * 31337) % 3000), height: 16 + ((i * 1009) % 2000) };
      act(() => FakeResizeObserver.triggerAll());
      client.browser.emitFrame("p1");
      await flush();
      const size = cssSize(canvas());
      expect(size.width, `w ${i}`).toBeLessThanOrEqual(box.width);
      expect(size.height, `h ${i}`).toBeLessThanOrEqual(box.height);
      // The largest box of the frame's shape: one side touches the panel, the other follows the frame (whole px).
      const scale = Math.min(box.width / image.width, box.height / image.height);
      expect(size.width === box.width || size.height === box.height, `fills ${i}`).toBe(true);
      expect(Math.abs(size.width - image.width * scale), `shape w ${i}`).toBeLessThanOrEqual(1);
      expect(Math.abs(size.height - image.height * scale), `shape h ${i}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("BrowserPanel: two panels of one project share the screencast", () => {
  it("unmounting one of them does not stop the stream the other one shows", async () => {
    box = { width: 667, height: 380 };
    const { client, panel, unmount } = setup();
    const second = render(panel());
    await flush();
    unmount();
    await flush();
    expect(client.callsOf("browser.screencast.stop")).toEqual([]);
    // The remaining panel still draws frames.
    client.browser.emitFrame("p1");
    await flush();
    expect(canvas().getAttribute("data-frames")).toBe("1");
    second.unmount();
    await flush();
    expect(client.callsOf("browser.screencast.stop")).toEqual([{ projectId: "p1" }]);
  });
});
