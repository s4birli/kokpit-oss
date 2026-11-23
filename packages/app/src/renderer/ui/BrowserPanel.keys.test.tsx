// Kısayollar: the Tarayıcı panel answers the browser's own shortcuts (page-keys.ts) — address bar, tabs, reload,
// back / forward — and the page gets nothing of them (key-ups included); every other key, Cmd combos the page
// uses among them, goes to the page once; Kokpit's menu keys go to neither.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, type FrameDrawer } from "./BrowserPanel.tsx";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { FakeResizeObserver } from "./test-utils/fake-view.ts";

const flush = () => act(async () => {});

async function setup(tabs = 1) {
  const project = makeProject("p1", "Alfa");
  const client = new FakeEngineClient({ projects: [project] });
  client.browser.handlers["browser.open"]({ projectId: "p1" });
  for (let i = 1; i < tabs; i++) client.browser.handlers["browser.newTab"]({ projectId: "p1", url: `https://example.com/${i}` });
  const draw: FrameDrawer = async () => ({ width: 1280, height: 800 });
  render(<BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} clipboard={null} isMac />);
  await flush();
  const canvas = screen.getByLabelText("Tarayıcı görüntüsü");
  const keys = () => client.browser.inputs.filter((i) => i.event.type === "key").map((i) => (i.event.type === "key" ? `${i.event.action}:${i.event.key}` : ""));
  const press = async (init: { key: string; code: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }, target: Element = canvas) => {
    fireEvent.keyDown(target, init);
    fireEvent.keyUp(target, init);
    await flush();
  };
  return { client, canvas, keys, press };
}

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

describe("BrowserPanel: keyboard shortcuts", () => {
  it("⌘L focuses and selects the address bar; nothing reaches the page", async () => {
    const { canvas, keys, press } = await setup();
    canvas.focus();
    await press({ key: "l", code: "KeyL", metaKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText("Adres"));
    expect(keys()).toEqual([]);
  });

  it("⌘T opens a tab, ⌘W closes the active one, ⇧⌘T opens it again", async () => {
    const { client, canvas, keys, press } = await setup(2);
    const before = (await client.request("browser.tabs", { projectId: "p1" })).browser;
    const active = before.tabs.find((t) => t.id === before.activeTabId)!;
    expect(active.url).toMatch(/^https:/);
    const opened = client.callsOf("browser.newTab").length;
    canvas.focus();
    await press({ key: "w", code: "KeyW", metaKey: true });
    expect(client.callsOf("browser.closeTab")).toEqual([{ projectId: "p1", tabId: active.id }]);
    await press({ key: "T", code: "KeyT", metaKey: true, shiftKey: true });
    expect(client.callsOf("browser.newTab").at(-1)).toEqual({ projectId: "p1", url: active.url });
    // Nothing more to reopen: no request.
    await press({ key: "T", code: "KeyT", metaKey: true, shiftKey: true });
    expect(client.callsOf("browser.newTab")).toHaveLength(opened + 1);
    canvas.focus();
    await press({ key: "t", code: "KeyT", metaKey: true });
    expect(client.callsOf("browser.newTab").at(-1)).toEqual({ projectId: "p1" });
    // Chrome puts the caret in the new tab's address bar, empty.
    expect(document.activeElement).toBe(screen.getByLabelText("Adres"));
    expect((screen.getByLabelText("Adres") as HTMLInputElement).value).toBe("");
    expect(keys()).toEqual([]);
  });

  it("⌘R / ⇧⌘R reload (the second without the cache), ⌘[ / ⌘] go back / forward", async () => {
    const { client, canvas, keys, press } = await setup();
    canvas.focus();
    await press({ key: "r", code: "KeyR", metaKey: true });
    await press({ key: "R", code: "KeyR", metaKey: true, shiftKey: true });
    await press({ key: "[", code: "BracketLeft", metaKey: true });
    await press({ key: "]", code: "BracketRight", metaKey: true });
    expect(client.callsOf("browser.reload")).toEqual([{ projectId: "p1" }, { projectId: "p1", ignoreCache: true }]);
    expect(client.callsOf("browser.back")).toHaveLength(1);
    expect(client.callsOf("browser.forward")).toHaveLength(1);
    expect(keys()).toEqual([]);
  });

  it("⌘1…8 / ⌘9 pick a tab, Ctrl+Tab / Ctrl+⇧Tab cycle (wrapping)", async () => {
    const { client, canvas, keys, press } = await setup(3);
    const ids = (await client.request("browser.tabs", { projectId: "p1" })).browser.tabs.map((t) => t.id);
    canvas.focus();
    await press({ key: "1", code: "Digit1", metaKey: true });
    await press({ key: "9", code: "Digit9", metaKey: true });
    await press({ key: "Tab", code: "Tab", ctrlKey: true });
    await press({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
    expect(client.callsOf("browser.selectTab").map((p) => ids.indexOf(p.tabId))).toEqual([0, 2, 0, 2]);
    expect(keys()).toEqual([]);
  });

  it("a held shortcut acts once (repeats go nowhere)", async () => {
    const { client, canvas, keys } = await setup();
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "t", code: "KeyT", metaKey: true });
    fireEvent.keyDown(canvas, { key: "t", code: "KeyT", metaKey: true, repeat: true });
    fireEvent.keyDown(canvas, { key: "t", code: "KeyT", metaKey: true, repeat: true });
    fireEvent.keyUp(canvas, { key: "t", code: "KeyT", metaKey: true });
    await flush();
    expect(client.callsOf("browser.newTab")).toHaveLength(1);
    expect(keys()).toEqual([]);
  });

  it("the page's keys reach it once each, down and up: ⌘A, ⌘Z, ⌥←, ⌘⌫, Tab, Escape, ş, ⌥Q (@)", async () => {
    const { canvas, keys, press } = await setup();
    canvas.focus();
    const page = [
      { key: "a", code: "KeyA", metaKey: true },
      { key: "z", code: "KeyZ", metaKey: true },
      { key: "ArrowLeft", code: "ArrowLeft", altKey: true },
      { key: "Backspace", code: "Backspace", metaKey: true },
      { key: "Tab", code: "Tab" },
      { key: "Escape", code: "Escape" },
      { key: "ş", code: "Semicolon" },
      { key: "@", code: "KeyQ", altKey: true },
    ];
    for (const k of page) await press(k);
    expect(keys()).toEqual(page.flatMap((k) => [`down:${k.key}`, `up:${k.key}`]));
  });

  it("Kokpit's menu keys (⌘Q, ⌘H, ⌘,) go to neither the page nor the panel — the key is left to the menu bar", async () => {
    const { client, canvas, keys } = await setup();
    canvas.focus();
    for (const k of [
      { key: "q", code: "KeyQ", metaKey: true },
      { key: "h", code: "KeyH", metaKey: true },
      { key: ",", code: "Comma", metaKey: true },
    ]) {
      const down = fireEvent.keyDown(canvas, k);
      fireEvent.keyUp(canvas, k);
      // not prevented: the menu's key equivalent runs
      expect(down).toBe(true);
    }
    await flush();
    expect(keys()).toEqual([]);
    expect(client.callsOf("browser.newTab")).toEqual([]);
  });

  it("in the address bar the browser keys still work (⌘T), and its own editing keys stay its own", async () => {
    const { client, keys, press } = await setup();
    const address = screen.getByLabelText("Adres");
    address.focus();
    await press({ key: "t", code: "KeyT", metaKey: true }, address);
    expect(client.callsOf("browser.newTab")).toHaveLength(1);
    const selectAll = fireEvent.keyDown(address, { key: "a", code: "KeyA", metaKey: true });
    expect(selectAll).toBe(true);
    expect(keys()).toEqual([]);
  });
});
