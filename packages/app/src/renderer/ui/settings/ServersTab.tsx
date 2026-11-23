import type { SshHost } from "@kokpit/shared";
import { useState } from "react";
import { useT } from "../../../i18n/index.ts";
import type { EngineClient } from "../../engine/types.ts";
import { fetchHosts, fetchKeys, HOSTS_EVENTS, useEngineResource } from "../hooks/useEngineResource.ts";
import { DeleteControl, EditButton, ErrorText, SelectField, SettingsForm, TextField, useFormSubmit } from "./parts.tsx";
import { checkHostToken, checkName, compact, finish, parsePort, type FieldErrors } from "./validation.ts";

const NONE: never[] = [];
const NO_EVENTS = [] as const;
/** Shown for hosts read from ~/.ssh/config (read-only here). */
const SSH_CONFIG_BADGE = "~/.ssh/config";

type Mode = { kind: "create" } | { kind: "edit"; host: SshHost } | null;

function addressLine(h: SshHost): string {
  return `${h.user ? `${h.user}@` : ""}${h.hostname}${h.port ? `:${h.port}` : ""}`;
}

export function ServersTab({ client }: { client: EngineClient }) {
  const t = useT();
  const hosts = useEngineResource(client, fetchHosts, HOSTS_EVENTS);
  const keys = useEngineResource(client, fetchKeys, NO_EVENTS);
  const [mode, setMode] = useState<Mode>(null);

  const done = async (): Promise<void> => {
    setMode(null);
    await hosts.reload();
  };
  const open = (m: Mode): void => {
    setMode(m);
    void keys.reload();
  };

  return (
    <div className="kp-settings__tab">
      <div className="kp-settings__toolbar">
        <button type="button" className="kp-btn kp-btn--primary" onClick={() => open({ kind: "create" })}>
          {t("settings.servers.add")}
        </button>
      </div>
      {mode && (
        <HostForm
          key={mode.kind === "edit" ? mode.host.id : "new"}
          client={client}
          host={mode.kind === "edit" ? mode.host : undefined}
          keys={keys.data ?? NONE}
          onDone={done}
          onCancel={() => setMode(null)}
        />
      )}
      <ErrorText error={hosts.error && t("settings.servers.loadFailed", { error: hosts.error })} />
      <ul className="kp-list">
        {(hosts.data ?? NONE).map((h) => {
          const address = addressLine(h);
          return (
            <li key={h.id} className="kp-item">
              <div className="kp-item__main">
                <h3 className="kp-item__title">{h.name}</h3>
                {address !== h.name && <p className="kp-item__detail">{address}</p>}
                {h.identityFile && <p className="kp-item__detail">{t("settings.servers.keyLine", { file: h.identityFile })}</p>}
              </div>
              <div className="kp-item__actions">
                {h.source === "ssh-config" ? (
                  <span className="kp-badge" title={t("settings.servers.sshConfigTitle")}>
                    {SSH_CONFIG_BADGE}
                  </span>
                ) : (
                  <>
                    <EditButton name={h.name} onClick={() => open({ kind: "edit", host: h })} />
                    <DeleteControl
                      name={h.name}
                      onDelete={async () => {
                        await client.request("sshHosts.delete", { hostId: h.id });
                        await hosts.reload();
                      }}
                    />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type HostField = "name" | "hostname" | "user" | "port";

interface HostFormProps {
  client: EngineClient;
  host?: SshHost;
  keys: readonly string[];
  onDone(): Promise<void>;
  onCancel(): void;
}

function HostForm({ client, host, keys, onDone, onCancel }: HostFormProps) {
  const t = useT();
  const [name, setName] = useState(host?.name ?? "");
  const [hostname, setHostname] = useState(host?.hostname ?? "");
  const [user, setUser] = useState(host?.user ?? "");
  const [port, setPort] = useState(host?.port === undefined ? "" : String(host.port));
  const [identityFile, setIdentityFile] = useState(host?.identityFile ?? "");
  const { action, errors, submit: send } = useFormSubmit<HostField>(onDone);
  const keyNames = identityFile && !keys.includes(identityFile) ? [...keys, identityFile] : keys;
  const keyOptions = [{ value: "", label: t("settings.servers.noKey") }, ...keyNames.map((k) => ({ value: k, label: k }))];

  const submit = (): void => {
    const h = hostname.trim();
    const u = user.trim();
    const p = parsePort(port);
    const e: FieldErrors<HostField> = {
      name: checkName(name),
      hostname: checkHostToken(h, true, t("settings.servers.address")),
      user: checkHostToken(u, false, t("settings.servers.user")),
      port: p.ok ? undefined : p.error,
    };
    const portValue = p.ok ? p.port : undefined;
    if (host) {
      const params = {
        hostId: host.id,
        name: name.trim(),
        hostname: h,
        user: u || null,
        port: portValue ?? null,
        identityFile: identityFile || null,
      };
      send(finish("sshHosts.update", params, e), (x) => client.request("sshHosts.update", x));
    } else {
      const params = compact({
        name: name.trim(),
        hostname: h,
        user: u || undefined,
        port: portValue,
        identityFile: identityFile || undefined,
      });
      send(finish("sshHosts.create", params, e), (x) => client.request("sshHosts.create", x));
    }
  };

  return (
    <SettingsForm
      title={host ? t("settings.common.editTitle", { name: host.name }) : t("settings.servers.newTitle")}
      busy={action.busy}
      message={action.error}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <TextField label={t("settings.common.name")} value={name} onChange={setName} error={errors.name} />
      <TextField label={t("settings.servers.address")} mono value={hostname} onChange={setHostname} error={errors.hostname} placeholder={t("settings.servers.addressPlaceholder")} />
      <TextField label={t("settings.servers.user")} mono value={user} onChange={setUser} error={errors.user} placeholder={t("settings.common.optional")} />
      <TextField label={t("settings.servers.port")} mono inputMode="numeric" value={port} onChange={setPort} error={errors.port} placeholder={t("settings.common.optional")} />
      <SelectField
        label={t("settings.servers.key")}
        value={identityFile}
        onChange={setIdentityFile}
        options={keyOptions}
        hint={t("settings.servers.keyHint")}
      />
    </SettingsForm>
  );
}
