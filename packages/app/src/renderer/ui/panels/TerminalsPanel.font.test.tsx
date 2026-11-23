// İş Z: font size controls and shortcuts of the Terminaller panel.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUiConfig } from "../config.ts";
import type { PanelContext } from "../layout/contract.ts";
import { FakeEngineClient, makeProject, makeProjectTerminal } from "../test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "../test-utils/fake-view.ts";
import { memoryPanelStates, ViewPrefsContext } from "../view-prefs-context.tsx";
import { createFontSizeStore, dispatchViewCommand } from "../view-prefs.ts";
import { TerminalsPanel } from "./TerminalsPanel.tsx";

const flush = () => act(async () => {});
const P1 = makeProject("p1", "Acme");

function setup() {
  const panelState = memoryPanelStates();
  const font = createFontSizeStore(panelState("terminals", "global"), defaultUiConfig);
  const client = new FakeEngineClient({ projects: [P1], terminals: [makeProjectTerminal("t1", "p1", "kabuk")] });
  const views = makeFakeViewFactory();
  const ctx: PanelContext = {
    client,
    config: defaultUiConfig,
    createView: views.factory,
    project: P1,
    card: null,
    state: panelState("terminals", "project:p1"),
    reveal: vi.fn(),
    select: vi.fn(),
    focus: null,
  };
  render(
    <ViewPrefsContext.Provider value={{ font, panelState }}>
      <TerminalsPanel ctx={ctx} />
    </ViewPrefsContext.Provider>,
  );
  return { font, views, client };
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Terminaller: font size", () => {
  it("the bar has no font-size controls (room for the terminal); tabs, Böl and + Yeni terminal stay", async () => {
    setup();
    await flush();
    expect(screen.queryByRole("group", { name: "Yazı boyutu" })).toBeNull();
    for (const name of ["Yazıyı büyüt", "Yazıyı küçült", /sıfırla/]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    for (const name of ["Böl", "+ Yeni terminal ▾"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("the shortcuts change the global size, every terminal follows and the panel carries the size in effect", async () => {
    const { font, views } = setup();
    await flush();
    const panel = screen.getByRole("region", { name: "Terminaller" });
    const host = views.views[0]!.container!;
    expect(panel.getAttribute("data-font-size")).toBe(String(defaultUiConfig.terminalFontSize));
    fireEvent.keyDown(host, { key: "=", metaKey: true });
    fireEvent.keyDown(host, { key: "=", metaKey: true });
    expect(font.get()).toBe(14);
    expect(panel.getAttribute("data-font-size")).toBe("14");
    fireEvent.keyDown(host, { key: "-", metaKey: true });
    expect(font.get()).toBe(13);
    expect(views.views[0]!.fontSizes).toEqual([12, 13, 14, 13]);
    fireEvent.keyDown(host, { key: "0", metaKey: true });
    expect(font.get()).toBe(defaultUiConfig.terminalFontSize);
  });

  it("Cmd+= / Ctrl+- / Cmd+0 inside the panel change it and never reach the terminal; plain keys do", async () => {
    const { font, views } = setup();
    await flush();
    const host = views.views[0]!.container!;
    const typed: string[] = [];
    host.addEventListener("keydown", (e) => typed.push(e.key));
    fireEvent.keyDown(host, { key: "=", metaKey: true });
    expect(font.get()).toBe(13);
    fireEvent.keyDown(host, { key: "-", ctrlKey: true });
    fireEvent.keyDown(host, { key: "-", metaKey: true });
    expect(font.get()).toBe(11);
    fireEvent.keyDown(host, { key: "0", metaKey: true });
    expect(font.get()).toBe(12);
    expect(typed).toEqual([]);
    fireEvent.keyDown(host, { key: "a" });
    expect(typed).toEqual(["a"]);
  });

  it("menu commands are not handled by the panel (the workbench owns them, so they never apply twice)", async () => {
    const { font } = setup();
    await flush();
    dispatchViewCommand("terminal.font.larger");
    expect(font.get()).toBe(12);
  });
});
