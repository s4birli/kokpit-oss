// İş L — Modüler düzen inside the workbench: Görünüm, persistence of layout + selection, Ajanlar → reveal.
import type { Project } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench.tsx";
import { FakeEngineClient, makeCard, makeProject, makeProjectTerminal, makeTerminal } from "./test-utils/fake-client.ts";
import { fakeUiStateBridge, type FakeUiStateBridge } from "./test-utils/fake-ui-state.ts";
import { FakeResizeObserver, makeFakeViewFactory, type FakeViewFactory } from "./test-utils/fake-view.ts";
import { defaultLayoutConfig } from "./layout/config.ts";
import { layoutOwnerOf, NO_PROJECT_OWNER } from "./layout/ui-state.ts";
import { activeTerminalTitle, isDockTab, launchTerminal, showTerminal } from "./test-utils/terminal-tabs.ts";
import { menuChecked, menuTitles, menuToggle } from "./test-utils/fake-menu.ts";

const flush = () => act(async () => {});

function seed() {
  return new FakeEngineClient({
    projects: [makeProject("p1", "Alfa"), makeProject("p2", "Beta")],
    cards: [makeCard("a", "p1", "Kart A")],
    terminals: [makeProjectTerminal("tp1", "p1", "P-1"), makeTerminal("ta1", "a", "A-1", "p1"), makeTerminal("ta2", "a", "A-2", "p1")],
  });
}

let views: FakeViewFactory;
const config = { ...defaultLayoutConfig, saveDebounceMs: 5 };

async function setup(bridge: FakeUiStateBridge | null, client = seed()) {
  views = makeFakeViewFactory();
  const r = render(<Workbench client={client} onOpenSettings={() => {}} createView={views.factory} uiState={bridge} layoutConfig={config} />);
  await flush();
  return { client, ...r };
}

const rail = () => screen.getByRole("navigation");
const tabs = () => screen.queryAllByRole("tab").filter(isDockTab).map((t) => t.getAttribute("aria-label"));
const headerTitle = () => document.querySelector(".kp-header__title")?.textContent;
const viewOf = (terminalId: string) => views.views.find((v) => !v.disposed && v.container?.closest(`[data-terminal-id="${terminalId}"]`));

async function click(el: HTMLElement) {
  fireEvent.click(el);
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

describe("Workbench: modüler düzen", () => {
  it("the rail stays outside the dock; the dock holds the default panels", async () => {
    await setup(null);
    await click(within(rail()).getByRole("button", { name: "Alfa" }));
    expect(tabs().sort()).toEqual(["Ajanlar", "Dosyalar", "Tarayıcı", "Terminal"].sort());
    expect(rail().closest(".kp-dock-root")).toBeNull();
    expect(screen.getByRole("region", { name: "Terminal: P-1" })).toBeTruthy();
  });

  it("restores layout, the selected card and its active terminal tab after a restart (same userData)", async () => {
    const bridge = fakeUiStateBridge();
    const first = await setup(bridge);
    await click(within(rail()).getByRole("button", { name: "Kart A" }));
    expect(activeTerminalTitle()).toBe("A-1");
    await showTerminal("A-2");
    menuToggle("Ajanlar");
    await flush();
    menuToggle("Akış");
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, config.saveDebounceMs * 4));
    });
    first.unmount();
    await flush();

    await setup(bridge);
    expect(headerTitle()).toBe("Kart A");
    expect(within(rail()).getByRole("button", { name: "Kart A" }).getAttribute("aria-current")).toBe("true");
    expect(tabs().sort()).toEqual(["Akış", "Dosyalar", "Tarayıcı", "Terminal"].sort());
    expect(activeTerminalTitle()).toBe("A-2");
    expect(screen.getByRole("region", { name: "Terminal: A-2" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Terminal: A-1" })).toBeNull();
  });

  it("unmount flushes a pending save", async () => {
    const bridge = fakeUiStateBridge();
    const first = await setup(bridge);
    await click(within(rail()).getByRole("button", { name: "Beta" }));
    first.unmount();
    await flush();
    expect(bridge.saved.at(-1)).toMatchObject({ selection: { kind: "project", projectId: "p2" } });
  });

  it("a corrupt state file gives the default layout and no selection", async () => {
    await setup(fakeUiStateBridge({ version: 1, layouts: { normal: { grid: "x" } }, panels: [], selection: "p1" }));
    expect(headerTitle()).toBe("Proje seçilmedi");
    expect(tabs().sort()).toEqual(["Ajanlar", "Dosyalar", "Tarayıcı", "Terminal"].sort());
    // Tarayıcı/Dosyalar need a project: they say so instead of rendering.
    expect(screen.getAllByText("Soldan bir proje ya da kart seç.").length).toBeGreaterThan(0);
  });

  it("İş D: each project tab has its own layout; Görünüm's marks follow the tab; both survive a restart", async () => {
    const bridge = fakeUiStateBridge();
    const first = await setup(bridge);
    await click(within(rail()).getByRole("button", { name: "Alfa" }));
    menuToggle("Ajanlar");
    await flush();
    await click(within(rail()).getByRole("button", { name: "Beta" }));
    expect(tabs().sort()).toEqual(["Ajanlar", "Dosyalar", "Tarayıcı", "Terminal"].sort());
    expect(menuChecked("Ajanlar")).toBe(true);
    menuToggle("Akış");
    await flush();
    await click(within(rail()).getByRole("button", { name: "Alfa" }));
    expect(tabs().sort()).toEqual(["Dosyalar", "Tarayıcı", "Terminal"].sort());
    expect(menuChecked("Ajanlar")).toBe(false);
    expect(menuChecked("Akış")).toBe(false);
    // The project's terminal is still there after the swaps.
    expect(screen.getByRole("region", { name: "Terminal: P-1" })).toBeTruthy();
    first.unmount();
    await flush();

    await setup(bridge);
    expect(headerTitle()).toBe("Alfa");
    expect(tabs().sort()).toEqual(["Dosyalar", "Tarayıcı", "Terminal"].sort());
    await click(within(rail()).getByRole("button", { name: "Beta" }));
    expect(tabs().sort()).toEqual(["Ajanlar", "Akış", "Dosyalar", "Tarayıcı", "Terminal"].sort());
    expect(menuChecked("Akış")).toBe(true);
  });

  it("İş D: a deleted project's layout is forgotten; the other projects keep theirs", async () => {
    const bridge = fakeUiStateBridge();
    const { client } = await setup(bridge);
    for (const name of ["Alfa", "Beta"]) {
      await click(within(rail()).getByRole("button", { name }));
      menuToggle("Ajanlar");
      await flush();
    }
    const stored = async (): Promise<string[]> => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, config.saveDebounceMs * 4));
      });
      return Object.keys((bridge.stored as { layouts: { projects: Record<string, unknown> } }).layouts.projects).sort();
    };
    // D1: only what the user arranged is stored — "no project" was only ever shown, never changed.
    expect(await stored()).toEqual([layoutOwnerOf("p1"), layoutOwnerOf("p2")].sort());
    await act(async () => {
      client.projects = client.projects.filter((p) => p.id !== "p2");
      client.emitEvent({ type: "event", name: "projects.changed" });
    });
    await flush();
    expect(headerTitle()).toBe("Alfa");
    expect(tabs().sort()).toEqual(["Dosyalar", "Tarayıcı", "Terminal"].sort());
    expect(await stored()).toEqual([layoutOwnerOf("p1")]);
  });

  it("Ajanlar → a terminal while the Terminal panel is closed: reveal opens it and focuses that terminal", async () => {
    await setup(null);
    await click(within(rail()).getByRole("button", { name: "Alfa" }));
    menuToggle("Terminal");
    await flush();
    expect(tabs()).not.toContain("Terminal");
    const agents = within(screen.getByRole("main")).getByRole("region", { name: "Ajanlar" });
    // A-2 is not the card's first tab: reveal must activate it, not just open the panel.
    await click(within(agents).getByRole("button", { name: /^A-2/ }));
    expect(tabs()).toContain("Terminal");
    expect(within(rail()).getByRole("button", { name: "Kart A" }).getAttribute("aria-current")).toBe("true");
    expect(activeTerminalTitle()).toBe("A-2");
    expect(screen.getByRole("region", { name: "Terminal: A-2" })).toBeTruthy();
    expect(viewOf("ta2")?.focuses).toBe(1);
    expect(viewOf("ta1")?.focuses).toBe(0);
  });



  it("the launcher lives in the Terminal panel only: closed panel → none; Görünüm › Terminal brings it back", async () => {
    const { client } = await setup(null);
    await click(within(rail()).getByRole("button", { name: "Alfa" }));
    menuToggle("Terminal");
    await flush();
    expect(tabs()).not.toContain("Terminal");
    expect(screen.queryByRole("button", { name: /Yeni terminal/ })).toBeNull();
    expect(screen.queryByLabelText("Başlangıç komutu")).toBeNull();
    menuToggle("Terminal");
    await flush();
    expect(tabs()).toContain("Terminal");
    await launchTerminal();
    expect(client.callsOf("terminal.open")).toHaveLength(1);
    // The new terminal is the active, focused tab.
    const opened = client.terminals.at(-1)!;
    expect(activeTerminalTitle()).toBe(opened.title);
    expect(viewOf(opened.id)?.focuses).toBe(1);
  });
});
