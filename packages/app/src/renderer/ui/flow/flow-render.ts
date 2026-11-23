// İş W — Akış: turning a project's Mermaid text into an SVG the panel can show safely.
//
// Isolation, in layers:
//  1. Mermaid runs with `securityLevel: "strict"`: labels are sanitised (DOMPurify), `click` callbacks and
//     `javascript:` links are dropped. `secure` lists the keys a diagram's own `%%{init: …}%%` directive may not
//     change, so a .mmd file cannot switch itself to "loose", turn HTML labels back on or loosen DOMPurify.
//  2. HTML labels are off: every label is plain SVG text, no foreignObject HTML.
//  3. The panel never inserts the SVG markup into the page: it becomes the `src` of an <img> (data: URL). An image
//     document runs no scripts, follows no links, loads nothing external and cannot reach window.kokpit.
//  4. The page's CSP (no inline script, no 'unsafe-eval', connect-src ws: only) stands behind all of that.
import type { FlowUiConfig } from "./flow-config.ts";

export interface FlowRenderer {
  /** SVG markup of the diagram; rejects with Mermaid's error for text it cannot draw. */
  render(text: string): Promise<string>;
}

/** Keys a diagram's `%%{init}%%` directive may never override (Mermaid's defaults plus ours). */
export const MERMAID_SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "htmlLabels",
  "dompurifyConfig",
] as const;

export function mermaidSettings(cfg: FlowUiConfig) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    secure: [...MERMAID_SECURE_KEYS],
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: cfg.mermaidTheme,
    maxTextSize: cfg.mermaidMaxTextSize,
    maxEdges: cfg.mermaidMaxEdges,
    suppressErrorRendering: true,
  };
}

const SVG_DATA_PREFIX = "data:image/svg+xml;charset=utf-8,";

/** The SVG as an image URL: shown only through <img>, never as markup in the page. */
export function svgDataUrl(svg: string): string {
  return SVG_DATA_PREFIX + encodeURIComponent(svg);
}

type Mermaid = (typeof import("mermaid"))["default"];

/**
 * The real renderer: Mermaid is loaded on first use (it is large) and initialised once. Renders run one at a
 * time, since Mermaid keeps global state while drawing.
 */
export function createMermaidRenderer(cfg: FlowUiConfig): FlowRenderer {
  let loading: Promise<Mermaid> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let seq = 0;

  const load = (): Promise<Mermaid> =>
    (loading ??= import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize(mermaidSettings(cfg));
      return mermaid;
    }));

  return {
    render(text) {
      const run = queue.then(async () => {
        const mermaid = await load();
        const { svg } = await mermaid.render(`kp-flow-svg-${++seq}`, text);
        return svg;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
