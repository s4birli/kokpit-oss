import type { CreateClientOptions } from "./engine/client.ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { EngineSettings, SettingsBridge } from "./engine/types.ts";
import { FakeEngineClient, makeProject, makeProjectTerminal, makeTool } from "./ui/test-utils/fake-client.ts";
import { FakeResizeObserver, makeFakeViewFactory } from "./ui/test-utils/fake-view.ts";
import { menuCommand } from "./ui/test-utils/fake-menu.ts";

const flush = () => act(async () => {});
const SETTINGS: EngineSettings = { url: "ws://engine.test:1", key: "k" };

function seedClient() {
  return new FakeEngineClient({
    projects: [makeProject("p1", "Alfa"), makeProject("home", "Ev", { builtin: true })],
    terminals: [makeProjectTerminal("tp1", "p1", "P-1")],
    tools: [makeTool("t1", "Birinci", { installCommand: "kur-1" })],
    toolStatuses: [{ toolId: "t1", installed: false }],
  });
}

async function setup() {
  const clients: FakeEngineClient[] = [];
  const created: EngineSettings[] = [];
  const bridge: SettingsBridge = {
    load: vi.fn(async () => SETTINGS),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  const views = makeFakeViewFactory();
  render(
    <App
      bridge={bridge}
      createView={views.factory}
      createClient={(s) => {
        created.push(s);
        const c = seedClient();
        clients.push(c);
        return c;
      }}
    />,
  );
  await flush();
  await flush();
  return { bridge, clients, created };
}

const rail = () => screen.getByRole("navigation", { name: "Kokpit" });
const tabpanel = () => screen.getByRole("tabpanel");

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App: the transport gate", () => {
  it("every client gets main's gate: the key's handshake starts only once main says the transport is protected", async () => {
    const check = vi.fn(async () => ({ ok: false as const, message: "güvenli değil" }));
    const bridge: SettingsBridge = {
      load: vi.fn(async () => SETTINGS),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      connection: { check, insecureAllowed: vi.fn(async () => false), setInsecure: vi.fn(async () => {}) },
    };
    const seen: (CreateClientOptions | undefined)[] = [];
    render(
      <App
        bridge={bridge}
        createView={makeFakeViewFactory().factory}
        createClient={(_s, opts) => {
          seen.push(opts);
          return seedClient();
        }}
      />,
    );
    await flush();
    await flush();
    expect(seen).toHaveLength(1);
    expect(await seen[0]!.checkTransport!(SETTINGS.url)).toEqual({ ok: false, message: "güvenli değil" });
    expect(check).toHaveBeenCalledWith(SETTINGS.url);
  });
});

describe("App settings routing", () => {
  it("'Ayarlar' opens settings on Projeler, keeps the client and workbench state; 'Geri' returns", async () => {
    const { clients } = await setup();
    fireEvent.click(within(rail()).getByRole("button", { name: "Alfa" }));
    await flush();
    expect(screen.getByRole("region", { name: "Terminal: P-1" })).toBeTruthy();
    fireEvent.click(within(rail()).getByRole("button", { name: "Ayarlar" }));
    await flush();
    expect(screen.getByRole("heading", { name: "Ayarlar" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Projeler" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("navigation", { name: "Kokpit" })).toBeNull();
    expect(clients).toHaveLength(1);
    expect(clients[0]!.closed).toBe(false);
    const attaches = clients[0]!.callsOf("terminal.attach").length;
    fireEvent.click(screen.getByRole("button", { name: "Geri" }));
    await flush();
    expect(screen.queryByRole("heading", { name: "Ayarlar" })).toBeNull();
    expect(within(rail()).getByRole("button", { name: "Alfa" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("region", { name: "Terminal: P-1" })).toBeTruthy();
    // The panel stayed mounted: no re-attach.
    expect(clients[0]!.callsOf("terminal.attach")).toHaveLength(attaches);
  });

  it("İş M: menu Ayarlar… opens Projeler, Git › Siteleri düzenle… opens Siteler, a junk tab falls back; Git › <site> closes settings", async () => {
    await setup();
    const selected = () => screen.getByRole("tab", { selected: true }).textContent;
    menuCommand({ type: "settings.open" });
    await flush();
    expect(selected()).toBe("Projeler");
    menuCommand({ type: "settings.open", tab: "sites" });
    await flush();
    expect(selected()).toBe("Siteler");
    menuCommand({ type: "settings.open", tab: "nope" });
    await flush();
    expect(selected()).toBe("Projeler");
    menuCommand({ type: "site.open", siteId: "wiki" });
    await flush();
    expect(screen.queryByRole("heading", { name: "Ayarlar" })).toBeNull();
    expect(rail()).toBeTruthy();
  });

  it("the banner's 'Bağlantı ayarları' opens the Bağlantı tab; saving reconnects with the new settings", async () => {
    const { bridge, clients, created } = await setup();
    act(() => clients[0]!.setState("reconnecting"));
    fireEvent.click(screen.getByRole("button", { name: "Bağlantı ayarları" }));
    await flush();
    expect(screen.getByRole("tab", { name: "Bağlantı" }).getAttribute("aria-selected")).toBe("true");
    const url = within(tabpanel()).getByLabelText("Motor adresi") as HTMLInputElement;
    expect(url.value).toBe(SETTINGS.url);
    fireEvent.change(url, { target: { value: "ws://yeni.test:2" } });
    fireEvent.change(within(tabpanel()).getByLabelText("Anahtar"), { target: { value: "eWVuaS1hbmFodGFyLTAxMjM0NTY3ODlhYmNkZWYtMDEyMzQ1Njc" } });
    fireEvent.click(within(tabpanel()).getByRole("button", { name: "Bağlan" }));
    await flush();
    await flush();
    expect(bridge.save).toHaveBeenCalledWith({ url: "ws://yeni.test:2", key: "eWVuaS1hbmFodGFyLTAxMjM0NTY3ODlhYmNkZWYtMDEyMzQ1Njc" });
    expect(clients[0]!.closed).toBe(true);
    expect(created.at(-1)).toEqual({ url: "ws://yeni.test:2", key: "eWVuaS1hbmFodGFyLTAxMjM0NTY3ODlhYmNkZWYtMDEyMzQ1Njc" });
    expect(screen.queryByRole("heading", { name: "Ayarlar" })).toBeNull();
    expect(within(rail()).getByRole("button", { name: "Alfa" })).toBeTruthy();
  });

  it("'Kur' closes settings and shows the install terminal in the built-in project", async () => {
    const { clients } = await setup();
    fireEvent.click(within(rail()).getByRole("button", { name: "Ayarlar" }));
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Araçlar" }));
    await flush();
    fireEvent.click(within(tabpanel()).getByRole("button", { name: "Kur: Birinci" }));
    await flush();
    await flush();
    expect(clients[0]!.callsOf("tools.install")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Ayarlar" })).toBeNull();
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Ev" })).toBeTruthy();
    expect(within(rail()).getByRole("button", { name: "Ev" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("region", { name: "Terminal: kur-1" })).toBeTruthy();
  });

  it("an unauthorized client while in settings goes back to the connect screen", async () => {
    const { clients } = await setup();
    fireEvent.click(within(rail()).getByRole("button", { name: "Ayarlar" }));
    await flush();
    act(() => clients[0]!.setState("unauthorized"));
    await flush();
    expect(screen.getByRole("heading", { name: "Motora bağlan" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

// Kendini güncelleme: after an update the Keychain may refuse the new build the stored key.
describe("App: stored settings whose key cannot be read", () => {
  it("shows the connect screen with the stored address and one line of explanation; entering the key once connects", async () => {
    const saved: EngineSettings[] = [];
    const created: EngineSettings[] = [];
    const bridge: SettingsBridge = {
      load: vi.fn(async () => null),
      locked: vi.fn(async () => ({ url: "ws://100.64.0.9:7420" })),
      save: vi.fn(async (s: EngineSettings) => void saved.push(s)),
      clear: vi.fn(async () => {}),
    };
    render(
      <App
        bridge={bridge}
        createView={makeFakeViewFactory().factory}
        createClient={(s) => {
          created.push(s);
          return seedClient();
        }}
      />,
    );
    await flush();
    await flush();
    expect(screen.getByRole("heading", { name: "Motora bağlan" })).toBeTruthy();
    expect((screen.getByLabelText(/Motor adresi/) as HTMLInputElement).value).toBe("ws://100.64.0.9:7420");
    expect(screen.getByRole("status").textContent).toContain("Kayıtlı anahtar bu derlemede okunamadı");
    // Nothing was cleared or overwritten by merely starting.
    expect(bridge.clear).not.toHaveBeenCalled();
    expect(bridge.save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Anahtar/), { target: { value: "dGhlLWtleS1lbnRlcmVkLW9uY2UtMDEyMzQ1Njc4OWFiY2RlZg" } });
    fireEvent.submit(screen.getByRole("form"));
    await flush();
    await flush();
    expect(saved).toEqual([{ url: "ws://100.64.0.9:7420", key: "dGhlLWtleS1lbnRlcmVkLW9uY2UtMDEyMzQ1Njc4OWFiY2RlZg" }]);
    expect(created).toEqual([{ url: "ws://100.64.0.9:7420", key: "dGhlLWtleS1lbnRlcmVkLW9uY2UtMDEyMzQ1Njc4OWFiY2RlZg" }]);
  });

  it("nothing stored at all → the plain connect screen, no notice", async () => {
    const bridge: SettingsBridge = { load: vi.fn(async () => null), locked: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    render(<App bridge={bridge} createView={makeFakeViewFactory().factory} createClient={() => seedClient()} />);
    await flush();
    await flush();
    expect((screen.getByLabelText(/Motor adresi/) as HTMLInputElement).value).toBe("");
    expect(screen.queryByText(/okunamadı/)).toBeNull();
  });

  it("a bridge from before this (no `locked`) still works", async () => {
    const bridge: SettingsBridge = { load: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    render(<App bridge={bridge} createView={makeFakeViewFactory().factory} createClient={() => seedClient()} />);
    await flush();
    await flush();
    expect(screen.getByRole("heading", { name: "Motora bağlan" })).toBeTruthy();
  });
});
