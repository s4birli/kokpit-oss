// İş M — the renderer side of the native menu bar. One in-page event bus for MenuCommands: the preload's
// `window.kokpit.menu` feeds it, any component subscribes. This is the API for the other panels:
//
//   import { onMenuCommand, useMenuCommand } from "../menu/menu-commands.ts";
//   useMenuCommand((c) => { if (c.type === "terminal.font.larger") … });       // React, for the component's lifetime
//   const off = onMenuCommand((c) => …);                                       // anywhere; call off() to stop
//   emitMenuCommand({ type: "claude.help" });                                  // tests / in-app triggers
//
// Commands: see MenuCommand in engine/menu-ipc.ts (layout.reset, panel.toggle, site.open, settings.open,
// terminal.font.smaller|larger|reset, browser.zoom.out|in|reset, claude.help). The workbench forwards the font/zoom
// ones to view-prefs.ts (İş Z) and claude.help to the Claude panel's Rehber (İş C).
import { useEffect, useRef } from "react";
import type { MenuBridge, MenuCommand, ViewMenuState } from "../../engine/menu-ipc.ts";

type Listener = (c: MenuCommand) => void;

const listeners = new Set<Listener>();
let attached: { bridge: MenuBridge; off: () => void } | null = null;
let current: ViewMenuState | null = null;
let lastSent: string | null = null;

function bridge(): MenuBridge | undefined {
  return typeof window === "undefined" ? undefined : window.kokpit?.menu;
}

/** Hooks the bus to the preload's menu bridge once (again if the bridge object changed, e.g. in tests). */
function attach(): void {
  const b = bridge();
  if (!b || attached?.bridge === b) return;
  attached?.off();
  attached = { bridge: b, off: b.onCommand(emitMenuCommand) };
}

/** Delivers `c` to every subscriber; one failing subscriber does not stop the others. */
export function emitMenuCommand(c: MenuCommand): void {
  for (const l of [...listeners]) {
    try {
      l(c);
    } catch (err) {
      console.error("[kokpit] menu command failed", c.type, err);
    }
  }
}

/** Subscribes to menu commands; returns the unsubscribe. */
export function onMenuCommand(listener: Listener): () => void {
  attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React: `handler` (always the latest) gets every menu command while the component is mounted. */
export function useMenuCommand(handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onMenuCommand((c) => ref.current(c)), []);
}

/** The layout host reports what Görünüm should show; only changes travel to main. */
export function reportViewMenu(state: ViewMenuState): void {
  current = state;
  const json = JSON.stringify(state);
  const b = bridge();
  if (!b || (json === lastSent && attached?.bridge === b)) return;
  attach();
  lastSent = json;
  void b.setViewState(state).catch((err: unknown) => console.warn("[kokpit] menü güncellenemedi", err));
}

/**
 * Sends the last state again even if unchanged: a native checkbox flips itself when clicked, so after a toggle the
 * host refused (or that changed nothing) the menu must be told the truth again.
 */
export function resendViewMenu(): void {
  lastSent = null;
  if (current) reportViewMenu(current);
}

/** The last reported Görünüm state (tests, diagnostics). */
export function currentViewMenu(): ViewMenuState | null {
  return current;
}
