import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuBridge, MenuCommand } from "../../engine/menu-ipc.ts";
import { currentViewMenu, emitMenuCommand, onMenuCommand, reportViewMenu, resendViewMenu, useMenuCommand } from "./menu-commands.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubBridge() {
  let fromMain: ((c: MenuCommand) => void) | null = null;
  const bridge: MenuBridge = {
    onCommand: vi.fn((l: (c: MenuCommand) => void) => {
      fromMain = l;
      return () => (fromMain = null);
    }),
    setViewState: vi.fn(async () => {}),
  };
  vi.stubGlobal("kokpit", { menu: bridge });
  return { bridge, fromMain: (c: MenuCommand) => fromMain?.(c) };
}

describe("menu commands (İş M)", () => {
  it("commands from the native menu reach every subscriber until it unsubscribes", () => {
    const { fromMain } = stubBridge();
    const a = vi.fn();
    const b = vi.fn();
    const offA = onMenuCommand(a);
    const offB = onMenuCommand(b);
    fromMain({ type: "terminal.font.larger" });
    offA();
    fromMain({ type: "browser.zoom.in" });
    offB();
    expect(a.mock.calls).toEqual([[{ type: "terminal.font.larger" }]]);
    expect(b.mock.calls).toEqual([[{ type: "terminal.font.larger" }], [{ type: "browser.zoom.in" }]]);
  });

  it("emitMenuCommand works without Electron (tests, other panels) and a throwing listener does not stop the rest", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen = vi.fn();
    const off1 = onMenuCommand(() => {
      throw new Error("boom");
    });
    const off2 = onMenuCommand(seen);
    emitMenuCommand({ type: "claude.help" });
    expect(seen).toHaveBeenCalledWith({ type: "claude.help" });
    off1();
    off2();
    spy.mockRestore();
  });

  it("useMenuCommand subscribes for the component's lifetime with the latest handler", () => {
    const calls: string[] = [];
    function Probe({ tag }: { tag: string }) {
      useMenuCommand((c) => calls.push(`${tag}:${c.type}`));
      return null;
    }
    const r = render(<Probe tag="a" />);
    emitMenuCommand({ type: "terminal.font.reset" });
    r.rerender(<Probe tag="b" />);
    emitMenuCommand({ type: "terminal.font.reset" });
    r.unmount();
    emitMenuCommand({ type: "terminal.font.reset" });
    expect(calls).toEqual(["a:terminal.font.reset", "b:terminal.font.reset"]);
  });

  it("reportViewMenu forwards only changes to main and keeps the latest for readers", () => {
    const { bridge } = stubBridge();
    const s1 = { panels: [{ id: "files", title: "Dosyalar", checked: true, enabled: true }] };
    reportViewMenu(s1);
    reportViewMenu({ panels: [{ ...s1.panels[0]! }] });
    reportViewMenu({ panels: [{ ...s1.panels[0]!, checked: false }] });
    expect(bridge.setViewState).toHaveBeenCalledTimes(2);
    expect(currentViewMenu()?.panels[0]?.checked).toBe(false);
    // A refused toggle: the same state must reach main again (the native checkbox flipped itself).
    resendViewMenu();
    expect(bridge.setViewState).toHaveBeenCalledTimes(3);
  });
});
