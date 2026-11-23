// İş B: "Tarayıcı nerede açılsın" in the project forms, with the profile security note.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Project } from "@kokpit/shared";
import { afterEach, describe, expect, it } from "vitest";
import { defaultUiConfig } from "../config.ts";
import { FakeEngineClient, makeProject } from "../test-utils/fake-client.ts";
import { Settings } from "./Settings.tsx";

const flush = () => act(async () => {});
const machine = defaultUiConfig.machineName;
const OPEN_IN_BROWSER_LABEL = "Terminaldeki open komutu bu tarayıcıda açsın";
const AGENTS_LABEL = "Arka plan ajanları da bu tarayıcıyı kullansın";
const NOTE = "Ajan bu profildeki şifre yöneticisine ve açık oturumlara erişebilir.";

async function setup(first: Partial<Project> = {}) {
  const client = new FakeEngineClient({
    projects: [makeProject("p1", "Alfa", first), makeProject("p2", "Beta", { browser: { runOn: "client" } })],
  });
  render(
    <Settings client={client} tab="projects" onTabChange={() => {}} onBack={() => {}} onInstalled={() => {}} connection={null} />,
  );
  await flush();
  return client;
}

const panel = () => screen.getByRole("tabpanel");
const field = (label: string) => within(panel()).getByLabelText(label) as HTMLSelectElement & HTMLInputElement;
async function press(name: string) {
  fireEvent.click(within(panel()).getByRole("button", { name }));
  await flush();
}

afterEach(cleanup);

describe("Projeler: tarayıcı", () => {
  it("create: defaults to the engine machine (sends nothing extra); 'Bu bilgisayar' sends runOn client", async () => {
    const client = await setup();
    await press("Proje ekle");
    const select = field("Tarayıcı nerede açılsın");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([machine, "Bu bilgisayar"]);
    expect(within(panel()).getByText(NOTE)).toBeTruthy();
    fireEvent.change(field("Ad"), { target: { value: "Yeni" } });
    fireEvent.change(field("Klasör yolu"), { target: { value: "/x" } });
    fireEvent.change(select, { target: { value: "client" } });
    await press("Kaydet");
    expect(client.callsOf("projects.create")).toEqual([{ name: "Yeni", location: { kind: "local", path: "/x" }, browser: { runOn: "client" } }]);
  });

  it("edit: shows the current choice and sends a change only when it changed", async () => {
    const client = await setup();
    await press("Düzenle: Beta");
    expect(field("Tarayıcı nerede açılsın").value).toBe("client");
    expect(within(panel()).getByText(NOTE)).toBeTruthy();
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).not.toHaveProperty("browser");
    await press("Düzenle: Beta");
    fireEvent.change(field("Tarayıcı nerede açılsın"), { target: { value: "engine" } });
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ projectId: "p2", browser: { runOn: "engine" } });
  });

  // Adım 9 İş A
  it("edit: \"Arka plan ajanları da bu tarayıcıyı kullansın\" is on by default and sent only when changed", async () => {
    const client = await setup();
    await press("Düzenle: Alfa");
    const select = field(AGENTS_LABEL);
    expect(select.value).toBe("on");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Evet", "Hayır"]);
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).not.toHaveProperty("claudeBrowserEnv");
    await press("Düzenle: Alfa");
    fireEvent.change(field(AGENTS_LABEL), { target: { value: "off" } });
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ projectId: "p1", claudeBrowserEnv: false });
  });

  it("edit: a project that has it off shows so; the field is hidden when the browser opens on this computer", async () => {
    const client = await setup({ claudeBrowserEnv: false });
    await press("Düzenle: Alfa");
    expect(field(AGENTS_LABEL).value).toBe("off");
    fireEvent.change(field(AGENTS_LABEL), { target: { value: "on" } });
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ claudeBrowserEnv: true });
    await press("Düzenle: Beta");
    expect(within(panel()).queryByLabelText(AGENTS_LABEL)).toBeNull();
  });

  // Yollar
  it("edit: “Terminaldeki open komutu bu tarayıcıda açsın” is on by default, sent only when changed, hidden for a browser on this computer", async () => {
    const client = await setup();
    await press("Düzenle: Alfa");
    expect(field(OPEN_IN_BROWSER_LABEL).value).toBe("on");
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).not.toHaveProperty("openInBrowser");
    await press("Düzenle: Alfa");
    fireEvent.change(field(OPEN_IN_BROWSER_LABEL), { target: { value: "off" } });
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ projectId: "p1", openInBrowser: false });
    await press("Düzenle: Alfa");
    expect(field(OPEN_IN_BROWSER_LABEL).value).toBe("off");
    fireEvent.change(field(OPEN_IN_BROWSER_LABEL), { target: { value: "on" } });
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ openInBrowser: true });
    await press("Düzenle: Beta");
    expect(within(panel()).queryByLabelText(OPEN_IN_BROWSER_LABEL)).toBeNull();
  });

  // Gizli tarayıcı
  it(`edit: "<machine> ekranında göster" is off (hidden) by default, sent with runOn only when changed, hidden for a browser on this computer`, async () => {
    const label = `${machine} ekranında göster`;
    const client = await setup();
    await press("Düzenle: Alfa");
    const select = field(label);
    expect(select.value).toBe("hidden");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Hayır (gizli)", "Evet"]);
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).not.toHaveProperty("browser");
    await press("Düzenle: Alfa");
    fireEvent.change(field(label), { target: { value: "visible" } });
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ projectId: "p1", browser: { runOn: "engine", window: "visible" } });
    await press("Düzenle: Alfa");
    expect(field(label).value).toBe("visible");
    fireEvent.change(field(label), { target: { value: "hidden" } });
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ browser: { runOn: "engine", window: "hidden" } });
    await press("Düzenle: Beta");
    expect(within(panel()).queryByLabelText(label)).toBeNull();
  });

  it("the list says where each project's browser opens", async () => {
    await setup();
    const items = within(panel()).getAllByRole("listitem");
    expect(within(items[0]!).getByText(`Tarayıcı: ${machine}`)).toBeTruthy();
    expect(within(items[1]!).getByText("Tarayıcı: Bu bilgisayar")).toBeTruthy();
  });
});
