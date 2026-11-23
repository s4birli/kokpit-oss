// İş M — Git menu and first launch inside the workbench: site tabs open in the Web panel.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webConfig } from "../engine/web-ipc.ts";
import { Workbench } from "./Workbench.tsx";
import { defaultLayoutConfig } from "./layout/config.ts";
import { FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";
import { menuChecked, menuCommand } from "./test-utils/fake-menu.ts";
import { fakeUiStateBridge, type FakeUiStateBridge } from "./test-utils/fake-ui-state.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "./test-utils/fake-view.ts";
import { FakeWebBridge, TEST_SITES } from "./test-utils/fake-web.ts";
import { isDockTab } from "./test-utils/terminal-tabs.ts";
import { onViewCommand } from "./view-prefs.ts";

const flush = () => act(async () => {});
const config = { ...defaultLayoutConfig, saveDebounceMs: 5 };
const dockTabs = () => screen.queryAllByRole("tab").filter(isDockTab).map((t) => t.getAttribute("aria-label"));
const siteTabs = () =>
  within(screen.getByRole("group", { name: "Site sekmeleri" }))
    .queryAllByRole("button", { pressed: true })
    .concat(within(screen.getByRole("group", { name: "Site sekmeleri" })).queryAllByRole("button", { pressed: false }))
    .map((b) => b.textContent);
const activeSite = () => within(screen.getByRole("group", { name: "Site sekmeleri" })).queryByRole("button", { pressed: true })?.textContent;

let web: FakeWebBridge;

async function setup(bridge: FakeUiStateBridge, projects = [makeProject("p1", "Alfa")]) {
  const client = new FakeEngineClient({ projects });
  const r = render(
    <Workbench client={client} onOpenSettings={() => {}} createView={makeFakeViewFactory().factory} uiState={bridge} layoutConfig={config} />,
  );
  await flush();
  await flush();
  return r;
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  web = new FakeWebBridge(TEST_SITES.map((s) => (s.id === "home" ? { ...s, id: webConfig.firstLaunchSiteId } : s)));
  vi.stubGlobal("kokpit", { web });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workbench: web sekmeleri (İş M)", () => {
  it("first launch (nothing saved): the Ana sayfa tab is open and active in the Web panel", async () => {
    await setup(fakeUiStateBridge());
    expect(dockTabs()).toContain("Web");
    expect(screen.getByRole("region", { name: "Web" })).toBeTruthy();
    expect(activeSite()).toBe("Ana sayfa");
    expect(menuChecked("Web")).toBe(true);
  });

  it("İş D: first launch — Ana sayfa stays on screen in the first project picked; a later project starts from the default", async () => {
    await setup(fakeUiStateBridge(), [makeProject("p1", "Alfa"), makeProject("p2", "Beta")]);
    expect(activeSite()).toBe("Ana sayfa");
    const pick = async (name: string) => {
      fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name }));
      await flush();
    };
    // Layouts are per project: without this the welcome page would vanish with the first click.
    await pick("Alfa");
    expect(dockTabs()).toContain("Web");
    expect(activeSite()).toBe("Ana sayfa");
    expect(menuChecked("Web")).toBe(true);
    await pick("Beta");
    expect(dockTabs()).not.toContain("Web");
    await pick("Alfa");
    expect(dockTabs()).toContain("Web");
  });

  it("a later launch (saved state) opens nothing by itself", async () => {
    await setup(fakeUiStateBridge({ version: 1, layouts: {}, panels: {}, selection: null }));
    expect(dockTabs()).not.toContain("Web");
  });

  it("first launch without that site in the list (e.g. the user removed it): nothing opens", async () => {
    web.list = web.list.filter((s) => s.id !== webConfig.firstLaunchSiteId);
    await setup(fakeUiStateBridge());
    expect(dockTabs()).not.toContain("Web");
  });

  it("Git › Wiki opens its tab (Web panel added when closed), again only selects it; tabs survive a restart", async () => {
    const bridge = fakeUiStateBridge({ version: 1, layouts: {}, panels: {}, selection: null });
    const first = await setup(bridge);
    menuCommand({ type: "site.open", siteId: "wiki" });
    await flush();
    expect(dockTabs()).toContain("Web");
    expect(activeSite()).toBe("Wiki");
    menuCommand({ type: "site.open", siteId: "notlar" });
    await flush();
    menuCommand({ type: "site.open", siteId: "wiki" });
    await flush();
    expect(siteTabs().sort()).toEqual(["Notlar", "Wiki"]);
    expect(activeSite()).toBe("Wiki");
    // İş D: where the Web panel is (and whether it is open) belongs to each project's layout…
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Alfa" }));
    await flush();
    expect(dockTabs()).not.toContain("Web");
    // …but its content is global: opened in another project it shows the same site tabs.
    menuCommand({ type: "site.open", siteId: "wiki" });
    await flush();
    expect(dockTabs()).toContain("Web");
    expect(siteTabs().sort()).toEqual(["Notlar", "Wiki"]);
    expect(activeSite()).toBe("Wiki");
    await act(async () => {
      first.unmount();
    });
    await setup(bridge);
    expect(dockTabs()).toContain("Web");
    expect(siteTabs().sort()).toEqual(["Notlar", "Wiki"]);
    expect(activeSite()).toBe("Wiki");
  });

  it("Git › <site> after picking a project in the rail (which clears focus requests) still opens it", async () => {
    await setup(fakeUiStateBridge());
    expect(activeSite()).toBe("Ana sayfa");
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Alfa" }));
    await flush();
    menuCommand({ type: "site.open", siteId: "wiki" });
    await flush();
    expect(activeSite()).toBe("Wiki");
  });

  it("menu font/zoom items reach İş Z's view commands; Yardım › Claude komutları opens the Claude panel", async () => {
    await setup(fakeUiStateBridge({ version: 1, layouts: {}, panels: {}, selection: null }));
    const seen: string[] = [];
    const off = onViewCommand((c) => seen.push(c));
    menuCommand({ type: "terminal.font.larger" });
    menuCommand({ type: "browser.zoom.out" });
    off();
    expect(seen).toEqual(["terminal.font.larger", "browser.zoom.out"]);
    expect(dockTabs()).not.toContain("Claude");
    menuCommand({ type: "claude.help" });
    await flush();
    expect(dockTabs()).toContain("Claude");
  });

  it("Görünüm › Web closes and reopens the panel; the tabs come back", async () => {
    await setup(fakeUiStateBridge());
    menuCommand({ type: "panel.toggle", panelId: "web" });
    await flush();
    expect(dockTabs()).not.toContain("Web");
    menuCommand({ type: "panel.toggle", panelId: "web" });
    await flush();
    expect(activeSite()).toBe("Ana sayfa");
  });
});
