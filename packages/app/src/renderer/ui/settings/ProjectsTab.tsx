import {
  BROWSER_RUN_ON,
  browserWindowOf,
  type BrowserRunOn,
  type BrowserWindowMode,
  type ClaudeAccount,
  type ClientProjectLocation,
  type Project,
  type ProjectLocation,
  type SshHost,
  type Tool,
} from "@kokpit/shared";
import { useId, useState } from "react";
import { t as translate, useT } from "../../../i18n/index.ts";
import { browserWindowHint, browserWindowLabel } from "../browser-window.ts";
import type { EngineClient } from "../../engine/types.ts";
import type { UiConfig } from "../config.ts";
import {
  fetchHosts,
  fetchSettings,
  fetchTools,
  HOSTS_EVENTS,
  SETTINGS_EVENTS,
  TOOLS_EVENTS,
  useEngineResource,
} from "../hooks/useEngineResource.ts";
import { isAppOnlyKind, locationLabel, sortProjects } from "../projects.ts";
import { CLAUDE_ACCOUNTS_EVENTS, fetchClaudeAccounts, projectAccountBadge } from "../claude-accounts.ts";
import { SHELL_ONLY, toolLabel, toolsForProject } from "../tool-choice.ts";
import { DeleteControl, EditButton, ErrorText, SelectField, SettingsForm, TextField, useFormSubmit, type Option } from "./parts.tsx";
import {
  checkAbsPath,
  checkGitUrl,
  checkHttpsUrl,
  checkName,
  compact,
  finish,
  type FieldErrors,
} from "./validation.ts";

const fetchProjects = async (c: EngineClient) => sortProjects((await c.request("projects.list", {})).projects);
const PROJECT_EVENTS = ["projects.changed"] as const;
const NONE: never[] = [];

type Kind = ProjectLocation["kind"];
type Mode = { kind: "create" } | { kind: "edit"; project: Project } | null;

export function ProjectsTab({ client, config }: { client: EngineClient; config: UiConfig }) {
  const tr = useT();
  const projects = useEngineResource(client, fetchProjects, PROJECT_EVENTS);
  const tools = useEngineResource(client, fetchTools, TOOLS_EVENTS).data ?? NONE;
  const hosts = useEngineResource(client, fetchHosts, HOSTS_EVENTS).data ?? NONE;
  const globalDefaultToolId = useEngineResource(client, fetchSettings, SETTINGS_EVENTS).data?.defaultToolId;
  // İş K: tools that need screen control are a choice only for a project that allows it (the edit form adds them
  // while its checkbox is on).
  const options = toolOptions(toolsForProject(tools, undefined), toolLabel(tools, globalDefaultToolId));
  const [mode, setMode] = useState<Mode>(null);
  const toolName = (id: string | undefined) => tools.find((t) => t.id === id)?.name ?? id;
  // İş H
  const accounts = useEngineResource(client, fetchClaudeAccounts, CLAUDE_ACCOUNTS_EVENTS).data;
  const accountOpts = accountOptions(accounts ?? NONE);

  const done = async (): Promise<void> => {
    setMode(null);
    await projects.reload();
  };

  return (
    <div className="kp-settings__tab">
      <div className="kp-settings__toolbar">
        <button type="button" className="kp-btn kp-btn--primary" onClick={() => setMode({ kind: "create" })}>
          {tr("settings.projects.add")}
        </button>
      </div>
      {mode?.kind === "create" && (
        <CreateProjectForm
          client={client}
          toolOptions={options}
          accountOptions={accountOpts}
          hosts={hosts}
          machineName={config.machineName}
          onDone={done}
          onCancel={() => setMode(null)}
        />
      )}
      {mode?.kind === "edit" && (
        <EditProjectForm
          key={mode.project.id}
          client={client}
          project={mode.project}
          location={locationLabel(mode.project, hosts, config.machineName)}
          hosts={hosts}
          machineName={config.machineName}
          toolOptions={options}
          accountOptions={accountOpts}
          onDone={done}
          onCancel={() => setMode(null)}
        />
      )}
      <ErrorText error={projects.error && tr("settings.projects.loadFailed", { error: projects.error })} />
      <ul className="kp-list">
        {(projects.data ?? NONE).map((p) => (
          <li key={p.id} className="kp-item">
            <div className="kp-item__main">
              <h3 className="kp-item__title">{p.name}</h3>
              <p className="kp-item__detail">{locationLabel(p, hosts, config.machineName)}</p>
              {p.defaultToolId && <p className="kp-item__detail">{tr("settings.projects.defaultToolLine", { name: toolName(p.defaultToolId) ?? "" })}</p>}
              {projectAccountBadge(accounts, p) && <p className="kp-item__detail">{tr("settings.projects.accountLine", { name: projectAccountBadge(accounts, p) ?? "" })}</p>}
              {!isAppOnlyKind(p.location.kind) && (
                <p className="kp-item__detail">{tr("settings.projects.browserLine", { where: runOnLabel(runOnOf(p), config.machineName) })}</p>
              )}
            </div>
            <div className="kp-item__actions">
              <EditButton name={p.name} onClick={() => setMode({ kind: "edit", project: p })} />
              {!p.builtin && (
                <DeleteControl
                  name={p.name}
                  onDelete={async () => {
                    await client.request("projects.delete", { projectId: p.id });
                    await projects.reload();
                  }}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "" = no project default: the project follows the global default (named in the label). */
const toolOptions = (tools: readonly Tool[], globalLabel: string): Option[] => [
  { value: SHELL_ONLY, label: translate("settings.projects.globalDefault", { name: globalLabel }) },
  ...tools.map((t) => ({ value: t.id, label: t.name })),
];

// ---- Claude hesabı (İş H) ----

/** "" = the default account (the engine gives such terminals no CLAUDE_CONFIG_DIR). */
const accountOptions = (accounts: readonly ClaudeAccount[]): Option[] => {
  const def = accounts.find((a) => a.isDefault);
  return [
    { value: "", label: translate("settings.projects.defaultAccountOption", { name: def?.name ?? translate("settings.projects.defaultAccountName") }) },
    ...accounts.filter((a) => !a.isDefault).map((a) => ({ value: a.id, label: a.name })),
  ];
};

function AccountField(p: { value: string; onChange(v: string): void; options: readonly Option[]; kind: Kind; machineName: string }) {
  const t = useT();
  if (isAppOnlyKind(p.kind)) return null;
  const options = p.value && !p.options.some((o) => o.value === p.value) ? [...p.options, { value: p.value, label: p.value }] : p.options;
  return (
    <SelectField
      label={t("settings.projects.account.label")}
      value={p.value}
      onChange={p.onChange}
      options={options}
      hint={
        p.kind === "ssh"
          ? t("settings.projects.account.sshHint", { machine: p.machineName })
          : t("settings.projects.account.hint")
      }
    />
  );
}

// ---- konum (create ve edit aynı alanları ve kontrolleri kullanır; İş P) ----

type LocationField = "path" | "url" | "hostId" | "remotePath";
type FormField = "name" | LocationField;

interface LocationDraft {
  kind: Kind;
  path: string;
  url: string;
  hostId: string;
  remotePath: string;
}

function draftOf(location: ProjectLocation | undefined): LocationDraft {
  const d: LocationDraft = {
    kind: location?.kind ?? "local",
    path: "",
    url: "",
    hostId: "",
    remotePath: "",
  };
  if (location?.kind === "local") d.path = location.path;
  if (location?.kind === "github") d.url = location.url;
  if (location?.kind === "ssh") Object.assign(d, { hostId: location.hostId, remotePath: location.path ?? "" });
  return d;
}

/** Field errors plus the location the protocol expects (only meaningful when there are no errors). */
function checkLocation(d: LocationDraft): { errors: FieldErrors<LocationField>; location: ClientProjectLocation } {
  if (d.kind === "local") return { errors: { path: checkAbsPath(d.path, translate("settings.projects.folderPath")) }, location: { kind: "local", path: d.path } };
  if (d.kind === "github") return { errors: { url: checkGitUrl(d.url) }, location: { kind: "github", url: d.url.trim() } };
  if (d.kind === "ssh") {
    const remote = d.remotePath.trim();
    return {
      errors: {
        hostId: d.hostId === "" ? translate("settings.projects.chooseServer") : undefined,
        remotePath: remote === "" ? undefined : checkAbsPath(remote, translate("settings.projects.remoteFolder")),
      },
      location: compact({ kind: "ssh" as const, hostId: d.hostId, path: remote === "" ? undefined : remote }),
    };
  }
  throw new Error(`unknown location kind: ${String(d.kind)}`);
}

/** Same location as the stored one (the engine normalises too; this only avoids sending an unchanged one). */
function sameLocation(a: ClientProjectLocation, b: ProjectLocation): boolean {
  if (a.kind === "github" || b.kind === "github") return a.kind === "github" && b.kind === "github" && a.url === b.url;
  return JSON.stringify(compact({ ...a })) === JSON.stringify(compact({ ...b }));
}

function kindOptions(machineName: string, withGithub: boolean): Array<{ id: Kind; label: string }> {
  return [
    { id: "local", label: translate("settings.projects.kinds.local", { machine: machineName }) },
    ...(withGithub ? [{ id: "github" as const, label: translate("settings.projects.kinds.github") }] : []),
    { id: "ssh", label: translate("settings.projects.kinds.ssh") },
  ];
}

function LocationFields(p: {
  draft: LocationDraft;
  onChange(d: LocationDraft): void;
  errors: FieldErrors<LocationField>;
  kinds: Array<{ id: Kind; label: string }>;
  hosts: readonly SshHost[];
  machineName: string;
}) {
  const t = useT();
  const radioName = useId();
  const { draft: d, errors } = p;
  const set = (patch: Partial<LocationDraft>) => p.onChange({ ...d, ...patch });
  return (
    <>
      <fieldset className="kp-fieldset">
        <legend className="kp-field__label">{t("settings.projects.kinds.legend")}</legend>
        {p.kinds.map((k) => (
          <label key={k.id} className="kp-radio">
            <input type="radio" name={radioName} value={k.id} checked={d.kind === k.id} onChange={() => set({ kind: k.id })} />
            {k.label}
          </label>
        ))}
      </fieldset>
      {d.kind === "local" && (
        <TextField label={t("settings.projects.folderPath")} mono value={d.path} onChange={(path) => set({ path })} error={errors.path} placeholder="/…" />
      )}
      {d.kind === "github" && (
        <TextField
          label={t("settings.projects.githubUrl")}
          mono
          inputMode="url"
          value={d.url}
          onChange={(url) => set({ url })}
          error={errors.url}
          placeholder={t("settings.projects.githubPlaceholder")}
          hint={t("settings.projects.githubHint", { machine: p.machineName })}
        />
      )}
      {d.kind === "ssh" && (
        <>
          <SelectField
            label={t("settings.projects.server")}
            value={d.hostId}
            onChange={(hostId) => set({ hostId })}
            error={errors.hostId}
            options={[{ value: "", label: t("settings.projects.choose") }, ...p.hosts.map((h) => ({ value: h.id, label: h.name }))]}
          />
          <TextField
            label={t("settings.projects.remoteFolder")}
            mono
            value={d.remotePath}
            onChange={(remotePath) => set({ remotePath })}
            error={errors.remotePath}
            placeholder={t("settings.common.optional")}
            hint={t("settings.projects.remoteFolderHint")}
          />
        </>
      )}
    </>
  );
}

interface CreateFormProps {
  client: EngineClient;
  toolOptions: readonly Option[];
  accountOptions: readonly Option[];
  hosts: readonly SshHost[];
  machineName: string;
  onDone(): Promise<void>;
  onCancel(): void;
}

function CreateProjectForm({ client, toolOptions, accountOptions, hosts, machineName, onDone, onCancel }: CreateFormProps) {
  const t = useT();
  const [accountId, setAccountId] = useState(""); // İş H
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<LocationDraft>(() => draftOf(undefined));
  const [defaultToolId, setDefaultToolId] = useState("");
  const [runOn, setRunOn] = useState<BrowserRunOn>("engine");
  const { action, errors, submit: send } = useFormSubmit<FormField>(onDone);
  const appOnly = isAppOnlyKind(draft.kind);

  const submit = (): void => {
    const { errors: e, location } = checkLocation(draft);
    const params = compact({
      name: name.trim(),
      location,
      // App-only projects have no terminals or browser: neither choice applies.
      defaultToolId: appOnly ? undefined : defaultToolId || undefined,
      // "engine" is the default: only a different choice is sent.
      browser: appOnly || runOn === "engine" ? undefined : { runOn },
      claudeAccountId: appOnly ? undefined : accountId || undefined, // İş H
    });
    send(finish("projects.create", params, { name: checkName(name), ...e }), (x) => client.request("projects.create", x));
  };

  return (
    <SettingsForm
      title={t("settings.projects.newTitle")}
      busy={action.busy}
      message={action.error}
      status={action.busy && draft.kind === "github" ? t("settings.projects.cloning") : null}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <TextField label={t("settings.common.name")} value={name} onChange={setName} error={errors.name} />
      <LocationFields
        draft={draft}
        onChange={setDraft}
        errors={errors}
        kinds={kindOptions(machineName, true)}
        hosts={hosts}
        machineName={machineName}
      />
      {!appOnly && <SelectField label={t("settings.common.defaultTool")} value={defaultToolId} onChange={setDefaultToolId} options={toolOptions} />}
      {!appOnly && <BrowserRunOnField value={runOn} onChange={setRunOn} machineName={machineName} />}
      <AccountField value={accountId} onChange={setAccountId} options={accountOptions} kind={draft.kind} machineName={machineName} />
    </SettingsForm>
  );
}

interface EditFormProps {
  client: EngineClient;
  project: Project;
  location: string;
  hosts: readonly SshHost[];
  machineName: string;
  toolOptions: readonly Option[];
  accountOptions: readonly Option[];
  onDone(): Promise<void>;
  onCancel(): void;
}

/** Why a project's location cannot be edited here, or null when it can (the engine has the final say). */
function fixedLocationReason(p: Project): string | null {
  if (p.builtin) return translate("settings.projects.fixedBuiltin");
  if (p.location.kind === "github") return translate("settings.projects.fixedGithub");
  return null;
}

function EditProjectForm({ client, project, location, hosts, machineName, toolOptions, accountOptions, onDone, onCancel }: EditFormProps) {
  const t = useT();
  const [accountId, setAccountId] = useState(project.claudeAccountId ?? ""); // İş H
  const [name, setName] = useState(project.name);
  const [defaultToolId, setDefaultToolId] = useState(project.defaultToolId ?? "");
  const [runOn, setRunOn] = useState<BrowserRunOn>(runOnOf(project));
  const [windowMode, setWindowMode] = useState<BrowserWindowMode>(browserWindowOf(project)); // Gizli tarayıcı
  const [agentsBrowser, setAgentsBrowser] = useState(agentsBrowserOf(project)); // Adım 9 İş A
  const [openInBrowser, setOpenInBrowser] = useState(openInBrowserOf(project)); // Yollar
  const [draft, setDraft] = useState<LocationDraft>(() => draftOf(project.location));
  const { action, errors, submit: send } = useFormSubmit<FormField>(onDone);
  const fixed = fixedLocationReason(project);
  const appOnly = isAppOnlyKind(draft.kind);
  // Keep a default tool that no longer exists selectable, so it is visible (and clearable).
  const options = [...toolOptions];
  if (defaultToolId && !options.some((o) => o.value === defaultToolId)) {
    options.push({ value: defaultToolId, label: defaultToolId });
  }

  const submit = (): void => {
    const checked = fixed === null ? checkLocation(draft) : null;
    const changed = checked && !sameLocation(checked.location, project.location) ? checked.location : undefined;
    const params = {
      projectId: project.id,
      name: name.trim(),
      defaultToolId: defaultToolId || null,
      ...browserParam(project, runOn, windowMode),
      ...(agentsBrowser === agentsBrowserOf(project) ? {} : { claudeBrowserEnv: agentsBrowser }),
      ...(openInBrowser === openInBrowserOf(project) ? {} : { openInBrowser }),
      ...(changed === undefined ? {} : { location: changed }),
      ...(accountId === (project.claudeAccountId ?? "") ? {} : { claudeAccountId: accountId || null }), // İş H
    };
    send(finish("projects.update", params, { name: checkName(name), ...checked?.errors }), (x) => client.request("projects.update", x));
  };

  return (
    <SettingsForm title={t("settings.common.editTitle", { name: project.name })} busy={action.busy} message={action.error} onSubmit={submit} onCancel={onCancel}>
      <TextField label={t("settings.common.name")} value={name} onChange={setName} error={errors.name} />
      {fixed !== null ? (
        <p className="kp-field__hint">{t("settings.projects.fixedLine", { reason: fixed, location })}</p>
      ) : (
        <>
          <LocationFields
            draft={draft}
            onChange={setDraft}
            errors={errors}
            kinds={kindOptions(machineName, false)}
            hosts={hosts}
            machineName={machineName}
          />
          <p className="kp-field__hint">{t("settings.projects.locationNote")}</p>
        </>
      )}
      {!appOnly && <SelectField label={t("settings.common.defaultTool")} value={defaultToolId} onChange={setDefaultToolId} options={options} />}
      {!appOnly && <BrowserRunOnField value={runOn} onChange={setRunOn} machineName={machineName} />}
      {agentsBrowserApplies(draft.kind, runOn) && <BrowserWindowField value={windowMode} onChange={setWindowMode} machineName={machineName} />}
      {agentsBrowserApplies(draft.kind, runOn) && <AgentsBrowserField value={agentsBrowser} onChange={setAgentsBrowser} />}
      {agentsBrowserApplies(draft.kind, runOn) && <OpenInBrowserField value={openInBrowser} onChange={setOpenInBrowser} machineName={machineName} />}
      <AccountField value={accountId} onChange={setAccountId} options={accountOptions} kind={draft.kind} machineName={machineName} />
    </SettingsForm>
  );
}


// ---- Adım 9 İş A: arka plan ajanlarının tarayıcısı ----

/** Absent = on (the engine's default). */
const agentsBrowserOf = (p: Project): boolean => p.claudeBrowserEnv !== false;
/** Only where the engine has a project folder on its own disk and runs the browser itself. */
const agentsBrowserApplies = (kind: LocationDraft["kind"], runOn: BrowserRunOn): boolean =>
  (kind === "local" || kind === "github") && runOn === "engine";

function AgentsBrowserField(p: { value: boolean; onChange(v: boolean): void }) {
  const t = useT();
  return (
    <SelectField
      label={t("settings.projects.agentsBrowser.label")}
      value={p.value ? "on" : "off"}
      onChange={(v) => p.onChange(v !== "off")}
      options={[
        { value: "on", label: t("settings.common.yes") },
        { value: "off", label: t("settings.common.no") },
      ]}
      hint={t("settings.projects.agentsBrowser.hint")}
    />
  );
}

// ---- Yollar: terminaldeki `open` ----

/** Absent = on (the engine's default). */
const openInBrowserOf = (p: Project): boolean => p.openInBrowser !== false;

/** Where the shim applies: local terminals of projects whose browser runs on the engine (same as the field above). */
function OpenInBrowserField(p: { value: boolean; onChange(v: boolean): void; machineName: string }) {
  const t = useT();
  return (
    <SelectField
      label={t("settings.projects.openInBrowser.label")}
      value={p.value ? "on" : "off"}
      onChange={(v) => p.onChange(v !== "off")}
      options={[
        { value: "on", label: t("settings.common.yes") },
        { value: "off", label: t("settings.common.no") },
      ]}
      hint={t("settings.projects.openInBrowser.hint", { machine: p.machineName })}
    />
  );
}

// ---- tarayıcı (İş B) ----

/**
 * `browser` for projects.update: only when the place or (for the engine's browser) the window changed. The window
 * goes along only for the engine's browser; an absent one keeps the project's.
 */
function browserParam(project: Project, runOn: BrowserRunOn, windowMode: BrowserWindowMode): { browser?: Project["browser"] } {
  const windowChanged = runOn === "engine" && windowMode !== browserWindowOf(project);
  if (runOn === runOnOf(project) && !windowChanged) return {};
  return { browser: runOn === "engine" ? { runOn, window: windowMode } : { runOn } };
}


function BrowserWindowField(p: { value: BrowserWindowMode; onChange(v: BrowserWindowMode): void; machineName: string }) {
  const t = useT();
  return (
    <SelectField
      label={browserWindowLabel(p.machineName)}
      value={p.value}
      onChange={(v) => p.onChange(v === "visible" ? "visible" : "hidden")}
      options={[
        { value: "hidden", label: t("settings.projects.browserWindow.hidden") },
        { value: "visible", label: t("settings.common.yes") },
      ]}
      hint={t("settings.projects.browserWindow.hint", { machine: p.machineName, why: browserWindowHint() })}
    />
  );
}

const runOnOf = (p: Project): BrowserRunOn => p.browser?.runOn ?? "engine";

function runOnLabel(runOn: BrowserRunOn, machineName: string): string {
  return runOn === "client" ? translate("settings.projects.runOn.client") : machineName;
}

function BrowserRunOnField(p: { value: BrowserRunOn; onChange(v: BrowserRunOn): void; machineName: string }) {
  const t = useT();
  return (
    <SelectField
      label={t("settings.projects.runOn.label")}
      value={p.value}
      onChange={(v) => p.onChange(v === "client" ? "client" : "engine")}
      options={BROWSER_RUN_ON.map((r) => ({ value: r, label: runOnLabel(r, p.machineName) }))}
      hint={t("settings.projects.runOn.profileNote")}
    />
  );
}
