import type { Project } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import { makeCard, makeProject, makeSshProject } from "../test-utils/fake-client.ts";
import { defaultLayoutConfig } from "./config.ts";
import type { PanelId } from "./contract.ts";
import { layoutKindOf } from "./kinds.ts";
import { panelById, PANELS } from "./registry.ts";

const ALL: PanelId[] = ["terminals", "browser", "files", "agents", "map", "flow" /* İş W */, "claude", "web"];
const local = makeProject("p");
const ssh = makeSshProject("s", "S", "h1");
const card = makeCard("c", "p");

const avail = (id: PanelId, project: Project | null, withCard = false) =>
  panelById(PANELS, id)!.available({ project, card: withCard ? card : null });

describe("panel registry", () => {
  it("has exactly one definition per PanelId, in Görünüm order with Turkish titles", () => {
    expect(PANELS.map((p) => p.id).sort()).toEqual([...ALL].sort());
    expect(PANELS.map((p) => p.title)).toEqual(["Dosyalar", "Tarayıcı", "Terminal", "Ajanlar", "Harita", "Akış", "Claude", "Web"]);
  });

  it("every panel has a default placement and the default layouts only use known panels", () => {
    for (const id of ALL) expect(defaultLayoutConfig.placement[id]).toBeDefined();
    const used = Object.values(defaultLayoutConfig.defaults).flatMap((d) => d.panels.map((p) => p.id));
    for (const id of used) expect(ALL).toContain(id);
    expect(defaultLayoutConfig.defaults.normal.panels.map((p) => p.id)).toEqual(["files", "browser", "agents", "terminals"]);
  });

  it("Harita: project view only, never ssh", () => {
    expect(avail("map", local)).toBe(true);
    expect(avail("map", local, true)).toBe(false);
    expect(avail("map", ssh)).toBe(false);
    expect(avail("map", null)).toBe(false);
  });

  it("Akış (İş W): any project (SSH shows a note), hidden by default", () => {
    expect(avail("flow", local)).toBe(true);
    expect(avail("flow", local, true)).toBe(true);
    expect(avail("flow", ssh)).toBe(true);
    expect(avail("flow", null)).toBe(false);
    expect(defaultLayoutConfig.defaults.normal.panels.map((p) => p.id)).not.toContain("flow");
  });


  it("İş M — Web: every selection, one state shared by all of them, opened as a tab next to Tarayıcı", () => {
    for (const p of [local, ssh, null]) expect(avail("web", p)).toBe(true);
    expect(avail("web", local, true)).toBe(true);
    expect(panelById(PANELS, "web")!.stateScope).toBe("global");
    expect(defaultLayoutConfig.placement.web).toEqual({ near: ["browser", "files"], direction: "within" });
    // Not in the default layouts: it appears on the first launch (Ana sayfa) or from the Git menu.
    expect(Object.values(defaultLayoutConfig.defaults).flatMap((d) => d.panels.map((p) => p.id))).not.toContain("web");
  });

  it("Claude: hidden by default, normal projects only, usable without a selection (Rehber)", () => {
    for (const d of Object.values(defaultLayoutConfig.defaults)) expect(d.panels.map((p) => p.id)).not.toContain("claude");
    expect(defaultLayoutConfig.kindPanels.normal).toContain("claude");
    expect(avail("claude", null)).toBe(true);
    expect(avail("claude", local)).toBe(true);
    expect(avail("claude", ssh)).toBe(true);
  });

  it("Tarayıcı and Dosyalar need a project; Terminal and Ajanlar also work without one", () => {
    expect(avail("browser", null)).toBe(false);
    expect(avail("files", null)).toBe(false);
    expect(avail("browser", ssh)).toBe(true);
    for (const id of ["terminals", "agents"] as const) expect(avail(id, null)).toBe(true);
  });
});
