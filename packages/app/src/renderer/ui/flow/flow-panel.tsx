// İş W — Akış: the dockable panel definition (registry.ts imports `flowPanel`).
import { useContext } from "react";
import { t } from "../../../i18n/index.ts";
import type { PanelContext, PanelDefinition } from "../layout/contract.ts";
import { isAppOnlyProject } from "../layout/kinds.ts";
import { LegacyPanelsContext } from "../layout/legacy-panels.tsx";
import { FlowPanel } from "./FlowPanel.tsx";
import { defaultFlowUiConfig } from "./flow-config.ts";
import { createMermaidRenderer, type FlowRenderer } from "./flow-render.ts";

/** One Mermaid instance for the whole app (Mermaid's state is global), created on first use. */
let sharedRenderer: FlowRenderer | null = null;
const renderer = (): FlowRenderer => (sharedRenderer ??= createMermaidRenderer(defaultFlowUiConfig));

function FlowPanelHost({ ctx }: { ctx: PanelContext }) {
  const legacy = useContext(LegacyPanelsContext);
  const project = ctx.project!;
  const card = ctx.card;
  return (
    <FlowPanel
      key={card ? `c:${card.id}` : `p:${project.id}`}
      client={ctx.client}
      config={defaultFlowUiConfig}
      project={project}
      card={card}
      state={ctx.state}
      renderer={renderer()}
      onUpdate={async (command) => {
        if (!legacy) throw new Error(t("flow.terminalUnavailable"));
        const terminal = await legacy.openTerminal(card ? { cardId: card.id } : { projectId: project.id }, { command });
        ctx.reveal("terminals", { terminalId: terminal.id });
      }}
    />
  );
}

// SSH projects get the panel with a note (no button); app-only projects have their own layout without it.
export const flowPanel: PanelDefinition = {
  id: "flow",
  get title() {
    return t("flow.title");
  },
  available: ({ project }) => project !== null && !isAppOnlyProject(project),
  render: (ctx) => <FlowPanelHost ctx={ctx} />,
};
