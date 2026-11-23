// Adım 7 İş B: the Tarayıcı panel for the modular layout. BrowserPanel shows the project's Chrome with its tabs
// as a tab strip; this definition wires it to the layout host and keeps the active tab in the panel's state.
import type { PanelContext, PanelDefinition } from "../layout/contract.ts";
import { BrowserPanel } from "../BrowserPanel.tsx";
import { bridgeOpenLocal } from "../browser-bridge.ts";
import { t, useT } from "../../../i18n/index.ts";

function BrowserTabsPanel({ ctx }: { ctx: PanelContext }) {
  const tr = useT();
  const { project } = ctx;
  if (!project) {
    return (
      <section className="kp-panel kp-browser" aria-label={tr("browser.panel.title")}>
        <p className="kp-browser__note">{tr("browser.panel.pickProject")}</p>
      </section>
    );
  }
  return (
    <BrowserPanel
      // A different project is a different Chrome: start fresh (screencast, restore of the active tab).
      key={project.id}
      client={ctx.client}
      project={project}
      config={ctx.config}
      openLocal={bridgeOpenLocal()}
      tabState={ctx.state}
    />
  );
}

export const browserPanel: PanelDefinition = {
  id: "browser",
  get title() {
    return t("browser.panel.title");
  },
  available: ({ project }) => project !== null,
  render: (ctx) => <BrowserTabsPanel ctx={ctx} />,
};
