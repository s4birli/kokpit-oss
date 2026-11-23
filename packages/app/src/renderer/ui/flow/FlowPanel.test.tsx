// İş W — Akış paneli: list / select / render (with a fake renderer: jsdom cannot run Mermaid), refresh, update,
// SSH note, isolation of the renderer's output.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowPanel } from "./FlowPanel.tsx";
import { defaultFlowUiConfig, type FlowUiConfig } from "./flow-config.ts";
import type { FlowRenderer } from "./flow-render.ts";
import { MemoryPanelState } from "../panels/memory-state.ts";
import { FAKE_FLOW_UPDATE_COMMAND, FakeEngineClient, makeCard, makeProject, makeSshProject, type FakeFlow } from "../test-utils/fake-client.ts";

const flush = () => act(async () => {});
const project = makeProject("p1", "Alfa");
const CONFIG: FlowUiConfig = { ...defaultFlowUiConfig, pollMs: 1000 };

const GIRIS: FakeFlow = {
  id: "giris.mmd",
  file: "docs/akis/giris.mmd",
  title: "Giriş akışı",
  modifiedAt: "2026-11-16T10:00:00.000Z",
  text: "flowchart TD\n  A-->B",
};
const ODEME: FakeFlow = { id: "odeme.mmd", file: "docs/akis/odeme.mmd", modifiedAt: "2026-11-15T10:00:00.000Z", text: "flowchart LR\n  X-->Y" };

/** Turns the diagram text into a recognisable SVG string. */
function fakeRenderer(impl?: (text: string) => string): FlowRenderer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    render: vi.fn(async (text: string) => {
      calls.push(text);
      return impl ? impl(text) : `<svg xmlns="http://www.w3.org/2000/svg"><text>${text.split("\n")[1]?.trim() ?? ""}</text></svg>`;
    }),
  };
}

function setup(opts: { flows?: FakeFlow[]; renderer?: FlowRenderer; state?: MemoryPanelState; p?: typeof project; card?: ReturnType<typeof makeCard> | null; config?: FlowUiConfig } = {}) {
  const client = new FakeEngineClient({ projects: [project] });
  client.flows = [...(opts.flows ?? [GIRIS, ODEME])];
  const renderer = opts.renderer ?? fakeRenderer();
  const onUpdate = vi.fn(async () => {});
  const state = opts.state ?? new MemoryPanelState();
  const utils = render(
    <FlowPanel
      client={client}
      config={opts.config ?? CONFIG}
      project={opts.p ?? project}
      card={opts.card ?? null}
      state={state}
      renderer={renderer}
      onUpdate={onUpdate}
    />,
  );
  return { client, renderer, onUpdate, state, ...utils };
}

const panel = () => screen.getByRole("region", { name: "Akış" });
const image = () => screen.queryByRole("img", { name: /akış şeması/i }) as HTMLImageElement | null;
const decoded = (img: HTMLImageElement) => decodeURIComponent(img.src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FlowPanel", () => {
  it("lists flows (title or file name) and renders the first one as an image", async () => {
    const { client } = setup();
    await flush();
    const list = within(panel()).getByRole("listbox", { name: "Akışlar" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("Giriş akışı"), expect.stringContaining("odeme.mmd")]);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(client.callsOf("flow.list")).toEqual([{ projectId: "p1" }]);
    expect(client.callsOf("flow.read")).toEqual([{ projectId: "p1", id: "giris.mmd" }]);
    const img = image()!;
    expect(img.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decoded(img)).toContain("<text>A-->B</text>");
  });

  it("selecting another flow reads and renders it, and remembers the choice", async () => {
    const { client, state } = setup();
    await flush();
    fireEvent.click(screen.getByRole("option", { name: /odeme\.mmd/ }));
    await flush();
    expect(client.callsOf("flow.read").at(-1)).toEqual({ projectId: "p1", id: "odeme.mmd" });
    expect(decoded(image()!)).toContain("X-->Y");
    expect(state.get("selected")).toBe("odeme.mmd");
  });

  it("restores the remembered flow", async () => {
    const state = new MemoryPanelState();
    state.set("selected", "odeme.mmd");
    const { client } = setup({ state });
    await flush();
    expect(client.callsOf("flow.read")).toEqual([{ projectId: "p1", id: "odeme.mmd" }]);
  });

  it("a card reads its own worktree", async () => {
    const card = makeCard("c1", "p1");
    const { client } = setup({ card });
    await flush();
    expect(client.callsOf("flow.list")).toEqual([{ cardId: "c1" }]);
    expect(client.callsOf("flow.read")).toEqual([{ cardId: "c1", id: "giris.mmd" }]);
  });

  it("empty: explains, shows the command and offers 'Akışı çiz / güncelle'", async () => {
    const { onUpdate } = setup({ flows: [] });
    await flush();
    expect(within(panel()).getByText(/henüz akış şeması yok/)).toBeTruthy();
    expect(within(panel()).getByText(FAKE_FLOW_UPDATE_COMMAND)).toBeTruthy();
    expect(image()).toBeNull();
    fireEvent.click(within(panel()).getAllByRole("button", { name: "Akışı çiz / güncelle" })[0]!);
    await flush();
    expect(onUpdate).toHaveBeenCalledWith(FAKE_FLOW_UPDATE_COMMAND);
  });

  it("a failing update shows the engine error", async () => {
    const { onUpdate } = setup();
    onUpdate.mockRejectedValueOnce(new Error("kapalı"));
    await flush();
    fireEvent.click(within(panel()).getByRole("button", { name: "Akışı çiz / güncelle" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/Terminal açılamadı: kapalı/);
  });

  it("SSH projects: a note, no button, no requests", async () => {
    const ssh = makeSshProject("s1", "Uzak", "h1", "/srv");
    const { client } = setup({ p: ssh });
    await flush();
    expect(within(panel()).getByText(/SSH projelerinde Akış yok/)).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: "Akışı çiz / güncelle" })).toBeNull();
    expect(client.callsOf("flow.list")).toEqual([]);
    expect(client.callsOf("flow.info")).toEqual([]);
  });

  it("a diagram Mermaid cannot draw shows the error and the text", async () => {
    const renderer: FlowRenderer = { render: vi.fn(async () => Promise.reject(new Error("Parse error on line 2"))) };
    setup({ renderer });
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/Şema çizilemedi: Parse error on line 2/);
    expect(within(panel()).getByText(/A-->B/)).toBeTruthy();
    expect(image()).toBeNull();
  });

  it("never puts the renderer's markup into the page: it only becomes an image source", async () => {
    const evil = `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwned=1</script><a href="javascript:alert(1)"><text>x</text></a><foreignObject><img src="x" onerror="window.__pwned=1"/></foreignObject></svg>`;
    const { container } = setup({ renderer: fakeRenderer(() => evil) });
    await flush();
    expect(image()).not.toBeNull();
    expect(container.querySelector("script, svg, foreignObject, a[href]")).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("polls the list and re-renders when the selected flow changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, renderer } = setup({ flows: [GIRIS] });
    await flush();
    expect((renderer as ReturnType<typeof fakeRenderer>).calls).toHaveLength(1);
    client.flows = [{ ...GIRIS, modifiedAt: "2026-11-16T11:00:00.000Z", text: "flowchart TD\n  A-->C" }, ODEME];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.pollMs);
    });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(decoded(image()!)).toContain("A-->C");
  });

  it("an unchanged list does not read or render again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, renderer } = setup();
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.pollMs * 3);
    });
    expect(client.callsOf("flow.list").length).toBeGreaterThanOrEqual(3);
    expect(client.callsOf("flow.read")).toHaveLength(1);
    expect((renderer as ReturnType<typeof fakeRenderer>).calls).toHaveLength(1);
  });

  it("a terminal change of the project refreshes the list", async () => {
    const { client } = setup({ flows: [], config: { ...CONFIG, pollMs: 0 } });
    await flush();
    client.flows = [GIRIS];
    act(() => client.emitEvent({ name: "terminals.changed", projectId: "p1" } as never));
    await flush();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("zoom buttons scale the diagram; Sığdır resets; Tam ekran toggles", async () => {
    setup();
    await flush();
    const stage = () => image()!.parentElement!.style.transform;
    expect(stage()).toContain("scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "Yakınlaştır" }));
    expect(stage()).toContain(`scale(${1 + CONFIG.zoomStep})`);
    fireEvent.click(screen.getByRole("button", { name: "Uzaklaştır" }));
    fireEvent.click(screen.getByRole("button", { name: "Uzaklaştır" }));
    expect(stage()).toContain(`scale(${1 - CONFIG.zoomStep})`);
    fireEvent.click(screen.getByRole("button", { name: "Sığdır" }));
    expect(stage()).toContain("scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "Tam ekran" }));
    expect(panel().className).toContain("kp-flow--full");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel().className).not.toContain("kp-flow--full");
  });

  it("zoom stays inside the configured bounds", async () => {
    setup();
    await flush();
    for (let i = 0; i < 100; i++) fireEvent.click(screen.getByRole("button", { name: "Yakınlaştır" }));
    expect(image()!.parentElement!.style.transform).toContain(`scale(${CONFIG.zoomMax})`);
    for (let i = 0; i < 100; i++) fireEvent.click(screen.getByRole("button", { name: "Uzaklaştır" }));
    expect(image()!.parentElement!.style.transform).toContain(`scale(${CONFIG.zoomMin})`);
  });

  it("a list error is shown, and the panel recovers on the next poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client } = setup();
    client.fail("flow.list", "INVALID", "bozuk");
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/Akışlar okunamadı: bozuk/);
    client.restore("flow.list");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIG.pollMs);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});
