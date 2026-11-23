// İş H — Ayarlar › Claude hesapları: one Claude Code subscription per config folder (CLAUDE_CONFIG_DIR).
// Projects pick an account in their form; this tab lists, adds, edits and deletes accounts, opens the login
// terminal ("Giriş yap") and links the default account's skills/agents/commands ("Skill'leri paylaş", confirmed).
import type { ClaudeAccount, ClaudeUsageResult, TerminalInfo } from "@kokpit/shared";
import { useState } from "react";
import { intlLocale, useLocale, useT } from "../../../i18n/index.ts";
import type { EngineClient } from "../../engine/types.ts";
import type { UiConfig } from "../config.ts";
import { checkConfigDir, CLAUDE_ACCOUNTS_EVENTS, fetchClaudeAccounts } from "../claude-accounts.ts";
import { accountUsage } from "../claude-usage.ts";
import { ClaudeUsageBlock, useClaudeUsage } from "../ClaudeUsage.tsx";
import { useEngineResource } from "../hooks/useEngineResource.ts";
import { DeleteControl, EditButton, ErrorText, SettingsForm, TextField, useAction, useFormSubmit } from "./parts.tsx";
import { checkName, finish, type FieldErrors } from "./validation.ts";

const NONE: never[] = [];
const PROJECT_EVENTS = ["projects.changed"] as const;
const fetchProjects = async (c: EngineClient) => (await c.request("projects.list", {})).projects;


type Mode = { kind: "create" } | { kind: "edit"; account: ClaudeAccount } | null;

export function ClaudeAccountsTab({ client, config, onLogin }: { client: EngineClient; config: UiConfig; onLogin(terminal: TerminalInfo): void }) {
  const accounts = useEngineResource(client, fetchClaudeAccounts, CLAUDE_ACCOUNTS_EVENTS);
  const projects = useEngineResource(client, fetchProjects, PROJECT_EVENTS).data ?? NONE;
  // Claude kullanımı: each account's block; re-read while this tab is open.
  const usage = useClaudeUsage(client);
  const t = useT();
  const [mode, setMode] = useState<Mode>(null);

  const done = async (): Promise<void> => {
    setMode(null);
    await accounts.reload();
  };

  return (
    <div className="kp-settings__tab">
      <div className="kp-settings__toolbar">
        <button type="button" className="kp-btn kp-btn--primary" onClick={() => setMode({ kind: "create" })}>
          {t("settings.claude.add")}
        </button>
      </div>
      <p className="kp-field__hint">{t("settings.claude.credentialsNote")}</p>
      {mode && (
        <AccountForm
          key={mode.kind === "edit" ? mode.account.id : "new"}
          client={client}
          account={mode.kind === "edit" ? mode.account : undefined}
          onDone={done}
          onCancel={() => setMode(null)}
        />
      )}
      <ErrorText error={accounts.error && t("settings.claude.loadFailed", { error: accounts.error })} />
      <ErrorText error={usage.error && t("settings.claude.usageLoadFailed", { error: usage.error })} />
      <ul className="kp-list">
        {(accounts.data ?? NONE).map((a) => (
          <AccountItem
            key={a.id}
            client={client}
            config={config}
            account={a}
            usage={usage.data}
            onUsageChanged={usage.reload}
            projectCount={projects.filter((p) => p.claudeAccountId === a.id).length}
            onEdit={() => setMode({ kind: "edit", account: a })}
            onLogin={onLogin}
            onDeleted={() => accounts.reload()}
          />
        ))}
      </ul>
    </div>
  );
}

function AccountItem(p: {
  client: EngineClient;
  config: UiConfig;
  account: ClaudeAccount;
  usage: ClaudeUsageResult | undefined;
  onUsageChanged(): Promise<void>;
  projectCount: number;
  onEdit(): void;
  onLogin(t: TerminalInfo): void;
  onDeleted(): Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const { client, account: a } = p;
  const login = useAction();
  const share = useAction();
  const [confirming, setConfirming] = useState(false);
  const [shared, setShared] = useState<string | null>(null);
  const used = accountUsage(p.usage, a.id);

  const doShare = (): void => {
    void share.run(async () => {
      const r = await client.request("claudeAccounts.shareSkills", { id: a.id, confirm: true });
      const linked = r.linked.length > 0 ? t("settings.claude.linked", { list: r.linked.join(", ") }) : t("settings.claude.noneLinked");
      const skipped =
        r.skipped.length > 0 ? ` · ${t("settings.claude.skipped", { list: r.skipped.map((s) => `${s.name} (${s.reason})`).join(", ") })}` : "";
      setShared(linked + skipped);
      setConfirming(false);
    });
  };

  return (
    <li className="kp-item">
      <div className="kp-item__main">
        <h3 className="kp-item__title">{a.name}</h3>
        <p className="kp-item__detail kp-item__detail--mono">{a.configDir}</p>
        {p.projectCount > 0 && <p className="kp-item__detail">{t("settings.claude.projectCount", { count: p.projectCount })}</p>}
        {confirming && <p className="kp-field__hint">{t("settings.claude.shareNote", { dir: a.configDir })}</p>}
        {shared && (
          <p role="status" className="kp-settings__status">
            {shared}
          </p>
        )}
        <ErrorText error={login.error && t("settings.claude.loginFailed", { error: login.error })} />
        <ErrorText error={share.error && t("settings.claude.shareFailed", { error: share.error })} />
        {used && p.usage && <ClaudeUsageBlock client={client} account={used} meta={p.usage} locale={intlLocale(locale)} onChanged={p.onUsageChanged} />}
      </div>
      <div className="kp-item__actions">
        {a.isDefault && (
          <span className="kp-badge" title={t("settings.claude.defaultBadgeTitle")}>
            {t("settings.claude.defaultBadge")}
          </span>
        )}
        <button
          type="button"
          className="kp-btn"
          aria-label={t("settings.claude.loginAria", { name: a.name })}
          disabled={login.busy}
          onClick={() =>
            void login.run(async () => {
              const { terminal } = await client.request("claudeAccounts.login", { id: a.id, ...p.config.fallbackDims });
              p.onLogin(terminal);
            })
          }
        >
          {t("settings.claude.login")}
        </button>
        {!a.isDefault &&
          (confirming ? (
            <span className="kp-form__actions">
              <button type="button" className="kp-btn kp-btn--primary" disabled={share.busy} onClick={doShare}>
                {t("settings.claude.confirmShare")}
              </button>
              <button type="button" className="kp-btn" disabled={share.busy} onClick={() => setConfirming(false)}>
                {t("settings.common.cancel")}
              </button>
            </span>
          ) : (
            <button type="button" className="kp-btn" aria-label={t("settings.claude.shareAria", { name: a.name })} onClick={() => setConfirming(true)}>
              {t("settings.claude.share")}
            </button>
          ))}
        <EditButton name={a.name} onClick={p.onEdit} />
        {!a.isDefault && (
          <DeleteControl
            name={a.name}
            onDelete={async () => {
              await client.request("claudeAccounts.delete", { id: a.id });
              await p.onDeleted();
            }}
          />
        )}
      </div>
    </li>
  );
}

type Field = "name" | "configDir";

function AccountForm(p: { client: EngineClient; account?: ClaudeAccount; onDone(): Promise<void>; onCancel(): void }) {
  const t = useT();
  const { client, account } = p;
  const [name, setName] = useState(account?.name ?? "");
  const [configDir, setConfigDir] = useState(account?.configDir ?? "");
  const { action, errors, submit: send } = useFormSubmit<Field>(p.onDone);
  const dirEditable = !account?.isDefault;

  const submit = (): void => {
    const e: FieldErrors<Field> = { name: checkName(name), configDir: dirEditable ? checkConfigDir(configDir) : undefined };
    if (account) {
      const params = {
        id: account.id,
        name: name.trim(),
        ...(dirEditable && configDir.trim() !== account.configDir ? { configDir: configDir.trim() } : {}),
      };
      send(finish("claudeAccounts.update", params, e), (x) => client.request("claudeAccounts.update", x));
    } else {
      send(finish("claudeAccounts.create", { name: name.trim(), configDir: configDir.trim() }, e), (x) =>
        client.request("claudeAccounts.create", x),
      );
    }
  };

  return (
    <SettingsForm
      title={account ? t("settings.common.editTitle", { name: account.name }) : t("settings.claude.newTitle")}
      busy={action.busy}
      message={action.error}
      onSubmit={submit}
      onCancel={p.onCancel}
    >
      <TextField label={t("settings.common.name")} value={name} onChange={setName} error={errors.name} placeholder={t("settings.claude.namePlaceholder")} />
      {dirEditable ? (
        <TextField
          label={t("settings.claude.configDir")}
          mono
          value={configDir}
          onChange={setConfigDir}
          error={errors.configDir}
          placeholder={t("settings.claude.configDirPlaceholder")}
          hint={t("settings.claude.configDirHint")}
        />
      ) : (
        <p className="kp-field__hint">{t("settings.claude.fixedDir", { dir: account?.configDir ?? "" })}</p>
      )}
    </SettingsForm>
  );
}
