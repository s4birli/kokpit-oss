import type { TerminalInfo } from "@kokpit/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultUiConfig } from "../config.ts";
import { FakeEngineClient, makeCard, makeHost, makeProject, makeSshProject, makeTool } from "../test-utils/fake-client.ts";
import { Settings, type SettingsProps } from "./Settings.tsx";
import type { SettingsTab } from "./tabs.ts";
import { getLocale, setLocale } from "@kokpit/shared/i18n";

const flush = () => act(async () => {});
const machine = defaultUiConfig.machineName;

function seed() {
  return new FakeEngineClient({
    projects: [
      makeProject("p1", "Alfa", { defaultToolId: "t1" }),
      makeProject("home", "Ev", { builtin: true, location: { kind: "local", path: "/Users/u" } }),
      makeSshProject("p3", "Uzak", "h1"),
    ],
    cards: [makeCard("a", "p1")],
    hosts: [
      makeHost("cfg", "oracle", { source: "ssh-config", hostname: "oracle" }),
      makeHost("h1", "yapı", { hostname: "10.0.0.5", user: "deploy", port: 2222, identityFile: "id_ed25519" }),
    ],
    keys: ["id_ed25519", "id_rsa"],
    tools: [
      makeTool("t1", "Birinci", { installCommand: "kur-1", checkCommand: "kontrol-1" }),
      makeTool("t2", "İkinci", { installCommand: "kur-2" }),
      makeTool("t3", "Üçüncü"),
    ],
    toolStatuses: [
      { toolId: "t1", installed: true },
      { toolId: "t2", installed: false },
      { toolId: "t3", installed: null },
    ],
  });
}

async function setup(tab: SettingsTab, client = seed(), extra: Partial<SettingsProps> = {}) {
  const onBack = vi.fn();
  const onInstalled = vi.fn<(t: TerminalInfo) => void>();
  let current = tab;
  const props = (): SettingsProps => ({
    client,
    tab: current,
    onTabChange: (t) => {
      current = t;
      utils.rerender(<Settings {...props()} />);
    },
    onBack,
    onInstalled,
    connection: <p>bağlantı formu</p>,
    ...extra,
  });
  const utils = render(<Settings {...props()} />);
  await flush();
  return { client, onBack, onInstalled };
}

const panel = () => screen.getByRole("tabpanel");
const btn = (name: string | RegExp) => within(panel()).getByRole("button", { name });
const field = (label: string) => within(panel()).getByLabelText(label) as HTMLInputElement & HTMLSelectElement;
const change = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
async function press(name: string | RegExp) {
  fireEvent.click(btn(name));
  await flush();
}
const alertText = () => within(panel()).getByRole("alert").textContent;

afterEach(cleanup);

describe("Settings shell", () => {
  it("has its tabs, switches with click and arrow keys, and Geri calls onBack", async () => {
    const { onBack } = await setup("projects");
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Projeler", "Sunucular", "Araçlar", "Claude hesapları", "Siteler", "Bağlantı", "Dil"]); // İş H, i18n
    expect(screen.getByRole("tab", { name: "Projeler" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Bağlantı" }));
    await flush();
    expect(within(panel()).getByText("bağlantı formu")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Bağlantı" }), { key: "ArrowRight" });
    await flush();
    expect(screen.getByRole("tab", { name: "Dil" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Dil" }), { key: "ArrowRight" });
    await flush();
    expect(screen.getByRole("tab", { name: "Projeler" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Geri" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("Settings: Dil (i18n)", () => {
  afterEach(() => setLocale("tr"));

  it("lists each language by its own name and switches the whole screen at once", async () => {
    await setup("language");
    const select = field("Dil");
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["en", "English"],
      ["tr", "Türkçe"],
    ]);
    expect(select.value).toBe("tr");
    fireEvent.change(select, { target: { value: "en" } });
    await flush();
    expect(getLocale()).toBe("en");
    expect(field("Language").value).toBe("en");
    expect(screen.getByRole("tab", { name: "Language" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Settings: Projeler", () => {
  it("lists projects (built-in first) with their locations; built-in cannot be deleted", async () => {
    await setup("projects");
    const items = within(panel()).getAllByRole("listitem");
    expect(items.map((i) => within(i).getByRole("heading").textContent)).toEqual(["Ev", "Alfa", "Uzak"]);
    expect(within(items[1]!).getByText(`${machine}: /repos/p1`)).toBeTruthy();
    expect(within(items[2]!).getByText("SSH: yapı")).toBeTruthy();
    expect(within(items[0]!).queryByRole("button", { name: /^Sil/ })).toBeNull();
    expect(within(items[1]!).getByRole("button", { name: "Sil: Alfa" })).toBeTruthy();
  });

  it("creates a local project with a default tool", async () => {
    const { client } = await setup("projects");
    await press("Proje ekle");
    change("Ad", "  Yeni ");
    fireEvent.click(within(panel()).getByLabelText(`${machine} klasörü`));
    change("Klasör yolu", "/Users/u/kod");
    change("Varsayılan araç", "t2");
    await press("Kaydet");
    expect(client.callsOf("projects.create")).toEqual([
      { name: "Yeni", location: { kind: "local", path: "/Users/u/kod" }, defaultToolId: "t2" },
    ]);
    expect(within(panel()).getByRole("heading", { name: "Yeni" })).toBeTruthy();
    expect(within(panel()).queryByLabelText("Klasör yolu")).toBeNull();
  });

  it("validates name, folder path and GitHub address before sending", async () => {
    const { client } = await setup("projects");
    await press("Proje ekle");
    change("Klasör yolu", "göreli/yol");
    await press("Kaydet");
    expect(within(panel()).getByText("Ad gerekli.")).toBeTruthy();
    expect(within(panel()).getByText("Klasör yolu / ile başlamalı.")).toBeTruthy();
    expect(field("Klasör yolu").getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(within(panel()).getByLabelText("GitHub"));
    change("Ad", "x");
    change("GitHub adresi", "-oProxyCommand=kötü");
    await press("Kaydet");
    expect(within(panel()).getByText("https:// ya da git@ adresi olmalı.")).toBeTruthy();
    expect(client.callsOf("projects.create")).toHaveLength(0);
  });

  it("GitHub create shows 'Klonlanıyor…' while pending and omits an empty default tool", async () => {
    const client = seed();
    let finish: () => void = () => {};
    client.respond(
      "projects.create",
      (p) =>
        new Promise((res) => {
          finish = () => res({ project: makeProject("g", p.name) });
        }),
    );
    await setup("projects", client);
    await press("Proje ekle");
    change("Ad", "Depo");
    fireEvent.click(within(panel()).getByLabelText("GitHub"));
    change("GitHub adresi", "git@github.com:o/depo.git");
    change("Varsayılan araç", "");
    await press("Kaydet");
    expect(within(panel()).getByRole("status").textContent).toContain("Klonlanıyor…");
    expect(client.callsOf("projects.create")).toEqual([
      { name: "Depo", location: { kind: "github", url: "git@github.com:o/depo.git" } },
    ]);
    await act(async () => finish());
    expect(within(panel()).queryByText("Klonlanıyor…")).toBeNull();
  });

  it("creates an SSH project with a host and optional remote folder; shows engine errors verbatim", async () => {
    const client = seed();
    client.fail("projects.create", "INVALID", "Sunucu bulunamadı");
    await setup("projects", client);
    await press("Proje ekle");
    change("Ad", "Sunucu işi");
    fireEvent.click(within(panel()).getByLabelText("SSH sunucusu"));
    const options = Array.from(field("Sunucu").options).map((o) => o.textContent);
    expect(options).toEqual(["Seç…", "oracle", "yapı"]);
    await press("Kaydet");
    expect(within(panel()).getByText("Sunucu seç.")).toBeTruthy();
    change("Sunucu", "cfg");
    change("Uzak klasör", "srv");
    await press("Kaydet");
    expect(within(panel()).getByText("Uzak klasör / ile başlamalı.")).toBeTruthy();
    change("Uzak klasör", "");
    await press("Kaydet");
    expect(client.callsOf("projects.create")).toEqual([{ name: "Sunucu işi", location: { kind: "ssh", hostId: "cfg" } }]);
    expect(alertText()).toBe("Sunucu bulunamadı");
  });

  it("the project's tool select offers 'Genel varsayılan (<tool>)' meaning no project default", async () => {
    const client = seed();
    client.settings = { defaultToolId: "t3" };
    await setup("projects", client);
    await press("Proje ekle");
    const options = Array.from(field("Varsayılan araç").options).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ["", "Genel varsayılan (Üçüncü)"],
      ["t1", "Birinci"],
      ["t2", "İkinci"],
      ["t3", "Üçüncü"],
    ]);
    await press("Vazgeç");
    await press("Düzenle: Alfa");
    change("Varsayılan araç", "");
    await press("Kaydet");
    expect(client.callsOf("projects.update")).toEqual([{ projectId: "p1", name: "Alfa", defaultToolId: null }]);
  });

  it("without a global default the option reads 'Genel varsayılan (Yalnız kabuk)' and follows settings.changed", async () => {
    const { client } = await setup("projects");
    await press("Proje ekle");
    expect(field("Varsayılan araç").options[0]?.textContent).toBe("Genel varsayılan (Yalnız kabuk)");
    client.settings = { defaultToolId: "t1" };
    act(() => client.emitEvent({ type: "event", name: "settings.changed" }));
    await flush();
    expect(field("Varsayılan araç").options[0]?.textContent).toBe("Genel varsayılan (Birinci)");
  });

  it("edit changes name and default tool; an unchanged location is not sent", async () => {
    const { client } = await setup("projects");
    await press("Düzenle: Alfa");
    expect(field("Klasör yolu").value).toBe("/repos/p1");
    expect(within(panel()).queryByText(/Konum değiştirilemez/)).toBeNull();
    expect(field("Ad").value).toBe("Alfa");
    expect(field("Varsayılan araç").value).toBe("t1");
    change("Ad", "Alfa 2");
    change("Varsayılan araç", "");
    await press("Kaydet");
    expect(client.callsOf("projects.update")).toEqual([{ projectId: "p1", name: "Alfa 2", defaultToolId: null }]);
    expect(within(panel()).getByRole("heading", { name: "Alfa 2" })).toBeTruthy();
  });

  it("delete asks for confirmation and shows the engine reason verbatim", async () => {
    const client = seed();
    client.fail("projects.delete", "INVALID", "Önce kartları sil");
    await setup("projects", client);
    await press("Sil: Alfa");
    expect(client.callsOf("projects.delete")).toHaveLength(0);
    await press("Silmeyi onayla");
    expect(client.callsOf("projects.delete")).toEqual([{ projectId: "p1" }]);
    expect(alertText()).toBe("Önce kartları sil");
    client.restore("projects.delete");
    await press("Sil: Alfa");
    await press("Silmeyi onayla");
    expect(within(panel()).queryByRole("heading", { name: "Alfa" })).toBeNull();
  });

  it("Vazgeç closes the form without sending", async () => {
    const { client } = await setup("projects");
    await press("Proje ekle");
    change("Ad", "x");
    await press("Vazgeç");
    expect(within(panel()).queryByLabelText("Ad")).toBeNull();
    expect(client.callsOf("projects.create")).toHaveLength(0);
  });

  it("projects.changed reloads the list", async () => {
    const { client } = await setup("projects");
    client.projects.push(makeProject("p9", "Dışarıdan"));
    act(() => client.emitEvent({ type: "event", name: "projects.changed" }));
    await flush();
    expect(within(panel()).getByRole("heading", { name: "Dışarıdan" })).toBeTruthy();
  });
});

describe("Settings: Sunucular", () => {
  it("shows ssh-config hosts read-only with a badge; Kokpit hosts are editable", async () => {
    await setup("servers");
    const items = within(panel()).getAllByRole("listitem");
    const cfg = items.find((i) => within(i).queryByText("oracle"))!;
    expect(within(cfg).getByText("~/.ssh/config")).toBeTruthy();
    expect(within(cfg).queryByRole("button")).toBeNull();
    const own = items.find((i) => within(i).queryByText("yapı"))!;
    expect(within(own).getByText("deploy@10.0.0.5:2222")).toBeTruthy();
    expect(within(own).getByRole("button", { name: "Düzenle: yapı" })).toBeTruthy();
    expect(within(own).getByRole("button", { name: "Sil: yapı" })).toBeTruthy();
  });

  it("creates a host with a key picked from the list (file names only)", async () => {
    const { client } = await setup("servers");
    await press("Sunucu ekle");
    expect(Array.from(field("Anahtar").options).map((o) => o.textContent)).toEqual(["Yok", "id_ed25519", "id_rsa"]);
    change("Ad", "Yeni sunucu");
    change("Adres", "  example.com ");
    change("Kullanıcı", "ubuntu");
    change("Port", "22");
    change("Anahtar", "id_rsa");
    await press("Kaydet");
    expect(client.callsOf("sshHosts.create")).toEqual([
      { name: "Yeni sunucu", hostname: "example.com", user: "ubuntu", port: 22, identityFile: "id_rsa" },
    ]);
    expect(within(panel()).getByText("Yeni sunucu")).toBeTruthy();
  });

  it("omits empty optional fields on create", async () => {
    const { client } = await setup("servers");
    await press("Sunucu ekle");
    change("Ad", "S");
    change("Adres", "h.example");
    await press("Kaydet");
    expect(client.callsOf("sshHosts.create")).toEqual([{ name: "S", hostname: "h.example" }]);
  });

  it("validates like the protocol: no leading '-', no spaces, port range", async () => {
    const { client } = await setup("servers");
    await press("Sunucu ekle");
    change("Ad", "S");
    change("Adres", "-oProxyCommand=x");
    change("Kullanıcı", "a b");
    change("Port", "70000");
    await press("Kaydet");
    expect(within(panel()).getByText("'-' ile başlayamaz.")).toBeTruthy();
    expect(within(panel()).getByText("Boşluk içeremez.")).toBeTruthy();
    expect(within(panel()).getByText("Port 1–65535 arasında bir sayı olmalı.")).toBeTruthy();
    change("Adres", "a;rm");
    change("Kullanıcı", "");
    change("Port", "");
    await press("Kaydet");
    expect(within(panel()).getByText("Geçersiz karakter.")).toBeTruthy();
    expect(client.callsOf("sshHosts.create")).toHaveLength(0);
  });

  it("edit sends null for cleared optional fields; engine errors verbatim", async () => {
    const client = seed();
    client.fail("sshHosts.update", "INVALID", "Anahtar dosyası yok");
    await setup("servers", client);
    await press("Düzenle: yapı");
    expect(field("Adres").value).toBe("10.0.0.5");
    expect(field("Anahtar").value).toBe("id_ed25519");
    change("Kullanıcı", "");
    change("Port", "");
    change("Anahtar", "");
    await press("Kaydet");
    expect(client.callsOf("sshHosts.update")).toEqual([
      { hostId: "h1", name: "yapı", hostname: "10.0.0.5", user: null, port: null, identityFile: null },
    ]);
    expect(alertText()).toBe("Anahtar dosyası yok");
  });

  it("delete with confirmation", async () => {
    const { client } = await setup("servers");
    await press("Sil: yapı");
    await press("Silmeyi onayla");
    expect(client.callsOf("sshHosts.delete")).toEqual([{ hostId: "h1" }]);
    expect(within(panel()).queryByText("yapı")).toBeNull();
  });

  it("sshHosts.changed reloads the list", async () => {
    const { client } = await setup("servers");
    client.hosts.push(makeHost("h9", "dışarıdan"));
    act(() => client.emitEvent({ type: "event", name: "sshHosts.changed" }));
    await flush();
    expect(within(panel()).getByText("dışarıdan")).toBeTruthy();
  });
});

describe("Settings: Araçlar", () => {
  const row = (name: string) => within(panel()).getAllByRole("listitem").find((i) => within(i).queryByText(name))!;

  it("shows each tool's status and re-checks on demand", async () => {
    const { client } = await setup("tools");
    expect(within(row("Birinci")).getByText("kurulu")).toBeTruthy();
    expect(within(row("İkinci")).getByText("kurulu değil")).toBeTruthy();
    expect(within(row("Üçüncü")).getByText("kontrol yok")).toBeTruthy();
    client.toolStatuses = [{ toolId: "t1", installed: false }];
    await press("Yeniden kontrol et");
    expect(client.callsOf("tools.check")).toHaveLength(2);
    expect(within(row("Birinci")).getByText("kurulu değil")).toBeTruthy();
  });

  it("'Kur' only for a missing tool with an install command; installs and reports the terminal", async () => {
    const { client, onInstalled } = await setup("tools");
    expect(within(row("Birinci")).queryByRole("button", { name: /^Kur/ })).toBeNull();
    expect(within(row("Üçüncü")).queryByRole("button", { name: /^Kur/ })).toBeNull();
    fireEvent.click(within(row("İkinci")).getByRole("button", { name: "Kur: İkinci" }));
    await flush();
    expect(client.callsOf("tools.install")).toEqual([{ toolId: "t2", ...defaultUiConfig.fallbackDims }]);
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(onInstalled.mock.calls[0]![0]).toMatchObject({ projectId: "home", command: "kur-2" });
  });

  it("install errors are shown verbatim and do not leave settings", async () => {
    const client = seed();
    client.fail("tools.install", "INTERNAL", "Kurulum başlatılamadı");
    const { onInstalled } = await setup("tools", client);
    fireEvent.click(within(row("İkinci")).getByRole("button", { name: "Kur: İkinci" }));
    await flush();
    expect(alertText()).toBe("Kurulum başlatılamadı");
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it("creates, edits (null clears) and deletes tools", async () => {
    const { client } = await setup("tools");
    await press("Araç ekle");
    change("Ad", "Yeni araç");
    await press("Kaydet");
    expect(within(panel()).getByText("Komut gerekli.")).toBeTruthy();
    change("Komut", "  yeni --hızlı ");
    change("Kontrol komutu", "command -v yeni");
    await press("Kaydet");
    expect(client.callsOf("tools.create")).toEqual([
      { name: "Yeni araç", command: "yeni --hızlı", checkCommand: "command -v yeni" },
    ]);
    await press("Düzenle: Birinci");
    expect(field("Kurulum komutu").value).toBe("kur-1");
    change("Kurulum komutu", "");
    await press("Kaydet");
    expect(client.callsOf("tools.update")).toEqual([
      { toolId: "t1", name: "Birinci", command: "t1-komutu", installCommand: null, checkCommand: "kontrol-1" },
    ]);
    await press("Sil: Üçüncü");
    await press("Silmeyi onayla");
    expect(client.callsOf("tools.delete")).toEqual([{ toolId: "t3" }]);
    expect(within(panel()).queryByText("Üçüncü")).toBeNull();
  });

  it("'Varsayılan araç' at the top: Yalnız kabuk + every tool, current value, hint", async () => {
    const client = seed();
    client.settings = { defaultToolId: "t2" };
    await setup("tools", client);
    const select = field("Varsayılan araç");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Yalnız kabuk", "Birinci", "İkinci", "Üçüncü"]);
    expect(select.value).toBe("t2");
    expect(within(panel()).getByText("Projede araç seçilmemişse yeni terminal bununla açılır.")).toBeTruthy();
    // Above the tool list.
    const list = within(panel()).getByRole("list");
    expect(select.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("changing the default saves it; 'Yalnız kabuk' sends null", async () => {
    const { client } = await setup("tools");
    expect(field("Varsayılan araç").value).toBe("");
    change("Varsayılan araç", "t3");
    await flush();
    change("Varsayılan araç", "");
    await flush();
    expect(client.callsOf("settings.update")).toEqual([{ defaultToolId: "t3" }, { defaultToolId: null }]);
    expect(client.settings).toEqual({});
    expect(field("Varsayılan araç").value).toBe("");
  });

  it("a failed save shows the engine message verbatim and keeps the saved value", async () => {
    const client = seed();
    client.settings = { defaultToolId: "t1" };
    client.fail("settings.update", "NOT_FOUND", "araç bulunamadı");
    await setup("tools", client);
    change("Varsayılan araç", "t2");
    await flush();
    expect(alertText()).toBe("araç bulunamadı");
    expect(field("Varsayılan araç").value).toBe("t1");
  });

  it("settings.changed reloads the default", async () => {
    const { client } = await setup("tools");
    client.settings = { defaultToolId: "t3" };
    act(() => client.emitEvent({ type: "event", name: "settings.changed" }));
    await flush();
    expect(field("Varsayılan araç").value).toBe("t3");
  });

  it("deleting the global default shows the engine's refusal verbatim", async () => {
    const client = seed();
    client.settings = { defaultToolId: "t3" };
    client.fail("tools.delete", "INVALID", "bu araç genel varsayılan araç");
    await setup("tools", client);
    await press("Sil: Üçüncü");
    await press("Silmeyi onayla");
    expect(alertText()).toBe("bu araç genel varsayılan araç");
    expect(within(panel()).getByRole("heading", { name: "Üçüncü" })).toBeTruthy();
  });

  it("tools.changed reloads the list and statuses", async () => {
    const { client } = await setup("tools");
    client.tools.push(makeTool("t9", "Dışarıdan"));
    act(() => client.emitEvent({ type: "event", name: "tools.changed" }));
    await flush();
    expect(within(panel()).getByRole("heading", { name: "Dışarıdan" })).toBeTruthy();
    expect(client.callsOf("tools.check")).toHaveLength(2);
  });
});
