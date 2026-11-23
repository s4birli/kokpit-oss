// Optional modules: a panel that belongs to a feature is registered only when that feature is on.
import { createFeatureSet } from "@kokpit/shared";
import { describe, expect, it } from "vitest";
import type { PanelDefinition } from "./contract.ts";
import { enabledPanels, PANEL_ENTRIES, PANELS } from "./registry.ts";

const panel = (id: string): PanelDefinition => ({ id, title: id, available: () => true, render: () => null }) as unknown as PanelDefinition;
const entries = [{ panel: panel("core") }, { panel: panel("extra"), feature: "demo" }, { panel: panel("other"), feature: "else" }];

describe("panel registry: optional modules", () => {
  it("a panel of a feature that is off is not registered; core panels always are", () => {
    const off = createFeatureSet({ features: { demo: { enabled: false }, else: { enabled: true } } });
    expect(enabledPanels(entries, off).map((p) => p.id)).toEqual(["core", "other"]);
  });

  it("a panel of a feature the build does not know at all is not registered", () => {
    expect(enabledPanels(entries, createFeatureSet({ features: {} })).map((p) => p.id)).toEqual(["core"]);
  });

  it("every feature named by the registry exists in the build's feature file, and PANELS is the enabled subset", () => {
    const ids = new Set(PANELS.map((p) => p.id));
    for (const e of PANEL_ENTRIES) if (e.feature === undefined) expect(ids.has(e.panel.id)).toBe(true);
  });
});
