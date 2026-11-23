// İş P: the project form edits the location (same checks as create).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEngineClient, makeHost, makeProject, makeSshProject } from "../test-utils/fake-client.ts";
import { Settings } from "./Settings.tsx";

const flush = () => act(async () => {});

function seed() {
  return new FakeEngineClient({
    projects: [
      makeProject("p1", "Alfa"),
      makeProject("home", "Ev", { builtin: true, location: { kind: "local", path: "/Users/u" } }),
      makeSshProject("p3", "Uzak", "h1", "/srv/app"),
      makeProject("gh", "Depo", { location: { kind: "github", url: "https://github.com/a/b", path: "/data/repos/gh" } }),
    ],
    hosts: [makeHost("h1", "yapı", { hostname: "10.0.0.5" }), makeHost("h2", "ikinci", { hostname: "10.0.0.6" })],
  });
}

async function setup(client = seed()) {
  render(<Settings client={client} tab="projects" onTabChange={() => {}} onBack={() => {}} onInstalled={() => {}} connection={null} />);
  await flush();
  return client;
}

const panel = () => screen.getByRole("tabpanel");
const field = (label: string) => within(panel()).getByLabelText(label) as HTMLInputElement & HTMLSelectElement;
const change = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
async function press(name: string | RegExp) {
  fireEvent.click(within(panel()).getByRole("button", { name }));
  await flush();
}

afterEach(cleanup);

describe("Projeler: konum düzenleme", () => {
  it("edit shows the current location and sends it only when it changed", async () => {
    const client = await setup();
    await press("Düzenle: Alfa");
    expect(within(panel()).queryByText(/değiştirilemez/)).toBeNull();
    expect(field("Klasör yolu").value).toBe("/repos/p1");
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).not.toHaveProperty("location");
    await press("Düzenle: Alfa");
    change("Klasör yolu", "/yeni/yer");
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toEqual({
      projectId: "p1",
      name: "Alfa",
      defaultToolId: null,
      location: { kind: "local", path: "/yeni/yer" },
    });
  });

  it("validates like create: a relative folder is refused before anything is sent", async () => {
    const client = await setup();
    await press("Düzenle: Alfa");
    change("Klasör yolu", "göreli/yol");
    await press("Kaydet");
    expect(within(panel()).getByText("Klasör yolu / ile başlamalı.")).toBeTruthy();
    expect(client.callsOf("projects.update")).toHaveLength(0);
  });

  it("can move a local project onto an SSH server, and an SSH project to another server", async () => {
    const client = await setup();
    await press("Düzenle: Alfa");
    fireEvent.click(within(panel()).getByRole("radio", { name: "SSH sunucusu" }));
    await press("Kaydet");
    expect(within(panel()).getByText("Sunucu seç.")).toBeTruthy();
    change("Sunucu", "h2");
    change("Uzak klasör", "/opt/x");
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ location: { kind: "ssh", hostId: "h2", path: "/opt/x" } });

    await press("Düzenle: Uzak");
    expect(field("Sunucu").value).toBe("h1");
    expect(field("Uzak klasör").value).toBe("/srv/app");
    change("Uzak klasör", "");
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).toMatchObject({ projectId: "p3", location: { kind: "ssh", hostId: "h1" } });
    expect(client.callsOf("projects.update").at(-1)?.location).not.toHaveProperty("path");
  });

  it("shows the engine's refusal verbatim (a project with cards)", async () => {
    const client = seed();
    client.fail("projects.update", "INVALID", "Projenin 1 kartı var. Önce kartları sil.");
    await setup(client);
    await press("Düzenle: Alfa");
    change("Klasör yolu", "/baska");
    await press("Kaydet");
    expect(within(panel()).getByRole("alert").textContent).toBe("Projenin 1 kartı var. Önce kartları sil.");
  });

  it("built-in and GitHub projects keep their location (no location fields, nothing sent)", async () => {
    const client = await setup();
    await press("Düzenle: Ev");
    expect(within(panel()).queryByLabelText("Klasör yolu")).toBeNull();
    expect(within(panel()).getByText(/Yerleşik projenin konumu değiştirilemez/)).toBeTruthy();
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).not.toHaveProperty("location");
    await press("Düzenle: Depo");
    expect(within(panel()).queryByRole("radio")).toBeNull();
    expect(within(panel()).getByText(/GitHub adresi değiştirilemez/)).toBeTruthy();
    await press("Kaydet");
    expect(client.callsOf("projects.update").at(-1)).not.toHaveProperty("location");
  });
});

