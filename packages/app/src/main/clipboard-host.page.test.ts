// Kopyalama — Tarayıcı panel: the native right-click menu of the streamed page (main side). Untrusted IPC input.
import { describe, expect, it, vi } from "vitest";
import { t as msg } from "../i18n/index.ts";
import { clipboardConfig, type ClipboardConfig } from "../renderer/engine/clipboard-ipc.ts";
import { ClipboardError, createClipboardHost, pageMenuTemplate } from "./clipboard-host.ts";

const cfg: ClipboardConfig = { ...clipboardConfig, pageUrlMaxChars: 40 };
type Item = { label?: string; role?: string; enabled?: boolean; type?: string; click?: () => void };

function host(hasText = true) {
  const write = vi.fn<(text: string) => void>();
  const popup = vi.fn();
  return { write, popup, host: createClipboardHost({ config: cfg, write, popup, hasText: () => hasText }) };
}
const shown = (h: ReturnType<typeof host>): Item[] => h.popup.mock.calls.at(-1)![0] as Item[];

describe("pageMenuTemplate", () => {
  it("offers Kopyala and Yapıştır as roles (they act on the focused canvas, like the Edit menu), enabled by what the page says", () => {
    const t = pageMenuTemplate({ canCopy: true, canCut: false, canPaste: true }, cfg, { hasText: true, write: () => {} }) as Item[];
    expect(t.map((i) => [i.label, i.role, i.enabled])).toEqual([
      [msg("main.contextMenu.copy"), "copy", true],
      [msg("main.contextMenu.paste"), "paste", true],
    ]);
  });

  it("Kes appears only for an editable selection; nothing selected / nothing editable / an empty clipboard disable the items", () => {
    const cut = pageMenuTemplate({ canCopy: true, canCut: true, canPaste: true }, cfg, { hasText: false, write: () => {} }) as Item[];
    expect(cut.map((i) => [i.label, i.role, i.enabled])).toEqual([
      [msg("main.contextMenu.cut"), "cut", true],
      [msg("main.contextMenu.copy"), "copy", true],
      [msg("main.contextMenu.paste"), "paste", false],
    ]);
    const none = pageMenuTemplate({ canCopy: false, canCut: false, canPaste: false }, cfg, { hasText: true, write: () => {} }) as Item[];
    expect(none.map((i) => [i.role, i.enabled])).toEqual([
      ["copy", false],
      ["paste", false],
    ]);
  });

  it("adds Bağlantıyı kopyala / Adresi kopyala, which write that URL in main", () => {
    const write = vi.fn();
    const t = pageMenuTemplate({ canCopy: false, canCut: false, canPaste: false, linkUrl: "https://a.example/x", pageUrl: "https://a.example/" }, cfg, { hasText: true, write }) as Item[];
    expect(t.map((i) => i.label ?? i.type)).toEqual([msg("main.contextMenu.copy"), msg("main.contextMenu.paste"), "separator", msg("main.contextMenu.copyLink"), msg("main.contextMenu.copyAddress")]);
    t[3]!.click!();
    expect(write).toHaveBeenLastCalledWith("https://a.example/x");
    t[4]!.click!();
    expect(write).toHaveBeenLastCalledWith("https://a.example/");
  });
});

describe("createClipboardHost.pageMenu", () => {
  it("pops the menu up; the clipboard is written only when an address item is clicked", () => {
    const h = host();
    h.host.pageMenu({ canCopy: true, canCut: false, canPaste: true, linkUrl: "https://a.example/x" });
    expect(h.write).not.toHaveBeenCalled();
    const items = shown(h);
    expect(items.map((i) => i.label ?? i.type)).toEqual([msg("main.contextMenu.copy"), msg("main.contextMenu.paste"), "separator", msg("main.contextMenu.copyLink")]);
    items[3]!.click!();
    expect(h.write).toHaveBeenCalledWith("https://a.example/x");
  });

  it("Yapıştır is disabled when this Mac's clipboard holds no text", () => {
    const h = host(false);
    h.host.pageMenu({ canCopy: false, canCut: false, canPaste: true });
    expect(shown(h).find((i) => i.role === "paste")?.enabled).toBe(false);
  });

  it("drops addresses that are not http(s), not URLs or too long — the menu still opens without them", () => {
    const h = host();
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url", `https://a.example/${"x".repeat(40)}`, 5, null, { href: "https://a.example/" }]) {
      h.host.pageMenu({ canCopy: true, canCut: false, canPaste: false, linkUrl: url, pageUrl: url });
      expect(shown(h).map((i) => i.label ?? i.type), String(url).slice(0, 20)).toEqual([msg("main.contextMenu.copy"), msg("main.contextMenu.paste")]);
    }
  });

  it("refuses requests that are not an object of booleans; flags are never truthy by accident", () => {
    const h = host();
    for (const bad of [undefined, null, "copy", 1, [], { canCopy: "yes", canCut: false, canPaste: false }, { canCopy: true }, { canCopy: true, canCut: 1, canPaste: true }]) {
      expect(() => h.host.pageMenu(bad), JSON.stringify(bad)).toThrow(ClipboardError);
    }
    expect(h.popup).not.toHaveBeenCalled();
  });

  it("monkey: random input either throws ClipboardError or opens a menu of known items only", () => {
    const h = host();
    const junk = [undefined, null, true, false, 0, 1, "", "x", "https://a.example/", "javascript:1", [], {}, { a: 1 }];
    const pick = () => junk[Math.floor(Math.random() * junk.length)];
    const known = new Set([msg("main.contextMenu.cut"), msg("main.contextMenu.copy"), msg("main.contextMenu.paste"), msg("main.contextMenu.copyLink"), msg("main.contextMenu.copyAddress"), "separator"]);
    for (let i = 0; i < 500; i++) {
      const before = h.popup.mock.calls.length;
      try {
        h.host.pageMenu({ canCopy: pick(), canCut: pick(), canPaste: pick(), linkUrl: pick(), pageUrl: pick(), extra: pick() });
      } catch (e) {
        expect(e).toBeInstanceOf(ClipboardError);
        continue;
      }
      expect(h.popup.mock.calls.length).toBe(before + 1);
      for (const item of shown(h)) expect(known.has((item.label ?? item.type)!)).toBe(true);
    }
    expect(h.write).not.toHaveBeenCalled();
  });
});
