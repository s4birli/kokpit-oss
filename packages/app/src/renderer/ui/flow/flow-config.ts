// İş W — Akış: tunables of the Akış panel and its Mermaid renderer. Overridable through FlowPanel's `config` prop.

export interface FlowUiConfig {
  /** How often the flow list is re-read while the panel is open (0 = only on connect / terminal changes). */
  pollMs: number;
  /** Zoom bounds and the step of one Yakınlaştır / Uzaklaştır press (1 = natural size). */
  zoomMin: number;
  zoomMax: number;
  zoomStep: number;
  /** Mermaid theme matching the app's dark palette. */
  mermaidTheme: "dark" | "default" | "neutral" | "forest" | "base";
  /** Largest diagram text Mermaid accepts (characters); larger ones fail with an error instead of hanging. */
  mermaidMaxTextSize: number;
  /** Most edges Mermaid draws in one diagram. */
  mermaidMaxEdges: number;
}

export const defaultFlowUiConfig: FlowUiConfig = {
  pollMs: 5_000,
  zoomMin: 0.25,
  zoomMax: 4,
  zoomStep: 0.25,
  mermaidTheme: "dark",
  mermaidMaxTextSize: 131_072,
  mermaidMaxEdges: 2_000,
};
