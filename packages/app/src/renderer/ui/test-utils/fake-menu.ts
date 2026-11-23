// İş M: drive and read the native Görünüm menu in jsdom tests (the layout host reports to / listens on the bus).
import { act } from "@testing-library/react";
import type { MenuCommand, ViewMenuItem } from "../../engine/menu-ipc.ts";
import { currentViewMenu, emitMenuCommand } from "../menu/menu-commands.ts";

export function menuItems(): ViewMenuItem[] {
  return currentViewMenu()?.panels ?? [];
}

function item(title: string): ViewMenuItem {
  const found = menuItems().find((p) => p.title === title);
  if (!found) throw new Error(`Görünüm has no "${title}" (has: ${menuItems().map((p) => p.title).join(", ")})`);
  return found;
}

/** Titles Görünüm lets you toggle right now (enabled items), in menu order. */
export function menuTitles(): string[] {
  return menuItems()
    .filter((p) => p.enabled)
    .map((p) => p.title);
}

export function menuChecked(title: string): boolean {
  return item(title).checked;
}

export function menuCommand(c: MenuCommand): void {
  act(() => emitMenuCommand(c));
}

/** Görünüm › <title> (only when enabled, like the real menu). */
export function menuToggle(title: string): void {
  const p = item(title);
  if (p.enabled) menuCommand({ type: "panel.toggle", panelId: p.id });
}

export function menuReset(): void {
  menuCommand({ type: "layout.reset" });
}
