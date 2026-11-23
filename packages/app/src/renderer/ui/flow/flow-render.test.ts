// İş W — Akış: the Mermaid settings that keep a diagram from running anything, and the image URL.
import { describe, expect, it } from "vitest";
import { defaultFlowUiConfig } from "./flow-config.ts";
import { MERMAID_SECURE_KEYS, mermaidSettings, svgDataUrl } from "./flow-render.ts";

describe("flow-render", () => {
  it("runs Mermaid strict, without HTML labels, and never starts on load", () => {
    const s = mermaidSettings(defaultFlowUiConfig);
    expect(s.securityLevel).toBe("strict");
    expect(s.htmlLabels).toBe(false);
    expect(s.flowchart.htmlLabels).toBe(false);
    expect(s.startOnLoad).toBe(false);
    expect(s.suppressErrorRendering).toBe(true);
    expect(s.maxTextSize).toBe(defaultFlowUiConfig.mermaidMaxTextSize);
  });

  it("a diagram's %%{init}%% directive cannot change the security settings", () => {
    const s = mermaidSettings(defaultFlowUiConfig);
    for (const key of ["securityLevel", "htmlLabels", "dompurifyConfig", "secure", "maxTextSize", "startOnLoad"]) {
      expect(s.secure).toContain(key);
    }
    expect(MERMAID_SECURE_KEYS).toContain("securityLevel");
  });

  it("wraps the SVG in a data: image URL with every special character escaped", () => {
    const url = svgDataUrl(`<svg a="1"># %</svg>`);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(url.slice(url.indexOf(",") + 1)).not.toMatch(/[<>"# ]/);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(`<svg a="1"># %</svg>`);
  });
});
