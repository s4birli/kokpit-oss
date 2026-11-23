// İş Z: React glue of view-prefs — the workbench provides the global terminal font size and access to persisted
// panel state outside the panel's own scope (zoom is per project even when a card is selected, the search engine
// is global). Without a provider (tests, legacy mounts) everything lives in memory with the default config.
import { createContext, useContext, useEffect, useState } from "react";
import { defaultUiConfig } from "./config.ts";
import type { PanelStateStore } from "./layout/contract.ts";
import { createFontSizeStore, type FontSizeStore } from "./view-prefs.ts";

export interface ViewPrefs {
  font: FontSizeStore;
  /** Persisted state of `panelId` in `scope` ("global", "project:<id>", …). */
  panelState(panelId: string, scope: string): PanelStateStore;
}

export function memoryPanelStates(): ViewPrefs["panelState"] {
  const all = new Map<string, Map<string, unknown>>();
  return (panelId, scope) => {
    const id = `${panelId}\u0000${scope}`;
    let m = all.get(id);
    if (!m) all.set(id, (m = new Map()));
    const values = m;
    return {
      get: <T,>(k: string) => values.get(k) as T | undefined,
      set: (k, v) => void (v === undefined ? values.delete(k) : values.set(k, v)),
    };
  };
}

function memoryViewPrefs(): ViewPrefs {
  const panelState = memoryPanelStates();
  return { panelState, font: createFontSizeStore(panelState("terminals", "global"), defaultUiConfig) };
}

export const ViewPrefsContext = createContext<ViewPrefs>(memoryViewPrefs());

export const useViewPrefs = (): ViewPrefs => useContext(ViewPrefsContext);

/** The current terminal font size (re-renders on change) and its store. */
export function useTerminalFontSize(): [number, FontSizeStore] {
  const { font } = useViewPrefs();
  const [px, setPx] = useState(() => font.get());
  useEffect(() => {
    setPx(font.get());
    return font.subscribe(setPx);
  }, [font]);
  return [px, font];
}
