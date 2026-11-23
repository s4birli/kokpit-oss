// İş B: the Tarayıcı panel's "Uzantılar" menu (developer extensions on the engine machine, Web Store note,
// bring the Mac mini window to front).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, type FrameDrawer } from "./BrowserPanel.tsx";
import { defaultUiConfig } from "./config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { FakeResizeObserver } from "./test-utils/fake-view.ts";

const flush = () => act(async () => {});
const draw: FrameDrawer = async () => ({ width: 1280, height: 800 });

const SHOW = `${defaultUiConfig.machineName} ekranında göster`;

function setup(opts: { running?: boolean; runOn?: "client"; window?: "visible" } = {}) {
  const project = makeProject(
    "p1",
    "Alfa",
    opts.runOn ? { browser: { runOn: opts.runOn } } : opts.window ? { browser: { runOn: "engine", window: opts.window } } : {},
  );
  const client = new FakeEngineClient({ projects: [project] });
  if (opts.running) client.browser.handlers["browser.open"]({ projectId: "p1" });
  render(<BrowserPanel client={client} project={project} config={defaultUiConfig} drawFrame={draw} />);
  return { client };
}

async function openMenu() {
  await flush();
  const toggle = screen.getByRole("button", { name: "Uzantılar" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  await flush();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  return screen.getByRole("region", { name: "Uzantılar" });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BrowserPanel: Uzantılar", () => {
  it("lists remembered extensions with their state when opened", async () => {
    const { client } = setup({ running: true });
    client.browser.extensions.set("p1", [
      { path: "/Users/m/ext", id: "a".repeat(32), name: "Benim uzantım", version: "2.1", loaded: true },
      { path: "/Users/m/eski", loaded: false, error: "Uzantı klasörü bulunamadı: /Users/m/eski" },
    ]);
    const menu = await openMenu();
    expect(client.callsOf("browser.extensions.list")).toEqual([{ projectId: "p1" }]);
    const items = within(menu).getAllByRole("listitem");
    expect(items[0]!.textContent).toMatch(/Benim uzantım/);
    expect(items[0]!.textContent).toMatch(/2\.1/);
    expect(items[0]!.textContent).toMatch(/yüklü/);
    expect(items[1]!.textContent).toMatch(/\/Users\/m\/eski/);
    expect(items[1]!.textContent).toMatch(/bulunamadı/);
  });

  it("'Geliştirici uzantısı yükle' sends the engine-side folder; the list updates; errors are shown", async () => {
    const { client } = setup();
    const menu = await openMenu();
    expect(within(menu).getByText(/Henüz geliştirici uzantısı yok/)).toBeTruthy();
    const input = within(menu).getByLabelText(/Uzantı klasörü/);
    fireEvent.change(input, { target: { value: "  /Users/m/yok  " } });
    fireEvent.click(within(menu).getByRole("button", { name: "Geliştirici uzantısı yükle" }));
    await flush();
    expect(within(menu).getByRole("alert").textContent).toMatch(/manifest\.json/);
    fireEvent.change(input, { target: { value: "/Users/m/ext" } });
    fireEvent.click(within(menu).getByRole("button", { name: "Geliştirici uzantısı yükle" }));
    await flush();
    expect(client.callsOf("browser.extensions.loadUnpacked")).toEqual([
      { projectId: "p1", path: "/Users/m/yok" },
      { projectId: "p1", path: "/Users/m/ext" },
    ]);
    expect(within(menu).getByText("Test uzantısı")).toBeTruthy();
    expect(within(menu).queryByRole("alert")).toBeNull();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("a relative or empty folder is refused in the app (the folder is on the Mac mini, give its full path)", async () => {
    const { client } = setup();
    const menu = await openMenu();
    for (const value of ["", "ext", "~/ext"]) {
      fireEvent.change(within(menu).getByLabelText(/Uzantı klasörü/), { target: { value } });
      fireEvent.click(within(menu).getByRole("button", { name: "Geliştirici uzantısı yükle" }));
      await flush();
      expect(within(menu).getByRole("alert").textContent).toMatch(/tam yol|\//);
    }
    expect(client.callsOf("browser.extensions.loadUnpacked")).toEqual([]);
  });

  it("Kaldır removes one", async () => {
    const { client } = setup({ running: true });
    client.browser.extensions.set("p1", [{ path: "/Users/m/ext", id: "a".repeat(32), name: "Benim uzantım", version: "1", loaded: true }]);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("button", { name: "Kaldır: Benim uzantım" }));
    await flush();
    expect(client.callsOf("browser.extensions.remove")).toEqual([{ projectId: "p1", path: "/Users/m/ext" }]);
    expect(within(menu).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("explains Web Store installs: they need Chrome's own window, so the browser must be shown first", async () => {
    setup({ running: true });
    const menu = await openMenu();
    const note = within(menu).getByText(/Web Mağazası/).textContent ?? "";
    expect(note).toMatch(/Ekran Paylaşımı/);
    expect(note).toContain(SHOW);
  });

  // Gizli tarayıcı
  it(`hidden by default: "${SHOW}" is a one-click toggle (with why in its tooltip) that sets the project's window`, async () => {
    const { client } = setup({ running: true });
    const menu = await openMenu();
    const box = within(menu).getByRole("checkbox", { name: SHOW }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.closest("label")?.getAttribute("title")).toMatch(/eşitleme onayı, uzantı açılır pencereleri/);
    // Nothing to bring forward while hidden.
    expect(within(menu).queryByRole("button", { name: "Öne getir" })).toBeNull();
    fireEvent.click(box);
    await flush();
    expect(client.callsOf("projects.update")).toEqual([{ projectId: "p1", browser: { runOn: "engine", window: "visible" } }]);
    expect(box.checked).toBe(true);
  });

  it("visible: the toggle is on, turning it off hides again; 'Öne getir' brings the window forward while running", async () => {
    const { client } = setup({ running: true, window: "visible" });
    const menu = await openMenu();
    const box = within(menu).getByRole("checkbox", { name: SHOW }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(within(menu).getByRole("button", { name: "Öne getir" }));
    await flush();
    expect(client.callsOf("browser.showWindow")).toEqual([{ projectId: "p1" }]);
    fireEvent.click(box);
    await flush();
    expect(client.callsOf("projects.update").at(-1)).toEqual({ projectId: "p1", browser: { runOn: "engine", window: "hidden" } });
  });

  it("closed browser: the setting can be changed, but there is no window to bring forward", async () => {
    setup({ window: "visible" });
    const menu = await openMenu();
    expect(within(menu).getByRole("checkbox", { name: SHOW })).toBeTruthy();
    expect(within(menu).queryByRole("button", { name: "Öne getir" })).toBeNull();
  });

  it("a refused change shows the engine's reason and the toggle stays as it was", async () => {
    const { client } = setup({ running: true });
    client.fail("projects.update", "INVALID", "olmadı");
    const menu = await openMenu();
    const box = within(menu).getByRole("checkbox", { name: SHOW }) as HTMLInputElement;
    fireEvent.click(box);
    await flush();
    expect(within(menu).getByRole("alert").textContent).toMatch(/olmadı/);
    expect(box.checked).toBe(false);
  });

  it("client-side browser: no Uzantılar menu (extensions are installed in that Chrome directly)", async () => {
    setup({ runOn: "client" });
    await flush();
    expect(screen.queryByRole("button", { name: "Uzantılar" })).toBeNull();
  });
});
