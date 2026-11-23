import type { MessageKey } from "../../../i18n/index.ts";

export type SettingsTab = "projects" | "servers" | "tools" | "claude" | "sites" | "connection" | "language";

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: MessageKey }> = [
  { id: "projects", label: "settings.tabs.projects" },
  { id: "servers", label: "settings.tabs.servers" },
  { id: "tools", label: "settings.tabs.tools" },
  { id: "claude", label: "settings.tabs.claude" }, // İş H
  // İş M
  { id: "sites", label: "settings.tabs.sites" },
  { id: "connection", label: "settings.tabs.connection" },
  // i18n
  { id: "language", label: "settings.tabs.language" },
];
