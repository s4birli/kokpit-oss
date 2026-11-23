// Kopyalama — Tarayıcı panel: copy / cut / paste between the streamed page (on the engine machine) and THIS
// machine's clipboard, and the native right-click menu. Key, Edit menu and context menu all arrive as the same DOM
// `copy` / `cut` / `paste` events on the canvas.
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { CLIPBOARD_LIMITS } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineRequestError } from "../engine/types.ts";
import type { PageMenuRequest } from "../engine/clipboard-ipc.ts";
import { BrowserPanel, type FrameDrawer } from "./BrowserPanel.tsx";
import { clipboardShortcut } from "./browser-input.ts";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { FakeResizeObserver } from "./test-utils/fake-view.ts";

const flush = () => act(async () => {});
const SECRET = "gizli-seçim-Zx9! çğıöşü";

class FakeClipboardBridge {
  written: string[] = [];
  menus: PageMenuRequest[] = [];
  writeError: Error | undefined;
  async writeText(text: string): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.written.push(text);
  }
  async copyMenu(): Promise<void> {}
  async pageMenu(request: PageMenuRequest): Promise<void> {
    this.menus.push(request);
  }
}

async function setup(opts: { bridge?: boolean; isMac?: boolean } = {}) {
  const project = makeProject("p1", "Alfa");
  const client = new FakeEngineClient({ projects: [project] });
  client.browser.handlers["browser.open"]({ projectId: "p1" });
  client.browser.handlers["browser.navigate"]({ projectId: "p1", url: "https://example.com/sayfa" });
  const bridge = new FakeClipboardBridge();
  const draw: FrameDrawer = async () => ({ width: 1280, height: 800 });
  render(
    <BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} clipboard={opts.bridge === false ? null : bridge} isMac={opts.isMac ?? true} />,
  );
  await flush();
  client.browser.emitFrame("p1");
  await flush();
  const c = screen.getByLabelText("Tarayıcı görüntüsü") as HTMLCanvasElement;
  // Shown at 640x400 CSS px; the page is 1280x800.
  c.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 400, right: 650, bottom: 420, x: 10, y: 20, toJSON() {} });
  c.focus();
  return { client, bridge, c };
}

const keys = (client: FakeEngineClient) => client.browser.inputs.map((i) => i.event).filter((e) => e.type === "key");
const pasteEvent = (text: string) => ({ clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") } });

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("clipboardShortcut", () => {
  const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it("macOS: Cmd+C / Cmd+X / Cmd+V (any letter case); Shift is fine for paste only", () => {
    expect(clipboardShortcut(key("c", { metaKey: true }), true)).toBe("copy");
    expect(clipboardShortcut(key("C", { metaKey: true }), true)).toBe("copy");
    expect(clipboardShortcut(key("x", { metaKey: true }), true)).toBe("cut");
    expect(clipboardShortcut(key("v", { metaKey: true }), true)).toBe("paste");
    expect(clipboardShortcut(key("V", { metaKey: true, shiftKey: true }), true)).toBe("paste");
    expect(clipboardShortcut(key("C", { metaKey: true, shiftKey: true }), true)).toBeNull();
  });

  it("macOS: Ctrl+C is the page's own key (a terminal's ^C), never a copy", () => {
    expect(clipboardShortcut(key("c", { ctrlKey: true }), true)).toBeNull();
    expect(clipboardShortcut(key("v", { ctrlKey: true }), true)).toBeNull();
    expect(clipboardShortcut(key("c", { metaKey: true, ctrlKey: true }), true)).toBeNull();
    expect(clipboardShortcut(key("c", { metaKey: true, altKey: true }), true)).toBeNull();
  });

  it("elsewhere: Ctrl instead of Cmd", () => {
    expect(clipboardShortcut(key("c", { ctrlKey: true }), false)).toBe("copy");
    expect(clipboardShortcut(key("v", { ctrlKey: true }), false)).toBe("paste");
    expect(clipboardShortcut(key("c", { metaKey: true }), false)).toBeNull();
  });

  it("monkey: every other key and combination is nothing", () => {
    const ks = ["a", "b", "Enter", "", "cc", "ç", "Meta", "Control", "Insert", "©", "√"];
    for (const k of ks) for (const meta of [true, false]) for (const ctrl of [true, false]) for (const mac of [true, false]) {
      expect(clipboardShortcut(key(k, { metaKey: meta, ctrlKey: ctrl }), mac), `${k} ${meta} ${ctrl} ${mac}`).toBeNull();
    }
    expect(clipboardShortcut(key("c"), true)).toBeNull();
    expect(clipboardShortcut(key("v"), false)).toBeNull();
  });
});

describe("BrowserPanel: copy from the remote page", () => {
  it("Cmd+C copies right on the key: the selection lands on the clipboard, the key goes neither to the page nor on to the menu", async () => {
    const { client, bridge, c } = await setup();
    client.browser.clipboard.selection = SECRET;
    const down = createEvent.keyDown(c, { key: "c", code: "KeyC", keyCode: 67, metaKey: true });
    fireEvent(c, down);
    expect(down.defaultPrevented).toBe(true);
    // Held down: the repeats copy nothing more.
    fireEvent.keyDown(c, { key: "c", code: "KeyC", keyCode: 67, metaKey: true, repeat: true });
    fireEvent.keyUp(c, { key: "c", code: "KeyC", keyCode: 67, metaKey: true });
    await flush();
    expect(keys(client)).toEqual([]);
    expect(client.browser.clipboard.calls).toEqual([["copy", "p1", false]]);
    expect(bridge.written).toEqual([SECRET]);
    fireEvent.keyDown(c, { key: "x", code: "KeyX", keyCode: 88, metaKey: true });
    await flush();
    expect(client.browser.clipboard.calls.at(-1)).toEqual(["copy", "p1", true]);
    expect(keys(client)).toEqual([]);
    // Ctrl+C on a Mac is the page's own key.
    fireEvent.keyDown(c, { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true });
    fireEvent.keyUp(c, { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true });
    expect(keys(client).map((e) => (e.type === "key" ? `${e.action}:${e.modifiers?.ctrl}` : ""))).toEqual(["down:true", "up:true"]);
    client.browser.inputs.length = 0;
    // A plain "c" afterwards is typed as usual, key-up included.
    fireEvent.keyDown(c, { key: "c", code: "KeyC", keyCode: 67 });
    fireEvent.keyUp(c, { key: "c", code: "KeyC", keyCode: 67 });
    expect(keys(client).map((e) => (e.type === "key" ? e.action : ""))).toEqual(["down", "up"]);
  });

  it("the copy event asks the engine for the page's selection and writes it to this machine's clipboard", async () => {
    const { client, bridge, c } = await setup();
    client.browser.clipboard.selection = SECRET;
    const ev = createEvent.copy(c);
    fireEvent(c, ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(client.browser.clipboard.calls).toEqual([["copy", "p1", false]]);
    expect(bridge.written).toEqual([SECRET]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("nothing selected in the page: the clipboard is left alone", async () => {
    const { client, bridge, c } = await setup();
    fireEvent.copy(c);
    await flush();
    expect(client.browser.clipboard.calls).toEqual([["copy", "p1", false]]);
    expect(bridge.written).toEqual([]);
  });

  it("the cut event copies and tells the page to cut", async () => {
    const { client, bridge, c } = await setup();
    client.browser.clipboard.selection = "kesilen";
    fireEvent.cut(c);
    await flush();
    expect(client.browser.clipboard.calls).toEqual([["copy", "p1", true]]);
    expect(bridge.written).toEqual(["kesilen"]);
  });

  it("an engine refusal (selection too large) is shown; a failed clipboard write is shown without the text", async () => {
    const { client, bridge, c } = await setup();
    client.browser.clipboard.error = new EngineRequestError("INVALID", "Seçim çok büyük: en çok 100000 karakter kopyalanabilir.");
    fireEvent.copy(c);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Seçim çok büyük");
    expect(bridge.written).toEqual([]);
    client.browser.clipboard.selection = SECRET;
    bridge.writeError = new Error("Kopyalanacak metin çok büyük.");
    fireEvent.copy(c);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("çok büyük");
    expect(screen.getByRole("alert").textContent).not.toContain("gizli");
  });

  it("without the app's clipboard bridge the selection cannot be written: said once, nothing thrown", async () => {
    const { client, c } = await setup({ bridge: false });
    client.browser.clipboard.selection = SECRET;
    fireEvent.copy(c);
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/pano/i);
    expect(screen.getByRole("alert").textContent).not.toContain("gizli");
  });

  it("while the address bar has the focus, copy and paste are its own: nothing goes to the engine", async () => {
    const { client } = await setup();
    const address = screen.getByLabelText("Adres");
    address.focus();
    const copy = createEvent.copy(address);
    fireEvent(address, copy);
    const paste = createEvent.paste(address, pasteEvent("adres çubuğuna"));
    fireEvent(address, paste);
    await flush();
    expect([copy.defaultPrevented, paste.defaultPrevented]).toEqual([false, false]);
    expect(client.browser.clipboard.calls).toEqual([]);
  });

  it("the menu's copy is caught even when Chromium aims it elsewhere (a stale selection, <body>) — as long as the picture has the focus", async () => {
    const { client, bridge, c } = await setup();
    client.browser.clipboard.selection = SECRET;
    const ev = createEvent.copy(document.body);
    fireEvent(document.body, ev);
    await flush();
    expect(ev.defaultPrevented).toBe(true);
    expect(bridge.written).toEqual([SECRET]);
    c.blur();
    fireEvent.copy(document.body);
    await flush();
    expect(client.browser.clipboard.calls).toHaveLength(1);
  });
});

describe("BrowserPanel: paste into the remote page", () => {
  it("Cmd+V is left to the browser; the paste event sends the whole text as one browser.paste request", async () => {
    const { client, c } = await setup();
    const down = createEvent.keyDown(c, { key: "v", code: "KeyV", keyCode: 86, metaKey: true });
    fireEvent(c, down);
    expect(down.defaultPrevented).toBe(false);
    const text = `${SECRET}\nikinci satır 😀`;
    const ev = createEvent.paste(c, pasteEvent(text));
    fireEvent(c, ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(client.browser.clipboard.calls).toEqual([["paste", "p1", text]]);
    // Not typed as an input event (that path cut the text at 10 000 characters).
    expect(client.browser.inputs).toEqual([]);
  });

  it("an empty clipboard sends nothing; text over the protocol's cap is refused here, not truncated", async () => {
    const { client, c } = await setup();
    fireEvent.paste(c, pasteEvent(""));
    fireEvent.paste(c, pasteEvent(`gizli${"x".repeat(CLIPBOARD_LIMITS.maxChars)}`));
    await flush();
    expect(client.browser.clipboard.calls).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain(String(CLIPBOARD_LIMITS.maxChars));
    expect(screen.getByRole("alert").textContent).not.toContain("gizli");
    fireEvent.paste(c, pasteEvent("x".repeat(CLIPBOARD_LIMITS.maxChars)));
    await flush();
    expect(client.browser.clipboard.calls).toHaveLength(1);
  });

  it("the engine's refusal is shown", async () => {
    const { client, c } = await setup();
    client.browser.clipboard.error = new EngineRequestError("INVALID", "Yapıştırılacak metin çok büyük: en çok 5 karakter.");
    fireEvent.paste(c, pasteEvent("uzun metin"));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("çok büyük");
  });

  it("monkey: odd Unicode reaches the engine unchanged", async () => {
    const { client, c } = await setup();
    const samples = ["İIıi ĞğŞş", "\u0000\u0001", "a\r\nb", "‮ters", "👨‍👩‍👧‍👦", "\ud83d", " ", "\t"];
    for (let i = 0; i < 40; i++) samples.push(String.fromCharCode(...Array.from({ length: 1 + (i % 9) }, () => Math.floor(Math.random() * 0xffff) + 1)));
    for (const s of samples) fireEvent.paste(c, pasteEvent(s));
    await flush();
    expect(client.browser.clipboard.calls.map((call) => call[2])).toEqual(samples);
  });
});

describe("BrowserPanel: right click", () => {
  it("opens Kokpit's native menu with what the page says about that point; the click is not sent to the page", async () => {
    const { client, bridge, c } = await setup();
    client.browser.clipboard.context = { hasSelection: true, editable: false, linkUrl: "https://example.com/hedef" };
    fireEvent.mouseDown(c, { clientX: 330, clientY: 220, button: 2 });
    fireEvent.mouseUp(c, { clientX: 330, clientY: 220, button: 2 });
    const ev = createEvent.contextMenu(c, { clientX: 330, clientY: 220, button: 2 });
    fireEvent(c, ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(client.browser.inputs.filter((i) => i.event.type === "mouse" && i.event.action !== "move")).toEqual([]);
    expect(client.browser.clipboard.calls).toEqual([["context", "p1", 640, 400]]);
    expect(bridge.menus).toEqual([{ canCopy: true, canCut: false, canPaste: false, linkUrl: "https://example.com/hedef", pageUrl: "https://example.com/sayfa" }]);
    expect(document.activeElement).toBe(c);
  });

  it("an editable selection can also be cut and pasted over", async () => {
    const { client, bridge, c } = await setup();
    client.browser.clipboard.context = { hasSelection: true, editable: true };
    fireEvent.contextMenu(c, { clientX: 30, clientY: 40, button: 2 });
    await flush();
    expect(bridge.menus).toEqual([{ canCopy: true, canCut: true, canPaste: true, pageUrl: "https://example.com/sayfa" }]);
  });

  it("with ⌥ Option held the right click goes to the page instead (for pages with their own menu); no Kokpit menu", async () => {
    const { client, bridge, c } = await setup();
    fireEvent.mouseDown(c, { clientX: 330, clientY: 220, button: 2, altKey: true });
    fireEvent.mouseUp(c, { clientX: 330, clientY: 220, button: 2, altKey: true });
    const ev = createEvent.contextMenu(c, { clientX: 330, clientY: 220, button: 2, altKey: true });
    fireEvent(c, ev);
    await flush();
    // Kokpit's own page never shows the browser's default menu over the picture.
    expect(ev.defaultPrevented).toBe(true);
    const sent = client.browser.inputs.map((i) => i.event).filter((e) => e.type === "mouse");
    expect(sent.map((e) => (e.type === "mouse" ? [e.action, e.button, e.modifiers?.alt] : []))).toEqual([
      ["down", "right", true],
      ["up", "right", true],
    ]);
    expect(client.browser.clipboard.calls).toEqual([]);
    expect(bridge.menus).toEqual([]);
  });

  it("a failed context request shows the error and opens no menu", async () => {
    const { client, bridge, c } = await setup();
    client.browser.clipboard.error = new EngineRequestError("NOT_FOUND", "Tarayıcı açık değil");
    fireEvent.contextMenu(c, { clientX: 30, clientY: 40, button: 2 });
    await flush();
    expect(bridge.menus).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("Tarayıcı açık değil");
  });
});
