// The address bar while the user types: a state refresh (browser.changed, a new tab's answer, a reconnect) must
// never replace what is being typed. (browser-tabs.e2e once ended with "Yalnız http(s) adresleri açılabilir." on a
// new tab under CPU load — as if the typed address had been swapped for the tab's about:blank before Enter.)
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, type FrameDrawer } from "./BrowserPanel.tsx";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { FakeResizeObserver } from "./test-utils/fake-view.ts";

const flush = () => act(async () => {});

async function setup() {
  const project = makeProject("p1", "Alfa");
  const client = new FakeEngineClient({ projects: [project] });
  client.browser.handlers["browser.open"]({ projectId: "p1" });
  client.browser.handlers["browser.navigate"]({ projectId: "p1", url: "https://example.com/bir" });
  const draw: FrameDrawer = async () => ({ width: 1280, height: 800 });
  render(<BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} clipboard={null} />);
  await flush();
  const address = screen.getByLabelText("Adres") as HTMLInputElement;
  return { client, address };
}

const changed = (client: FakeEngineClient) => act(() => client.emitEvent({ type: "event", name: "browser.changed", projectId: "p1" }));

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

describe("BrowserPanel: the address bar while typing", () => {
  it("shows the active tab's address until the user types", async () => {
    const { address } = await setup();
    expect(address.value).toBe("https://example.com/bir");
  });

  it("a refresh with another address (new tab → about:blank) arriving while the user types does not replace the text; Enter opens what was typed", async () => {
    const { client, address } = await setup();
    address.focus();
    fireEvent.change(address, { target: { value: "example.com/iki" } });
    // The engine reports a new active tab at about:blank — after the typing started.
    client.browser.handlers["browser.newTab"]({ projectId: "p1" });
    await changed(client);
    await flush();
    expect(address.value).toBe("example.com/iki");
    fireEvent.submit(address.closest("form")!);
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.callsOf("browser.navigate")).toEqual([{ projectId: "p1", url: "https://example.com/iki" }]);
  });

  it("typing right after the panel's own '+' (the new tab's answer still on its way) is kept as well", async () => {
    const { client, address } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Yeni sekme" }));
    // Typed before the answer was rendered.
    address.focus();
    fireEvent.change(address, { target: { value: "example.com/uc" } });
    await flush();
    await changed(client);
    await flush();
    expect(address.value).toBe("example.com/uc");
    fireEvent.submit(address.closest("form")!);
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.callsOf("browser.navigate").at(-1)).toEqual({ projectId: "p1", url: "https://example.com/uc" });
  });

  it("several refreshes in a row while typing, then more typing: still the user's text", async () => {
    const { client, address } = await setup();
    address.focus();
    fireEvent.change(address, { target: { value: "exa" } });
    for (let i = 0; i < 5; i++) {
      client.browser.handlers["browser.navigate"]({ projectId: "p1", url: `https://example.com/arka-${i}` });
      await changed(client);
    }
    fireEvent.change(address, { target: { value: "example.com/dort" } });
    await flush();
    expect(address.value).toBe("example.com/dort");
  });

  it("the WINDOW losing focus (another app in front) is not leaving the field: the typed text survives a refresh", async () => {
    const { client, address } = await setup();
    address.focus();
    fireEvent.change(address, { target: { value: "example.com/alti" } });
    // What the browser does when the window is deactivated: a blur event, but the field stays the active element.
    fireEvent.blur(address);
    expect(document.activeElement).toBe(address);
    client.browser.handlers["browser.newTab"]({ projectId: "p1" });
    await changed(client);
    await flush();
    expect(address.value).toBe("example.com/alti");
    fireEvent.submit(address.closest("form")!);
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.callsOf("browser.navigate").at(-1)).toEqual({ projectId: "p1", url: "https://example.com/alti" });
  });

  it("once the field is left, it follows the page again", async () => {
    const { client, address } = await setup();
    address.focus();
    fireEvent.change(address, { target: { value: "yarım" } });
    act(() => address.blur());
    client.browser.handlers["browser.navigate"]({ projectId: "p1", url: "https://example.com/bes" });
    await changed(client);
    await flush();
    expect(address.value).toBe("https://example.com/bes");
  });
});
