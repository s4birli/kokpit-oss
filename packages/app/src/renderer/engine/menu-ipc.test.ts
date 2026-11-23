import { describe, expect, it } from "vitest";
import { parseMenuCommand, parseViewMenuState, SIMPLE_MENU_COMMANDS } from "./menu-ipc.ts";

describe("menu IPC parsing (İş M)", () => {
  it("accepts every known command", () => {
    for (const type of SIMPLE_MENU_COMMANDS) expect(parseMenuCommand({ type })).toEqual({ type });
    expect(parseMenuCommand({ type: "panel.toggle", panelId: "files" })).toEqual({ type: "panel.toggle", panelId: "files" });
    expect(parseMenuCommand({ type: "site.open", siteId: "home" })).toEqual({ type: "site.open", siteId: "home" });
    expect(parseMenuCommand({ type: "settings.open" })).toEqual({ type: "settings.open" });
    expect(parseMenuCommand({ type: "settings.open", tab: "sites" })).toEqual({ type: "settings.open", tab: "sites" });
  });

  it.each([null, 1, "layout.reset", {}, { type: "rm -rf" }, { type: "panel.toggle" }, { type: "panel.toggle", panelId: "../x" }, { type: "site.open", siteId: 3 }, { type: "settings.open", tab: "" }])(
    "rejects %j",
    (raw) => expect(parseMenuCommand(raw)).toBeNull(),
  );

  it("drops extra fields", () => {
    expect(parseMenuCommand({ type: "layout.reset", evil: 1 })).toEqual({ type: "layout.reset" });
  });

  it("view state: bad items dropped, flags coerced to booleans, duplicates dropped", () => {
    expect(parseViewMenuState(null)).toBeNull();
    expect(parseViewMenuState({ panels: "x" })).toBeNull();
    expect(
      parseViewMenuState({
        panels: [
          { id: "files", title: "Dosyalar", checked: true, enabled: 1 },
          { id: "files", title: "Tekrar", checked: false, enabled: true },
          { id: "", title: "Boş" },
          { id: "map", title: "" },
          { id: "map", title: "x".repeat(101) },
          7,
        ],
      }),
    ).toEqual({ panels: [{ id: "files", title: "Dosyalar", checked: true, enabled: false }] });
  });
});
