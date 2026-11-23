import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { MenuCommand } from "../renderer/engine/menu-ipc.ts";
import { buildMenuTemplate, menuConfig, type MenuInput } from "./menu-template.ts";

const input = (over: Partial<MenuInput> = {}): MenuInput => ({
  appName: "Kokpit",
  isMac: true,
  devTools: false,
  view: {
    panels: [
      { id: "files", title: "Dosyalar", checked: true, enabled: true },
      { id: "map", title: "Harita", checked: false, enabled: true },
      { id: "flow", title: "Akış", checked: false, enabled: false },
    ],
  },
  sites: [
    { id: "home", title: "Ana sayfa", url: "https://home.example.com/" },
    { id: "wiki", title: "Wiki", url: "https://wiki.example.com/" },
  ],
  ...over,
});

type Item = MenuItemConstructorOptions;
const top = (t: Item[], label: string): Item => {
  const m = t.find((i) => i.label === label);
  if (!m) throw new Error(`no ${label}`);
  return m;
};
const sub = (m: Item): Item[] => m.submenu as Item[];
const item = (m: Item, label: string): Item => {
  const i = sub(m).find((x) => x.label === label);
  if (!i) throw new Error(`no ${label}`);
  return i;
};
const click = (i: Item) => (i.click as unknown as () => void)();

describe("menu template (İş M)", () => {
  it("menu bar order on macOS: app, Edit, Görünüm, Git, Window, Yardım", () => {
    const t = buildMenuTemplate(input(), () => {});
    expect(t.map((m) => m.label ?? m.role)).toEqual(["Kokpit", "editMenu", "Görünüm", "Git", "windowMenu", "Yardım"]);
    expect(top(t, "Yardım").role).toBe("help");
    const app = sub(top(t, "Kokpit"));
    expect(app.map((i) => i.role ?? i.label ?? i.type)).toContain("quit");
    expect(app.find((i) => i.label === "Ayarlar…")?.accelerator).toBe(menuConfig.accelerators.settings);
  });

  it("Görünüm: one checkbox per panel, checked/enabled as reported", () => {
    const view = top(buildMenuTemplate(input(), () => {}), "Görünüm");
    const boxes = sub(view).filter((i) => i.type === "checkbox");
    expect(boxes.map((b) => [b.label, b.checked, b.enabled])).toEqual([
      ["Dosyalar", true, true],
      ["Harita", false, true],
      ["Akış", false, false],
    ]);
  });

  it("every item sends its command", () => {
    const send = vi.fn<(c: MenuCommand) => void>();
    const t = buildMenuTemplate(input(), send);
    const view = top(t, "Görünüm");
    click(item(view, "Harita"));
    click(item(view, "Varsayılan düzen"));
    click(item(view, "Terminal yazısını küçült"));
    click(item(view, "Terminal yazısını büyüt"));
    click(item(view, "Terminal yazısını sıfırla"));
    click(item(view, "Tarayıcıyı uzaklaştır"));
    click(item(view, "Tarayıcıyı yakınlaştır"));
    click(item(view, "Tarayıcıyı sıfırla"));
    click(item(top(t, "Git"), "Wiki"));
    click(item(top(t, "Git"), "Siteleri düzenle…"));
    click(item(top(t, "Yardım"), "Claude komutları"));
    click(item(top(t, "Kokpit"), "Ayarlar…"));
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: "panel.toggle", panelId: "map" },
      { type: "layout.reset" },
      { type: "terminal.font.smaller" },
      { type: "terminal.font.larger" },
      { type: "terminal.font.reset" },
      { type: "browser.zoom.out" },
      { type: "browser.zoom.in" },
      { type: "browser.zoom.reset" },
      { type: "site.open", siteId: "wiki" },
      { type: "settings.open", tab: "sites" },
      { type: "claude.help" },
      { type: "settings.open" },
    ]);
  });

  it("Git lists the sites in order, then Siteleri düzenle…; an empty list says so", () => {
    expect(sub(top(buildMenuTemplate(input(), () => {}), "Git")).map((i) => i.label ?? i.type)).toEqual([
      "Ana sayfa",
      "Wiki",
      "separator",
      "Siteleri düzenle…",
    ]);
    const empty = sub(top(buildMenuTemplate(input({ sites: [] }), () => {}), "Git"));
    expect(empty[0]).toMatchObject({ label: "Site yok", enabled: false });
  });

  it("accelerators are unique and come from the config", () => {
    const acc: string[] = [];
    const walk = (items: Item[]) => {
      for (const i of items) {
        if (typeof i.accelerator === "string") acc.push(i.accelerator);
        if (Array.isArray(i.submenu)) walk(i.submenu as Item[]);
      }
    };
    walk(buildMenuTemplate(input({ devTools: true }), () => {}));
    expect(new Set(acc).size).toBe(acc.length);
    expect(acc).toEqual(expect.arrayContaining(Object.values(menuConfig.accelerators)));
  });

  it("Geliştirici araçları only when asked (development builds)", () => {
    const labels = (devTools: boolean) => sub(top(buildMenuTemplate(input({ devTools }), () => {}), "Görünüm")).map((i) => i.role ?? i.label);
    expect(labels(false)).not.toContain("toggleDevTools");
    expect(labels(true)).toContain("toggleDevTools");
  });

  it("off macOS there is no app menu role; Ayarlar and quit live in a menu named after the app", () => {
    const t = buildMenuTemplate(input({ isMac: false }), () => {});
    expect(t.some((m) => m.role === "windowMenu")).toBe(true);
    expect(sub(top(t, "Kokpit")).map((i) => i.role ?? i.label ?? i.type)).toEqual(["Ayarlar…", "separator", "quit"]);
  });

  it("labels are plain text: a site title cannot add items or roles (monkey)", () => {
    const nasty = { id: "x", title: "&Quit\n<b>", url: "https://x.example.com/" };
    const git = sub(top(buildMenuTemplate(input({ sites: [nasty] }), () => {}), "Git"));
    expect(git[0]).toMatchObject({ label: "&Quit\n<b>" });
    expect(git[0]!.role).toBeUndefined();
  });
});
