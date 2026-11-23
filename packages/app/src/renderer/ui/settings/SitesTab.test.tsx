// İş M — Ayarlar › Siteler: the Git menu's site list, edited and saved through main (which validates again).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSite } from "../../engine/web-ipc.ts";
import { FakeWebBridge, TEST_SITES } from "../test-utils/fake-web.ts";
import { SitesTab } from "./SitesTab.tsx";

const flush = () => act(async () => {});
afterEach(cleanup);

async function setup(bridge = new FakeWebBridge()) {
  render(<SitesTab bridge={bridge.sites} />);
  await flush();
  return bridge;
}

const rows = () => screen.getAllByRole("listitem");
const rowTitles = () => rows().map((r) => (within(r).getByLabelText("Ad") as HTMLInputElement).value);
const addForm = () => screen.getByRole("group", { name: "Site ekle" });

describe("Ayarlar › Siteler (İş M)", () => {
  it("outside Electron it explains itself", () => {
    render(<SitesTab bridge={undefined} />);
    expect(screen.getByText("Siteler yalnız Kokpit uygulamasında düzenlenir.")).toBeTruthy();
  });

  it("lists the sites in Git menu order", async () => {
    await setup();
    expect(rowTitles()).toEqual(["Ana sayfa", "Wiki", "Notlar"]);
  });

  it("adds a site (id from its host), edits one, removes one, moves one up, and saves the list", async () => {
    const bridge = await setup();
    fireEvent.change(within(addForm()).getByLabelText("Ad"), { target: { value: "Grafana" } });
    fireEvent.change(within(addForm()).getByLabelText("Adres"), { target: { value: "https://grafana.example.com/" } });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Ekle" }));
    fireEvent.change(within(rows()[1]!).getByLabelText("Ad"), { target: { value: "Bilgi" } });
    fireEvent.click(screen.getByRole("button", { name: "Sil: Notlar" }));
    fireEvent.click(screen.getByRole("button", { name: "Yukarı: Grafana" }));
    expect(rowTitles()).toEqual(["Ana sayfa", "Grafana", "Bilgi"]);
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await flush();
    expect(bridge.sites.save).toHaveBeenCalledWith([
      TEST_SITES[0],
      { id: "grafana", title: "Grafana", url: "https://grafana.example.com/" },
      { ...TEST_SITES[1], title: "Bilgi" },
    ]);
    expect(screen.getByRole("status").textContent).toBe("Kaydedildi.");
  });

  it("a site deleted and re-added on the same host in one save gets a NEW id (never inherits the old login)", async () => {
    const bridge = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Sil: Notlar" }));
    fireEvent.change(within(addForm()).getByLabelText("Ad"), { target: { value: "Notlar yeni" } });
    fireEvent.change(within(addForm()).getByLabelText("Adres"), { target: { value: "https://notes.example.com/" } });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Ekle" }));
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await flush();
    const savedList = (bridge.sites.save as unknown as { mock: { calls: WebSite[][][] } }).mock.calls[0]![0]!;
    const readded = savedList.find((s) => s.title === "Notlar yeni")!;
    expect(readded.id).not.toBe("notlar");
    // …and after that save, deleting + re-adding again still avoids every id saved so far.
    fireEvent.click(screen.getByRole("button", { name: "Sil: Notlar yeni" }));
    fireEvent.change(within(addForm()).getByLabelText("Ad"), { target: { value: "Notlar 3" } });
    fireEvent.change(within(addForm()).getByLabelText("Adres"), { target: { value: "https://notes.example.com/" } });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Ekle" }));
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await flush();
    const second = (bridge.sites.save as unknown as { mock: { calls: WebSite[][][] } }).mock.calls[1]![0]!;
    expect(["notlar", readded.id]).not.toContain(second.find((s) => s.title === "Notlar 3")!.id);
  });

  it("refuses non-https addresses and empty names before sending", async () => {
    const bridge = await setup();
    fireEvent.change(within(addForm()).getByLabelText("Adres"), { target: { value: "http://x.example.com" } });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Ekle" }));
    expect(within(addForm()).getByText("Ad gerekli.")).toBeTruthy();
    expect(within(addForm()).getByText(/^Http:\/\/ yalnız IP adresiyle yazılan Tailscale\/yerel adresler için kabul edilir/)).toBeTruthy();
    fireEvent.change(within(rows()[0]!).getByLabelText("Adres"), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await flush();
    expect(bridge.sites.save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("https://");
  });

  it.each([
    ["a public address", "http://93.184.216.34:9119/", /yalnız Tailscale ve yerel adresler için/],
    ["a public address written as a number", "http://1681223485/", /yalnız Tailscale ve yerel adresler için/],
    ["a MagicDNS name", "http://homeserver.tail1234.ts.net:9119/", /yalnız IP adresiyle/],
    ["credentials", "http://u:p@100.64.113.61:9119/", /kullanıcı adı ya da parola olamaz/],
    ["another scheme", "ftp://100.64.113.61/", /https:\/\/ ile başlamalı/],
  ])("refuses http to %s with a message that says why", async (_n, url, message) => {
    const bridge = await setup();
    fireEvent.change(within(addForm()).getByLabelText("Ad"), { target: { value: "Pano" } });
    fireEvent.change(within(addForm()).getByLabelText("Adres"), { target: { value: url } });
    fireEvent.click(within(addForm()).getByRole("button", { name: "Ekle" }));
    expect(within(addForm()).getByText(message)).toBeTruthy();
    expect(rowTitles()).toEqual(["Ana sayfa", "Wiki", "Notlar"]);
    expect(bridge.sites.save).not.toHaveBeenCalled();
  });

  it("adds two http sites on one Tailscale address with different ports: different ids, normalized addresses", async () => {
    const bridge = await setup();
    for (const [name, url] of [
      ["NAS panosu", "http://100.64.113.61:9119"],
      ["NAS", " http://100.64.113.61:8787/ "],
    ] as const) {
      fireEvent.change(within(addForm()).getByLabelText("Ad"), { target: { value: name } });
      fireEvent.change(within(addForm()).getByLabelText("Adres"), { target: { value: url } });
      fireEvent.click(within(addForm()).getByRole("button", { name: "Ekle" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await flush();
    expect(bridge.sites.save.mock.calls[0]![0].slice(3)).toEqual([
      { id: "100-64-113-61-9119", title: "NAS panosu", url: "http://100.64.113.61:9119/" },
      { id: "100-64-113-61-8787", title: "NAS", url: "http://100.64.113.61:8787/" },
    ]);
    expect(screen.getByText(/http:\/\/ yalnız\s+Tailscale ya da yerel IP adresleri için kabul edilir/)).toBeTruthy();
  });

  it("editing a saved https site down to http on a public host is refused at Kaydet", async () => {
    const bridge = await setup();
    fireEvent.change(within(rows()[0]!).getByLabelText("Adres"), { target: { value: "http://home.example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await flush();
    expect(bridge.sites.save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("alan adı için https:// gerekir");
  });

  it("marks plain-http sites \"http · Tailscale\" in their row (no extra row); https sites are unmarked", async () => {
    const bridge = new FakeWebBridge([...TEST_SITES, { id: "nas-pano", title: "NAS panosu", url: "http://100.64.113.61:9119/" }, { id: "yerel", title: "Yerel", url: "http://127.0.0.1:3000/" }]);
    await setup(bridge);
    expect(rows()).toHaveLength(5);
    const badge = within(rows()[3]!).getByText("http · Tailscale");
    expect(badge.getAttribute("title")).toMatch(/Düz http \(şifresiz\).*Tailscale açıkken.*tailnet/);
    expect(within(rows()[4]!).getByText("http · yerel")).toBeTruthy();
    for (const i of [0, 1, 2]) expect(within(rows()[i]!).queryByText(/http ·/)).toBeNull();
    // The mark follows the address being edited.
    fireEvent.change(within(rows()[0]!).getByLabelText("Adres"), { target: { value: "http://100.100.100.100/" } });
    expect(within(rows()[0]!).getByText("http · Tailscale")).toBeTruthy();
    fireEvent.change(within(rows()[3]!).getByLabelText("Adres"), { target: { value: "https://nas.tail1234.ts.net/" } });
    expect(within(rows()[3]!).queryByText(/http ·/)).toBeNull();
  });

  it("shows main's refusal verbatim", async () => {
    const bridge = new FakeWebBridge();
    bridge.sites.save.mockRejectedValueOnce(new Error("Diske yazılamadı."));
    await setup(bridge);
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Diske yazılamadı.");
  });

  it("an id stays the same when the address changes (the login partition belongs to the id)", async () => {
    const bridge = await setup();
    fireEvent.change(within(rows()[0]!).getByLabelText("Adres"), { target: { value: "https://start.example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    await flush();
    expect(bridge.sites.save.mock.calls[0]![0][0]).toEqual({ id: "home", title: "Ana sayfa", url: "https://start.example.com/" });
  });
});
