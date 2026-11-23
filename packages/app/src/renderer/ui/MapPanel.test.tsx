// İş C — Harita paneli.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapInfo } from "@kokpit/shared";
import { MapPanel } from "./MapPanel.tsx";
import { FAKE_MAP_UPDATE_COMMAND, FakeEngineClient, makeProject } from "./test-utils/fake-client.ts";

const ENGINE = "ws://127.0.0.1:7420";
const TOKEN_A = "/map/aaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "/map/bbbbbbbbbbbbbbbbbbbbbbbb";
const flush = () => act(async () => {});
const project = makeProject("p1", "Alfa");

const AVAILABLE: MapInfo = {
  available: true,
  file: "graphify-out/graph.html",
  generatedAt: "2026-11-12T10:00:00.000Z",
  updateCommand: FAKE_MAP_UPDATE_COMMAND,
};

function withMap(info: MapInfo = AVAILABLE, tokens = [TOKEN_A, TOKEN_B]) {
  const client = new FakeEngineClient({ projects: [project] });
  client.respond("map.info", () => info);
  let i = 0;
  client.respond("map.token", () => ({ path: tokens[Math.min(i++, tokens.length - 1)]!, expiresAt: "2026-11-16T00:00:00.000Z" }));
  return client;
}

async function setup(client: FakeEngineClient, onUpdate = vi.fn(async () => {})) {
  const utils = render(<MapPanel client={client} project={project} engineUrl={ENGINE} onUpdate={onUpdate} />);
  await flush();
  return { onUpdate, ...utils };
}

const frame = () => screen.queryByTitle("Harita") as HTMLIFrameElement | null;

afterEach(cleanup);

describe("MapPanel", () => {
  it("shows the map in a sandboxed iframe on the engine's http origin", async () => {
    const client = withMap();
    await setup(client);
    const f = frame()!;
    expect(f.getAttribute("src")).toBe(`http://127.0.0.1:7420${TOKEN_A}`);
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(client.callsOf("map.info")).toEqual([{ projectId: "p1" }]);
    expect(client.callsOf("map.token")).toEqual([{ projectId: "p1" }]);
  });

  it("explains what to do when there is no map", async () => {
    await setup(new FakeEngineClient({ projects: [project] }));
    expect(frame()).toBeNull();
    expect(screen.getByText(/henüz harita yok/)).toBeTruthy();
    expect(screen.getByText(FAKE_MAP_UPDATE_COMMAND)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Haritayı güncelle" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tam ekran" })).toBeNull();
  });

  it("'Haritayı güncelle' opens a terminal with the engine's command", async () => {
    const { onUpdate } = await setup(withMap());
    fireEvent.click(screen.getByRole("button", { name: "Haritayı güncelle" }));
    await flush();
    expect(onUpdate).toHaveBeenCalledWith(FAKE_MAP_UPDATE_COMMAND);
  });

  it("shows an update failure", async () => {
    await setup(withMap(), vi.fn(async () => Promise.reject(new Error("açılamadı"))));
    fireEvent.click(screen.getByRole("button", { name: "Haritayı güncelle" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/açılamadı/);
  });

  it("toggles full screen, Escape leaves it", async () => {
    const { container } = await setup(withMap());
    const panel = () => container.querySelector("section.kp-map")!;
    fireEvent.click(screen.getByRole("button", { name: "Tam ekran" }));
    expect(panel().classList.contains("kp-map--full")).toBe(true);
    expect(screen.getByRole("button", { name: "Tam ekrandan çık" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel().classList.contains("kp-map--full")).toBe(false);
  });

  it("reloads with a fresh token when the map changes after a project terminal event", async () => {
    const client = withMap();
    await setup(client);
    // Unchanged map: no new token (the iframe keeps its document).
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1" }));
    await flush();
    expect(client.callsOf("map.token")).toHaveLength(1);
    client.respond("map.info", () => ({ ...AVAILABLE, generatedAt: "2026-11-13T10:00:00.000Z" }));
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "other" }));
    await flush();
    expect(client.callsOf("map.info")).toHaveLength(2);
    act(() => client.emitEvent({ type: "event", name: "terminals.changed", projectId: "p1" }));
    await flush();
    expect(client.callsOf("map.token")).toHaveLength(2);
    expect(frame()!.getAttribute("src")).toBe(`http://127.0.0.1:7420${TOKEN_B}`);
  });

  it("never frames a path the engine should not have sent", async () => {
    await setup(withMap(AVAILABLE, ["https://evil.example/x"]));
    expect(frame()).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/Harita/);
  });

  it("shows a token error", async () => {
    const client = withMap();
    client.fail("map.token", "INVALID", "Harita dosyası gösterilemeyecek kadar büyük");
    await setup(client);
    expect(frame()).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/büyük/);
  });
});
