import type { TerminalInfo, Tool, ToolStatus } from "@kokpit/shared";
import { useState } from "react";
import { t as translate, useT } from "../../../i18n/index.ts";
import type { EngineClient } from "../../engine/types.ts";
import type { UiConfig } from "../config.ts";
import {
  fetchSettings,
  fetchToolStatuses,
  fetchTools,
  SETTINGS_EVENTS,
  TOOLS_EVENTS,
  useEngineResource,
} from "../hooks/useEngineResource.ts";
import { SHELL_ONLY, shellOnlyLabel } from "../tool-choice.ts";
import {
  DeleteControl,
  EditButton,
  ErrorText,
  SelectField,
  SettingsForm,
  TextAreaField,
  TextField,
  useAction,
  useFormSubmit,
} from "./parts.tsx";
import { checkCommand, checkName, compact, finish, parsePatterns } from "./validation.ts";

const NONE: never[] = [];

type Mode = { kind: "create" } | { kind: "edit"; tool: Tool } | null;

function statusText(statuses: readonly ToolStatus[] | undefined, toolId: string): string {
  if (statuses === undefined) return translate("settings.tools.status.checking");
  const installed = statuses.find((s) => s.toolId === toolId)?.installed;
  if (installed === true) return translate("settings.tools.status.installed");
  if (installed === false) return translate("settings.tools.status.notInstalled");
  return translate("settings.tools.status.unknown");
}

export interface ToolsTabProps {
  client: EngineClient;
  config: UiConfig;
  /** The install terminal was opened (in the built-in project). */
  onInstalled(terminal: TerminalInfo): void;
}

export function ToolsTab({ client, config, onInstalled }: ToolsTabProps) {
  const tr = useT();
  const tools = useEngineResource(client, fetchTools, TOOLS_EVENTS);
  const statuses = useEngineResource(client, fetchToolStatuses, TOOLS_EVENTS);
  const [mode, setMode] = useState<Mode>(null);
  const checking = useAction();
  const install = useAction();

  const done = async (): Promise<void> => {
    setMode(null);
    await Promise.all([tools.reload(), statuses.reload()]);
  };

  const installed = (toolId: string): boolean | null | undefined =>
    statuses.data?.find((s) => s.toolId === toolId)?.installed;

  return (
    <div className="kp-settings__tab">
      <DefaultToolField client={client} tools={tools.data ?? NONE} />
      <div className="kp-settings__toolbar">
        <button type="button" className="kp-btn kp-btn--primary" onClick={() => setMode({ kind: "create" })}>
          {tr("settings.tools.add")}
        </button>
        <button
          type="button"
          className="kp-btn"
          disabled={checking.busy}
          onClick={() => void checking.run(statuses.reload)}
        >
          {tr("settings.tools.recheck")}
        </button>
      </div>
      {mode && (
        <ToolForm
          key={mode.kind === "edit" ? mode.tool.id : "new"}
          client={client}
          tool={mode.kind === "edit" ? mode.tool : undefined}
          onDone={done}
          onCancel={() => setMode(null)}
        />
      )}
      <ErrorText error={tools.error && tr("settings.tools.loadFailed", { error: tools.error })} />
      <ErrorText error={statuses.error && tr("settings.tools.checkFailed", { error: statuses.error })} />
      <ErrorText error={install.error} />
      <ul className="kp-list">
        {(tools.data ?? NONE).map((t) => {
          const status = statusText(statuses.data, t.id);
          return (
            <li key={t.id} className="kp-item">
              <div className="kp-item__main">
                <h3 className="kp-item__title">{t.name}</h3>
                <p className="kp-item__detail kp-item__detail--mono">{t.command}</p>
              </div>
              <div className="kp-item__actions">
                <span className={installed(t.id) === true ? "kp-badge kp-badge--ok" : "kp-badge"}>{status}</span>
                {installed(t.id) === false && t.installCommand && (
                  <button
                    type="button"
                    className="kp-btn kp-btn--primary"
                    aria-label={tr("settings.tools.installAria", { name: t.name })}
                    disabled={install.busy}
                    onClick={() =>
                      void install.run(async () => {
                        const { terminal } = await client.request("tools.install", {
                          toolId: t.id,
                          ...config.fallbackDims,
                        });
                        onInstalled(terminal);
                      })
                    }
                  >
                    {tr("settings.tools.install")}
                  </button>
                )}
                <EditButton name={t.name} onClick={() => setMode({ kind: "edit", tool: t })} />
                <DeleteControl
                  name={t.name}
                  onDelete={async () => {
                    await client.request("tools.delete", { toolId: t.id });
                    await tools.reload();
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Global default tool (engine settings): saved as soon as it changes. */
function DefaultToolField({ client, tools }: { client: EngineClient; tools: readonly Tool[] }) {
  const t = useT();
  const settings = useEngineResource(client, fetchSettings, SETTINGS_EVENTS);
  const save = useAction();
  /** The value being saved, shown until the engine answers. */
  const [pending, setPending] = useState<string | null>(null);
  const saved = settings.data?.defaultToolId ?? SHELL_ONLY;

  const onChange = (value: string): void => {
    setPending(value);
    void save
      .run(async () => {
        await client.request("settings.update", { defaultToolId: value === SHELL_ONLY ? null : value });
        await settings.reload();
      })
      .finally(() => setPending(null));
  };

  return (
    <div className="kp-settings__default">
      <SelectField
        label={t("settings.common.defaultTool")}
        value={pending ?? saved}
        onChange={onChange}
        hint={t("settings.tools.defaultToolHint")}
        options={[{ value: SHELL_ONLY, label: shellOnlyLabel() }, ...tools.map((x) => ({ value: x.id, label: x.name }))]}
      />
      <ErrorText error={settings.error && t("settings.tools.settingsLoadFailed", { error: settings.error })} />
      <ErrorText error={save.error} />
    </div>
  );
}

type ToolField = "name" | "command" | "installCommand" | "checkCommand" | "waitingPatterns";

/** Rows of the "Bekleme kalıpları" textarea. */
const PATTERN_ROWS = 4;

function ToolForm(p: { client: EngineClient; tool?: Tool; onDone(): Promise<void>; onCancel(): void }) {
  const t = useT();
  const { client, tool } = p;
  const [name, setName] = useState(tool?.name ?? "");
  const [command, setCommand] = useState(tool?.command ?? "");
  const [installCommand, setInstallCommand] = useState(tool?.installCommand ?? "");
  const [checkCmd, setCheckCmd] = useState(tool?.checkCommand ?? "");
  const initialPatterns = tool?.waitingPatterns ?? [];
  const [patternText, setPatternText] = useState(initialPatterns.join("\n"));
  const { action, errors, submit: send } = useFormSubmit<ToolField>(p.onDone);

  const submit = (): void => {
    const e = {
      name: checkName(name),
      command: checkCommand(command, true, t("settings.tools.command")),
      installCommand: checkCommand(installCommand, false, t("settings.tools.installCommand")),
      checkCommand: checkCommand(checkCmd, false, t("settings.tools.checkCommand")),
      waitingPatterns: undefined as string | undefined,
    };
    // İş A: one regex per line; sent only when changed (edit) or given (create). Empty = engine's generic list.
    const parsed = parsePatterns(patternText);
    if (!parsed.ok) e.waitingPatterns = parsed.error;
    const patterns = parsed.ok ? parsed.patterns : [];
    const patternsChanged = patterns.join("\n") !== initialPatterns.join("\n");
    const fields = { name: name.trim(), command: command.trim() };
    const install = installCommand.trim();
    const check = checkCmd.trim();
    if (tool) {
      const params = {
        toolId: tool.id,
        ...fields,
        installCommand: install || null,
        checkCommand: check || null,
        ...(patternsChanged ? { waitingPatterns: patterns.length > 0 ? patterns : null } : {}),
      };
      send(finish("tools.update", params, e), (x) => client.request("tools.update", x));
    } else {
      const params = compact({
        ...fields,
        installCommand: install || undefined,
        checkCommand: check || undefined,
        waitingPatterns: patterns.length > 0 ? patterns : undefined,
      });
      send(finish("tools.create", params, e), (x) => client.request("tools.create", x));
    }
  };

  return (
    <SettingsForm
      title={tool ? t("settings.common.editTitle", { name: tool.name }) : t("settings.tools.newTitle")}
      busy={action.busy}
      message={action.error}
      onSubmit={submit}
      onCancel={p.onCancel}
    >
      <TextField label={t("settings.common.name")} value={name} onChange={setName} error={errors.name} />
      <TextField
        label={t("settings.tools.command")}
        mono
        value={command}
        onChange={setCommand}
        error={errors.command}
        hint={t("settings.tools.commandHint")}
      />
      <TextField
        label={t("settings.tools.installCommand")}
        mono
        value={installCommand}
        onChange={setInstallCommand}
        error={errors.installCommand}
        placeholder={t("settings.common.optional")}
      />
      <TextField
        label={t("settings.tools.checkCommand")}
        mono
        value={checkCmd}
        onChange={setCheckCmd}
        error={errors.checkCommand}
        placeholder={t("settings.common.optional")}
        hint={t("settings.tools.checkCommandHint")}
      />
      <TextAreaField
        label={t("settings.tools.patterns")}
        rows={PATTERN_ROWS}
        value={patternText}
        onChange={setPatternText}
        error={errors.waitingPatterns}
        placeholder={t("settings.common.optional")}
        hint={t("settings.tools.patternsHint")}
      />
    </SettingsForm>
  );
}
