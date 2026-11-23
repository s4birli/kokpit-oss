// İş T: the Terminal panel shows one tab per terminal; only the active one (and a "böl" partner) is on screen.
// Helpers for workbench-level tests that used to see every terminal at once.
import { act, fireEvent, screen, within } from "@testing-library/react";

const TABLIST = "Terminal sekmeleri";

/** The Terminal panel's tab strip. */
export function terminalTabList(): HTMLElement {
  return screen.getByRole("tablist", { name: TABLIST });
}

/** Terminal tab titles in tab order (empty when the panel shows no tabs). */
export function terminalTabTitles(): string[] {
  const list = screen.queryByRole("tablist", { name: TABLIST });
  if (!list) return [];
  return within(list)
    .queryAllByRole("tab")
    .map((t) => t.getAttribute("data-title") ?? "");
}

/** The tab of the terminal titled `title`. */
export function terminalTab(title: string): HTMLElement {
  const tab = within(terminalTabList())
    .queryAllByRole("tab")
    .find((t) => t.getAttribute("data-title") === title);
  if (!tab) throw new Error(`no terminal tab "${title}" (tabs: ${terminalTabTitles().join(", ")})`);
  return tab;
}

/** Title of the active terminal tab, or null. */
export function activeTerminalTitle(): string | null {
  const list = screen.queryByRole("tablist", { name: TABLIST });
  const active = list ? within(list).queryAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true") : undefined;
  return active?.getAttribute("data-title") ?? null;
}

/** Clicks the terminal's tab so its terminal is on screen. */
export async function showTerminal(title: string): Promise<void> {
  fireEvent.click(terminalTab(title));
  await act(async () => {});
}

/** Dock tabs (panel titles), not the Terminal panel's own tabs. */
export function isDockTab(tab: Element): boolean {
  return tab.closest(`[role="tablist"][aria-label="${TABLIST}"]`) === null;
}

const LAUNCHER = "Yeni terminal";
const LAUNCHER_TOGGLE = "+ Yeni terminal ▾";

/** The Terminal panel's launcher if it is on screen: its menu, or the empty panel's own. */
export function queryTerminalLauncher(): HTMLElement | null {
  return screen.queryByRole("group", { name: LAUNCHER });
}

/** The Terminal panel's launcher (Araç, Başlangıç komutu, Yeni terminal); opens the menu when it is closed. */
export function terminalLauncher(): HTMLElement {
  const shown = queryTerminalLauncher();
  if (shown) return shown;
  fireEvent.click(screen.getByRole("button", { name: LAUNCHER_TOGGLE }));
  return screen.getByRole("group", { name: LAUNCHER });
}

/** The launcher's "Araç" picker. */
export function launcherToolSelect(): HTMLSelectElement {
  return within(terminalLauncher()).getByLabelText("Araç") as HTMLSelectElement;
}

/** Opens a terminal from the Terminal panel's launcher; `command` fills "Başlangıç komutu" first. */
export async function launchTerminal(command?: string): Promise<void> {
  const launcher = terminalLauncher();
  if (command !== undefined) fireEvent.change(within(launcher).getByLabelText("Başlangıç komutu"), { target: { value: command } });
  fireEvent.click(within(launcher).getByRole("button", { name: LAUNCHER }));
  await act(async () => {});
}
