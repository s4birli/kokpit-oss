// Adım 7 — modular layout contract. Every dockable panel is a PanelDefinition registered in
// `registry.ts`; the layout host (İş L) renders them in dockview, persists layout and per-panel state,
// and keeps the native Görünüm menu (İş M) in sync. Panels never talk to the layout library directly.
import type { Card, Project } from "@kokpit/shared";
import type { ReactElement } from "react";
import type { EngineClient } from "../../engine/types.ts";
import type { UiConfig } from "../config.ts";
import type { TerminalViewFactory } from "../terminal-view.ts";

/** Stable ids; also the keys of persisted layout and the Görünüm toggles. */
export type PanelId = "terminals" | "browser" | "files" | "agents" | "map" | "flow" /* İş W */ | "claude" | "web" /* İş M */;

/** What a reveal may ask of the panel (a panel ignores what it doesn't support). */
export interface RevealArgs {
  /** Terminal: the terminal to focus. */
  terminalId?: string;
  /** Claude: the tab to show ("rehber"). */
  tab?: string;
  /** İş M — Web panel: the site whose tab to open and show. */
  siteId?: string;
  /**
   * Yollar — Dosyalar: the file (or folder) to show, relative to the folder the panel browses ("" = the folder
   * itself). A file is selected and opened in the large preview; a folder is expanded.
   */
  filePath?: string;
  /** Yollar — Dosyalar: `filePath` is a folder. */
  fileIsDir?: boolean;
}

/**
 * Per-panel, per-scope persisted state (e.g. open tabs, active tab). Scope = the selected project, or the card when
 * one is selected. Values must be JSON-serializable. Stored on the app's machine and restored after restart.
 */
export interface PanelStateStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

/** Everything a panel needs from the host. */
export interface PanelContext {
  client: EngineClient;
  config: UiConfig;
  createView: TerminalViewFactory;
  /** Selected project (null when nothing is selected). */
  project: Project | null;
  /** Selected card of that project, if any. */
  card: Card | null;
  engineUrl?: string;
  /** State scoped to this panel and the current project/card. */
  state: PanelStateStore;
  /** Ask the host to show (and focus) another panel, e.g. Ajanlar → terminals with a given terminal. */
  reveal(panel: PanelId, args?: RevealArgs): void;
  /** A pending focus request for this panel (a new `seq` repeats it); panels that don't support it ignore it. */
  focus?: (RevealArgs & { seq: number }) | null;
  /** Select a project/card in the rail (e.g. from Ajanlar). */
  select(target: { projectId: string; cardId?: string }): void;
}

export interface PanelDefinition {
  id: PanelId;
  /**
   * Title shown on the tab and in Görünüm, in the current language. Read at use time (the host re-reads it after a
   * language switch), so a definition gives it as a getter: `get title() { return t("area.panel.title"); }`.
   */
  title: string;
  /**
   * İş M: "selection" (default) scopes `state` to the selected project/card; "global" gives one state shared by every
   * selection (e.g. the Web panel's site tabs), and the panel is not remounted when the selection changes.
   */
  stateScope?: "selection" | "global";
  /** Whether the panel makes sense for this selection (e.g. no browser for SSH-only cases). */
  available(ctx: Pick<PanelContext, "project" | "card">): boolean;
  render(ctx: PanelContext): ReactElement;
}
