import { describe, expect, it, vi } from "vitest";
import { t as msg } from "../i18n/index.ts";
import { clipboardConfig, type ClipboardConfig } from "../renderer/engine/clipboard-ipc.ts";
import { ClipboardError, contextMenuTemplate, copyMenuTemplate, createClipboardHost } from "./clipboard-host.ts";

const cfg: ClipboardConfig = { ...clipboardConfig, osc52MaxBytes: 8, copyValueMaxChars: 5 };

function host() {
  const write = vi.fn<(text: string) => void>();
  const popup = vi.fn();
  return { write, popup, host: createClipboardHost({ config: cfg, write, popup }) };
}

describe("createClipboardHost.writeText", () => {
  it("writes a string within the cap", () => {
    const h = host();
    h.host.writeText("çğ ab");
    expect(h.write).toHaveBeenCalledWith("çğ ab");
  });

  it("counts UTF-8 bytes, not characters", () => {
    const h = host();
    expect(() => h.host.writeText("ççççç")).toThrow(ClipboardError); // 10 bytes
    expect(h.write).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a non-empty string", () => {
    const h = host();
    for (const bad of [undefined, null, 1, {}, ["a"], "", true, Symbol("x")]) expect(() => h.host.writeText(bad)).toThrow(ClipboardError);
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe("createClipboardHost.copyMenu", () => {
  it("pops up one Kopyala item that writes the value when clicked", () => {
    const h = host();
    h.host.copyMenu("a/b.t");
    expect(h.write).not.toHaveBeenCalled();
    const template = h.popup.mock.calls[0]![0] as { label: string; click: () => void }[];
    expect(template.map((i) => i.label)).toEqual([msg("main.contextMenu.copy")]);
    template[0]!.click();
    expect(h.write).toHaveBeenCalledWith("a/b.t");
  });

  it("refuses long, empty and non-string values", () => {
    const h = host();
    for (const bad of ["123456", "", 5, null, undefined, {}]) expect(() => h.host.copyMenu(bad)).toThrow(ClipboardError);
    expect(h.popup).not.toHaveBeenCalled();
  });
});

describe("copyMenuTemplate", () => {
  it("is a single item", () => {
    const click = vi.fn();
    const t = copyMenuTemplate(cfg, click);
    expect(t).toHaveLength(1);
    (t[0] as { click: () => void }).click();
    expect(click).toHaveBeenCalledOnce();
  });
});

describe("contextMenuTemplate", () => {
  const flags = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false };
  const roles = (t: { role?: unknown; type?: unknown }[]): unknown[] => t.map((i) => i.role ?? i.type);

  it("offers nothing where there is nothing to copy or edit", () => {
    expect(contextMenuTemplate({ isEditable: false, selectionText: "", editFlags: flags }, cfg)).toEqual([]);
    expect(contextMenuTemplate({ isEditable: false, selectionText: "   ", editFlags: { ...flags, canSelectAll: true } }, cfg)).toEqual([]);
  });

  it("selected page text: Kopyala only", () => {
    const t = contextMenuTemplate({ isEditable: false, selectionText: "abc", editFlags: { ...flags, canCopy: true } }, cfg);
    expect(roles(t)).toEqual(["copy"]);
    expect(t[0]!.label).toBe(msg("main.contextMenu.copy"));
  });

  it("an input or the terminal: Kes, Kopyala, Yapıştır, Tümünü seç with the page's edit flags", () => {
    const t = contextMenuTemplate({ isEditable: true, selectionText: "", editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }, cfg);
    expect(roles(t)).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
    expect(t.map((i) => i.enabled)).toEqual([false, false, true, undefined, true]);
    expect(t.map((i) => i.label)).toEqual([msg("main.contextMenu.cut"), msg("main.contextMenu.copy"), msg("main.contextMenu.paste"), undefined, msg("main.contextMenu.selectAll")]);
  });
});
