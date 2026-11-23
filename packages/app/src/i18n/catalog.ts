// The app's catalogs: one JSON file per area and locale (locales/<locale>/<area>.json), plus the shared catalogs
// (`engine.*`, `validation.*` of @kokpit/shared/i18n). The areas of optional modules are marked with their feature
// below; a build without the module drops their two files and their lines here.
// English is the reference; Turkish must have exactly its keys — a missing one fails typecheck (appTr's type), an
// extra one or a different {placeholder} fails catalog.test.ts.
import { sharedEn, sharedTr, type KeysOf } from "@kokpit/shared/i18n";
import agentsEn from "./locales/en/agents.json" with { type: "json" };
import agentsTr from "./locales/tr/agents.json" with { type: "json" };
import browserEn from "./locales/en/browser.json" with { type: "json" };
import browserTr from "./locales/tr/browser.json" with { type: "json" };
import claudeEn from "./locales/en/claude.json" with { type: "json" };
import claudeTr from "./locales/tr/claude.json" with { type: "json" };
import commonEn from "./locales/en/common.json" with { type: "json" };
import commonTr from "./locales/tr/common.json" with { type: "json" };
import connectEn from "./locales/en/connect.json" with { type: "json" };
import connectTr from "./locales/tr/connect.json" with { type: "json" };
import filesEn from "./locales/en/files.json" with { type: "json" };
import filesTr from "./locales/tr/files.json" with { type: "json" };
import flowEn from "./locales/en/flow.json" with { type: "json" };
import flowTr from "./locales/tr/flow.json" with { type: "json" };
import linksEn from "./locales/en/links.json" with { type: "json" };
import linksTr from "./locales/tr/links.json" with { type: "json" };
import loginsEn from "./locales/en/logins.json" with { type: "json" };
import loginsTr from "./locales/tr/logins.json" with { type: "json" };
import mainEn from "./locales/en/main.json" with { type: "json" };
import mainTr from "./locales/tr/main.json" with { type: "json" };
import mapEn from "./locales/en/map.json" with { type: "json" };
import mapTr from "./locales/tr/map.json" with { type: "json" };
import settingsEn from "./locales/en/settings.json" with { type: "json" };
import settingsTr from "./locales/tr/settings.json" with { type: "json" };
import terminalEn from "./locales/en/terminal.json" with { type: "json" };
import terminalTr from "./locales/tr/terminal.json" with { type: "json" };
import todosEn from "./locales/en/todos.json" with { type: "json" };
import todosTr from "./locales/tr/todos.json" with { type: "json" };
import updateEn from "./locales/en/update.json" with { type: "json" };
import updateTr from "./locales/tr/update.json" with { type: "json" };
import usageEn from "./locales/en/usage.json" with { type: "json" };
import usageTr from "./locales/tr/usage.json" with { type: "json" };
import webEn from "./locales/en/web.json" with { type: "json" };
import webTr from "./locales/tr/web.json" with { type: "json" };
import workbenchEn from "./locales/en/workbench.json" with { type: "json" };
import workbenchTr from "./locales/tr/workbench.json" with { type: "json" };

export const appEn = {
  ...sharedEn,
  agents: agentsEn,
  browser: browserEn,
  claude: claudeEn,
  common: commonEn,
  connect: connectEn,
  files: filesEn,
  flow: flowEn,
  links: linksEn,
  logins: loginsEn,
  main: mainEn,
  map: mapEn,
  settings: settingsEn,
  terminal: terminalEn,
  todos: todosEn,
  update: updateEn,
  usage: usageEn,
  web: webEn,
  workbench: workbenchEn,
};

export const appTr: typeof appEn = {
  ...sharedTr,
  agents: agentsTr,
  browser: browserTr,
  claude: claudeTr,
  common: commonTr,
  connect: connectTr,
  files: filesTr,
  flow: flowTr,
  links: linksTr,
  logins: loginsTr,
  main: mainTr,
  map: mapTr,
  settings: settingsTr,
  terminal: terminalTr,
  todos: todosTr,
  update: updateTr,
  usage: usageTr,
  web: webTr,
  workbench: workbenchTr,
};

/** Every key the app may ask for; `t()` accepts nothing else. */
export type MessageKey = KeysOf<typeof appEn>;
