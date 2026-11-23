// İş L: every dockable panel, in Görünüm order. One import line per panel: a panel's owner replaces only its own
// line with `import { <name>Panel } from "<their module>";` and leaves the PANEL_ENTRIES array alone.
// A panel of an optional module names its feature (kokpit.features.json) and is registered only while it is on.
import { BUILD_FEATURES, type FeatureSet } from "@kokpit/shared";
import type { PanelDefinition, PanelId } from "./contract.ts";
import { filesPanel } from "../panels/FilesPanel.tsx";
import { browserPanel } from "../panels/BrowserTabsPanel.tsx";
import { terminalsPanel } from "../panels/TerminalsPanel.tsx";
import { agentsPanel } from "./legacy-panels.tsx";
import { mapPanel } from "./legacy-panels.tsx";
import { flowPanel } from "../flow/flow-panel.tsx"; // İş W
import { claudePanel } from "../panels/ClaudePanel.tsx";
import { webPanel } from "../panels/WebPanel.tsx";

export interface PanelEntry {
  panel: PanelDefinition;
  /** The optional module the panel belongs to; absent = core. */
  feature?: string;
}

export const PANEL_ENTRIES: readonly PanelEntry[] = [
  { panel: filesPanel },
  { panel: browserPanel },
  { panel: terminalsPanel },
  { panel: agentsPanel },
  { panel: mapPanel },
  { panel: flowPanel }, // İş W
  { panel: claudePanel },
  { panel: webPanel },
];

/** The panels whose module is built in and on (core panels always). */
export function enabledPanels(entries: readonly PanelEntry[], features: Pick<FeatureSet, "isEnabled">): PanelDefinition[] {
  return entries.filter((e) => e.feature === undefined || features.isEnabled(e.feature)).map((e) => e.panel);
}

export const PANELS: readonly PanelDefinition[] = enabledPanels(PANEL_ENTRIES, BUILD_FEATURES);

export function panelById(panels: readonly PanelDefinition[], id: string): PanelDefinition | undefined {
  return panels.find((p) => p.id === (id as PanelId));
}
