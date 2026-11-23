import type { TerminalInfo } from "@kokpit/shared";
import { useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { EngineClient } from "../../engine/types.ts";
import { defaultUiConfig, type UiConfig } from "../config.ts";
import { ClaudeAccountsTab } from "./ClaudeAccountsTab.tsx";
import { ProjectsTab } from "./ProjectsTab.tsx";
import { ServersTab } from "./ServersTab.tsx";
import { SitesTab } from "./SitesTab.tsx";
import { SETTINGS_TABS, type SettingsTab } from "./tabs.ts";
import { ToolsTab } from "./ToolsTab.tsx";
import { LanguageTab } from "./LanguageTab.tsx";
import { useT } from "../../../i18n/index.ts";
import "../theme.css";
import "../workbench.css";
import "./settings.css";

export interface SettingsProps {
  client: EngineClient;
  tab: SettingsTab;
  onTabChange(tab: SettingsTab): void;
  onBack(): void;
  /** "Kur" (or İş H "Giriş yap") opened a terminal; the caller closes settings and shows it. */
  onInstalled(terminal: TerminalInfo): void;
  /** Content of the "Bağlantı" tab (the connect form, owned by the app shell). */
  connection: ReactNode;
  config?: Partial<UiConfig>;
}

export function Settings({ client, tab, onTabChange, onBack, onInstalled, connection, config }: SettingsProps) {
  const uiConfig = useMemo<UiConfig>(() => ({ ...defaultUiConfig, ...config }), [config]);
  const tr = useT();
  const id = useId();
  const tabRefs = useRef(new Map<SettingsTab, HTMLButtonElement>());

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const i = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    let next: number | null = step === 0 ? null : (i + step + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = SETTINGS_TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = SETTINGS_TABS[next]!.id;
    onTabChange(target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    <div className="kp-root">
      <main className="kp-settings" aria-labelledby={`${id}-title`}>
        <header className="kp-settings__head">
          <button type="button" className="kp-btn" onClick={onBack}>
            {tr("settings.header.back")}
          </button>
          <h1 id={`${id}-title`} className="kp-settings__title">
            {tr("settings.header.title")}
          </h1>
        </header>
        <div role="tablist" aria-label={tr("settings.header.title")} className="kp-settings-tabs">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el);
                else tabRefs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${id}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              className="kp-settings-tabs__tab"
              onClick={() => onTabChange(t.id)}
              onKeyDown={onKeyDown}
            >
              {tr(t.label)}
            </button>
          ))}
        </div>
        <section role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="kp-settings__panel">
          {tab === "projects" && <ProjectsTab client={client} config={uiConfig} />}
          {tab === "servers" && <ServersTab client={client} />}
          {tab === "tools" && <ToolsTab client={client} config={uiConfig} onInstalled={onInstalled} />}
          {tab === "claude" && <ClaudeAccountsTab client={client} config={uiConfig} onLogin={onInstalled} />}
          {tab === "sites" && <SitesTab />}
          {tab === "connection" && connection}
          {tab === "language" && <LanguageTab />}
        </section>
      </main>
    </div>
  );
}
