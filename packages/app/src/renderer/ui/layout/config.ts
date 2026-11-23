// İş L: every tunable of the layout host — default layouts, where a panel goes when it is turned on, save delay,
// and the Turkish strings dockview speaks. Overridable through LayoutHost's `config` prop.
import type { PanelId } from "./contract.ts";
import type { LayoutKind } from "./ui-state.ts";
import { t } from "../../../i18n/index.ts";

export type Direction = "left" | "right" | "above" | "below" | "within";

/** Where a panel is put: next to the first of `near` that is open, else at the edge of the whole dock. */
export interface Placement {
  near: readonly PanelId[];
  direction: Direction;
  /**
   * Fractions of the dock's width/height the panel's group is grown to when the panel is added (a group that is
   * already that large is left alone; skipped while the dock is unmeasurable). For panels that are of no use small.
   */
  minSize?: { width?: number; height?: number };
}

export interface DefaultLayout {
  /** Added in order; the first panel has no placement. */
  panels: readonly { id: PanelId; placement?: Placement }[];
  /** Fractions of the dock's width/height given to a panel's group after building (skipped when unmeasurable). */
  sizes?: readonly { id: PanelId; width?: number; height?: number }[];
}

export interface LayoutConfig {
  saveDebounceMs: number;
  defaults: Record<LayoutKind, DefaultLayout>;
  /** Panels a layout kind may show at all (Görünüm, reveal, rendering); on top of each panel's `available`. */
  kindPanels: Record<LayoutKind, readonly PanelId[]>;
  /** Used by Görünüm and `reveal` for a panel that is not in the layout. */
  placement: Record<PanelId, Placement>;
  /** Gap between groups (px). */
  gap: number;
  text: {
    emptyDock: string;
    unavailable: string;
    noSelection: string;
    panelError: string;
    closeTab(title: string): string;
    closeTabPlain: string;
  };
}

export const defaultLayoutConfig: LayoutConfig = {
  saveDebounceMs: 400,
  defaults: {
    // Üstte Dosyalar | Tarayıcı | Ajanlar, altta boydan boya Terminal; Harita (ve isteğe bağlı paneller) kapalı (açılınca
    // ikisi de Tarayıcı'nın grubunda sekme olur, bkz. `placement`).
    normal: {
      panels: [
        { id: "files" },
        { id: "browser", placement: { near: ["files"], direction: "right" } },
        { id: "agents", placement: { near: ["browser"], direction: "right" } },
        { id: "terminals", placement: { near: [], direction: "below" } },
      ],
      sizes: [
        { id: "files", width: 0.2 },
        { id: "agents", width: 0.22 },
        { id: "terminals", height: 0.45 },
      ],
    },
  },
  kindPanels: {
    normal: ["files", "browser", "terminals", "agents", "map", "flow" /* İş W */, "claude", "web" /* İş M */],
  },
  placement: {
    files: { near: ["browser", "agents"], direction: "left" },
    browser: { near: ["files", "agents"], direction: "right" },
    agents: { near: ["browser", "files"], direction: "right" },
    terminals: { near: [], direction: "below" },
    map: { near: ["browser"], direction: "within" },
    // İş M: site sekmeleri Tarayıcı'nın (ya da düzenin büyük grubunun) grubunda bir sekme olarak açılır.
    web: { near: ["browser", "files"], direction: "within" },
    flow: { near: ["map", "browser"], direction: "within" }, // İş W
    claude: { near: ["browser", "agents"], direction: "within" },
  },
  // Room for the screens: groups touch; dockview draws one separator line and layout.css widens the sash's reach.
  gap: 0,
  // i18n: getters, read at render in the current language (the host re-renders on a switch).
  text: {
    get emptyDock() {
      return t("workbench.layout.emptyDock");
    },
    get unavailable() {
      return t("workbench.layout.unavailable");
    },
    get noSelection() {
      return t("workbench.noSelection.hint");
    },
    get panelError() {
      return t("workbench.layout.panelError");
    },
    closeTab: (title) => t("workbench.layout.closeTab", { title }),
    get closeTabPlain() {
      return t("workbench.layout.closeTabPlain");
    },
  },
};
