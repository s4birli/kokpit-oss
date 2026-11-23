// İş M — Web panel: site tabs over native views; the panel only reports rectangles and tab changes to the bridge.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelStateStore } from "../layout/contract.ts";
import { FakeWebBridge, TEST_SITES } from "../test-utils/fake-web.ts";
import { WebPanel, webPanel } from "./WebPanel.tsx";

function memoryState(initial: Record<string, unknown> = {}): PanelStateStore & { values: Record<string, unknown> } {
  const values: Record<string, unknown> = { ...initial };
  return {
    values,
    get: <T,>(k: string) => values[k] as T | undefined,
    set: (k, v) => {
      values[k] = JSON.parse(JSON.stringify(v)) as unknown;
    },
  };
}

function manualFrames() {
  let pending: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      pending.push(cb);
      return () => {
        pending = pending.filter((f) => f !== cb);
      };
    },
    tick: async () => {
      const run = pending;
      pending = [];
      await act(async () => {
        for (const f of run) f();
      });
    },
  };
}

const rect = { x: 10, y: 20, width: 800, height: 600 };
function mockRect() {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON() {} }) as DOMRect,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const flush = () => act(async () => {});
// Without an open site the bar is hidden (no empty row); the group is still in the document.
const strip = () => screen.getByRole("group", { name: "Site sekmeleri", hidden: true });
const tabTitles = () => within(strip()).queryAllByRole("button", { name: /^(?!.*kapat$)/ }).map((b) => b.textContent);
const activeTitle = () => within(strip()).queryAllByRole("button", { pressed: true }).map((b) => b.textContent)[0] ?? null;

async function setup(initial: Record<string, unknown> = {}, focus: { siteId?: string; seq: number } | null = null, bridge = new FakeWebBridge()) {
  mockRect();
  const frames = manualFrames();
  const state = memoryState(initial);
  const el = (f: typeof focus) => <WebPanel state={state} focus={f} bridge={bridge} schedule={frames.schedule} />;
  const r = render(el(focus));
  await flush();
  return { bridge, frames, state, rerender: (f: typeof focus) => r.rerender(el(f)), unmount: r.unmount };
}

describe("WebPanel (İş M)", () => {
  it("panel definition: Web, global state, available everywhere", () => {
    expect(webPanel.id).toBe("web");
    expect(webPanel.title).toBe("Web");
    expect(webPanel.stateScope).toBe("global");
    expect(webPanel.available({ project: null, card: null })).toBe(true);
  });

  it("outside Electron it explains itself", () => {
    render(<WebPanel state={memoryState()} focus={null} bridge={undefined} />);
    expect(screen.getByText("Web sekmeleri yalnız Kokpit uygulamasında açılır.")).toBeTruthy();
  });

  it("no tabs: offers the sites; picking one opens its tab and shows its view over the surface", async () => {
    const { bridge, frames, state } = await setup();
    expect(screen.getByText(/Açık site yok/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wiki" }));
    await flush();
    await frames.tick();
    expect(tabTitles()).toEqual(["Wiki"]);
    expect(activeTitle()).toBe("Wiki");
    expect(bridge.show).toHaveBeenLastCalledWith({ siteId: "wiki", bounds: rect });
    expect(state.values).toEqual({ tabs: ["wiki"], active: "wiki" });
  });

  it("restores saved tabs; a focus request (Git menu) opens another one and makes it active", async () => {
    const s = await setup({ tabs: ["home", "wiki"], active: "wiki" });
    await s.frames.tick();
    expect(tabTitles()).toEqual(["Ana sayfa", "Wiki"]);
    expect(s.bridge.shown()).toEqual(["wiki"]);
    s.rerender({ siteId: "notlar", seq: 1 });
    await flush();
    await s.frames.tick();
    expect(tabTitles()).toEqual(["Ana sayfa", "Wiki", "Notlar"]);
    expect(activeTitle()).toBe("Notlar");
    // Leaving wiki hides its view; notlar is shown.
    expect(s.bridge.calls.slice(-2)).toEqual([
      ["hide", "wiki"],
      ["show", "notlar", rect],
    ]);
    // An already open site is just selected, not duplicated; the same seq is not replayed.
    s.rerender({ siteId: "home", seq: 2 });
    await flush();
    s.rerender({ siteId: "home", seq: 2 });
    await flush();
    expect(tabTitles()).toEqual(["Ana sayfa", "Wiki", "Notlar"]);
    expect(activeTitle()).toBe("Ana sayfa");
    expect(s.state.values).toEqual({ tabs: ["home", "wiki", "notlar"], active: "home" });
  });

  it("closing a tab destroys its view and activates a neighbour", async () => {
    const s = await setup({ tabs: ["home", "wiki", "notlar"], active: "wiki" });
    fireEvent.click(screen.getByRole("button", { name: "Wiki sekmesini kapat" }));
    await flush();
    expect(s.bridge.close).toHaveBeenCalledWith("wiki");
    expect(tabTitles()).toEqual(["Ana sayfa", "Notlar"]);
    expect(activeTitle()).toBe("Notlar");
    fireEvent.click(screen.getByRole("button", { name: "Notlar sekmesini kapat" }));
    fireEvent.click(screen.getByRole("button", { name: "Ana sayfa sekmesini kapat" }));
    await flush();
    expect(s.state.values).toEqual({ tabs: [], active: null });
    expect(screen.getByText(/Açık site yok/)).toBeTruthy();
  });

  it("status and reload of the active site", async () => {
    const s = await setup({ tabs: ["home"], active: "home" });
    s.bridge.emitStatus({ siteId: "home", status: "ready" });
    expect(screen.getByRole("status").textContent).toBe("Açık");
    s.bridge.emitStatus({ siteId: "wiki", status: "failed" });
    expect(screen.getByRole("status").textContent).toBe("Açık");
    s.bridge.emitStatus({ siteId: "home", status: "failed" });
    expect(screen.getByRole("status").textContent).toBe("Açılamadı");
    fireEvent.click(screen.getByRole("button", { name: "Yenile" }));
    expect(s.bridge.reload).toHaveBeenCalledWith("home");
  });

  it("a plain-http Tailscale site is marked in its tab; when Tailscale does not vouch for it the panel says so plainly", async () => {
    const pano = { id: "nas-pano", title: "NAS panosu", url: "http://100.64.113.61:9119/" };
    const s = await setup({ tabs: ["home", "nas-pano"], active: "nas-pano" }, null, new FakeWebBridge([...TEST_SITES, pano]));
    // The mark sits next to the title (the tab's own text stays the title); https tabs have none.
    expect(tabTitles()).toEqual(["Ana sayfa", "NAS panosu"]);
    const badges = within(strip()).getAllByText("http · Tailscale");
    expect(badges).toHaveLength(1);
    expect(badges[0]!.getAttribute("title")).toMatch(/Düz http/);
    expect(screen.queryByRole("alert")).toBeNull();

    s.bridge.emitStatus({ siteId: "nas-pano", status: "tailnet" });
    expect(screen.getByRole("status").textContent).toBe("Tailscale yok");
    expect(screen.getByRole("alert").textContent).toBe("Tailscale kapalı ya da bu adres tailnet'inde değil; düz http ile açılmadı.");
    // Yenile asks main to check again; once it loads the message goes away.
    fireEvent.click(screen.getByRole("button", { name: "Yenile" }));
    expect(s.bridge.reload).toHaveBeenCalledWith("nas-pano");
    s.bridge.emitStatus({ siteId: "nas-pano", status: "ready" });
    expect(screen.queryByRole("alert")).toBeNull();
    // Another site's refusal is not shown over the active one.
    s.bridge.emitStatus({ siteId: "home", status: "tailnet" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a site removed in Ayarlar loses its tab; renamed sites show the new title", async () => {
    const s = await setup({ tabs: ["home", "wiki"], active: "wiki" });
    s.bridge.emitSites([{ ...TEST_SITES[0]!, title: "Ev" }]);
    await flush();
    expect(tabTitles()).toEqual(["Ev"]);
    expect(activeTitle()).toBe("Ev");
  });

  it("junk saved state and unknown focus ids are ignored", async () => {
    await setup({ tabs: ["home", 7, "nope", "home", null], active: "evil" }, { siteId: "nope", seq: 1 });
    expect(tabTitles()).toEqual(["Ana sayfa"]);
    expect(activeTitle()).toBe("Ana sayfa");
  });

  it("unmounting hides the active view (the session keeps running)", async () => {
    const s = await setup({ tabs: ["home"], active: "home" });
    await s.frames.tick();
    s.unmount();
    expect(s.bridge.calls.at(-1)).toEqual(["hide", "home"]);
  });

  it("monkey: random opens/closes/selects keep tabs unique and the active tab among them", async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const s = await setup();
    let seq = 0;
    for (let i = 0; i < 120; i++) {
      const r = rnd();
      const site = TEST_SITES[Math.floor(rnd() * TEST_SITES.length)]!;
      if (r < 0.4) s.rerender({ siteId: rnd() < 0.9 ? site.id : "../x", seq: ++seq });
      else if (r < 0.7) {
        const close = screen.queryByRole("button", { name: `${site.title} sekmesini kapat` });
        if (close) fireEvent.click(close);
      } else {
        const tab = within(strip()).queryByRole("button", { name: site.title });
        if (tab) fireEvent.click(tab);
      }
      await flush();
      const tabs = s.state.values.tabs as string[] | undefined;
      if (tabs) {
        expect(new Set(tabs).size).toBe(tabs.length);
        const active = s.state.values.active as string | null;
        expect(active === null ? tabs.length === 0 : tabs.includes(active)).toBe(true);
      }
    }
  });
});
