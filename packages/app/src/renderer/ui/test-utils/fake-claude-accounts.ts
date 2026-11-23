// İş H: in-memory claudeAccounts.* for FakeEngineClient. Mirrors the engine's rules that the UI depends on:
// the default account is seeded and cannot be deleted; `~/` expands to FAKE_HOME.
import type { ClaudeAccount, ParamsOf, ResultOf, TerminalInfo } from "@kokpit/shared";
import { EngineRequestError } from "../../engine/types.ts";

export const FAKE_HOME = "/Users/test";
export const FAKE_DEFAULT_ACCOUNT: ClaudeAccount = { id: "benim", name: "Benim", configDir: `${FAKE_HOME}/.claude`, isDefault: true };

type AccountMethod =
  | "claudeAccounts.list"
  | "claudeAccounts.create"
  | "claudeAccounts.update"
  | "claudeAccounts.delete"
  | "claudeAccounts.login"
  | "claudeAccounts.shareSkills";
type Handlers = { [M in AccountMethod]: (params: ParamsOf<M>) => ResultOf<M> };

const expand = (p: string) => (p.startsWith("~/") ? `${FAKE_HOME}/${p.slice(2)}` : p).replace(/\/+$/, "");

export class FakeClaudeAccounts {
  accounts: ClaudeAccount[] = [{ ...FAKE_DEFAULT_ACCOUNT }];
  /** Names `shareSkills` reports as linked (the rest as skipped). */
  shareLinks = ["skills"];

  private readonly openTerminal: (projectId: string, command: string) => TerminalInfo;
  private readonly builtinId: () => string | undefined;

  constructor(openTerminal: (projectId: string, command: string) => TerminalInfo, builtinId: () => string | undefined) {
    this.openTerminal = openTerminal;
    this.builtinId = builtinId;
  }

  seed(accounts: ClaudeAccount[] | undefined): void {
    if (accounts) this.accounts = accounts.map((a) => ({ ...a }));
  }

  private find(id: string): ClaudeAccount {
    const a = this.accounts.find((x) => x.id === id);
    if (!a) throw new EngineRequestError("NOT_FOUND", `Claude hesabı bulunamadı: ${id}`);
    return a;
  }

  private checkDir(raw: string): string {
    const dir = expand(raw);
    if (!dir.startsWith(`${FAKE_HOME}/`)) throw new EngineRequestError("INVALID", `Klasör ana klasörün (${FAKE_HOME}) içinde olmalı.`);
    return dir;
  }

  readonly handlers: Handlers = {
    "claudeAccounts.list": () => ({ accounts: this.accounts.map((a) => ({ ...a })) }),
    "claudeAccounts.create": ({ name, configDir }) => {
      const account: ClaudeAccount = { id: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "hesap", name: name.trim(), configDir: this.checkDir(configDir) };
      this.accounts.push(account);
      return { account: { ...account } };
    },
    "claudeAccounts.update": ({ id, name, configDir }) => {
      const a = this.find(id);
      if (configDir !== undefined) {
        const dir = this.checkDir(configDir);
        if (a.isDefault && dir !== a.configDir) throw new EngineRequestError("INVALID", "Varsayılan hesabın klasörü değiştirilemez.");
        a.configDir = dir;
      }
      if (name !== undefined) a.name = name.trim();
      return { account: { ...a } };
    },
    "claudeAccounts.delete": ({ id }) => {
      const a = this.find(id);
      if (a.isDefault) throw new EngineRequestError("INVALID", "Varsayılan hesap silinemez.");
      this.accounts = this.accounts.filter((x) => x !== a);
      return {};
    },
    "claudeAccounts.login": ({ id }) => {
      this.find(id);
      const builtin = this.builtinId();
      if (builtin === undefined) throw new EngineRequestError("NOT_FOUND", "Yerleşik proje yok");
      return { terminal: this.openTerminal(builtin, "claude /login") };
    },
    "claudeAccounts.shareSkills": ({ id }) => {
      const a = this.find(id);
      if (a.isDefault) throw new EngineRequestError("INVALID", "Varsayılan hesap zaten bu klasörleri kullanıyor.");
      return { linked: [...this.shareLinks], skipped: [{ name: "agents", reason: "zaten var, dokunulmadı" }] };
    },
  };
}
