// İş L: the panels that existed before Adım 7, wrapped as PanelDefinitions so everything keeps working inside the
// dock. Each panel's owner replaces its definition with its own module (one line in registry.ts). Until then these
// read workbench data the contract does not carry (tools, cards, agents…) from LegacyPanelsContext.
import type { Card, TerminalInfo, Tool } from "@kokpit/shared";
import { createContext, useContext } from "react";
import { AgentsPanel } from "../AgentsPanel.tsx";
import type { BgAgentsSectionProps } from "../BgAgentsSection.tsx";
import type { TerminalScope } from "../hooks/useTerminals.ts";
import { MapPanel } from "../MapPanel.tsx";
import type { Launch } from "../TerminalLauncher.tsx";
import type { PanelContext, PanelDefinition } from "./contract.ts";
import { isAppOnlyProject } from "./kinds.ts";
import { t, useT } from "../../../i18n/index.ts";

export interface LegacyPanelsData {
  tools: readonly Tool[];
  cardsByProject: Readonly<Record<string, readonly Card[]>>;
  /** Every terminal with its activity (İş A). */
  agents: { terminals: readonly TerminalInfo[]; error: string | null };
  now: number;
  openTerminal(target: TerminalScope, launch: Launch): Promise<TerminalInfo>;
  /** İş A (Adım 7): background sessions for the Ajanlar panel; projectId/now come from the panel. */
  background: Omit<BgAgentsSectionProps, "projectId" | "now">;
}

export const LegacyPanelsContext = createContext<LegacyPanelsData | null>(null);

function useLegacy(): LegacyPanelsData {
  const data = useContext(LegacyPanelsContext);
  if (!data) throw new Error("LegacyPanelsContext missing");
  return data;
}

const notAppOnly = ({ project }: Pick<PanelContext, "project">): boolean => !isAppOnlyProject(project);

function LegacyAgents({ ctx }: { ctx: PanelContext }) {
  const t = useT();
  const { agents, cardsByProject, tools, now, background } = useLegacy();
  const projectId = ctx.project?.id;
  return (
    <AgentsPanel
      terminals={projectId === undefined ? agents.terminals : agents.terminals.filter((t) => t.projectId === projectId)}
      cards={projectId === undefined ? [] : (cardsByProject[projectId] ?? [])}
      tools={tools}
      now={now}
      error={agents.error}
      emptyText={projectId === undefined ? t("workbench.panels.noTerminals") : t("workbench.panels.noProjectTerminals")}
      onSelect={(t) => {
        ctx.select({ projectId: t.projectId, ...(t.cardId !== undefined ? { cardId: t.cardId } : {}) });
        ctx.reveal("terminals", { terminalId: t.id });
      }}
      background={{ ...background, projectId, now }}
    />
  );
}

function LegacyMap({ ctx }: { ctx: PanelContext }) {
  const { openTerminal } = useLegacy();
  const project = ctx.project!;
  return (
    <MapPanel
      key={project.id}
      client={ctx.client}
      project={project}
      engineUrl={ctx.engineUrl}
      onUpdate={async (command) => {
        const terminal = await openTerminal({ projectId: project.id }, { command });
        ctx.reveal("terminals", { terminalId: terminal.id });
      }}
    />
  );
}

export const agentsPanel: PanelDefinition = {
  id: "agents",
  get title() {
    return t("workbench.panels.agents");
  },
  available: notAppOnly,
  render: (ctx) => <LegacyAgents ctx={ctx} />,
};

// İş C — Harita: project view only, never for ssh projects (the map lives on the engine's disk).
export const mapPanel: PanelDefinition = {
  id: "map",
  get title() {
    return t("workbench.panels.map");
  },
  available: ({ project, card }) => project !== null && card === null && project.location.kind !== "ssh" && !isAppOnlyProject(project),
  render: (ctx) => <LegacyMap ctx={ctx} />,
};
