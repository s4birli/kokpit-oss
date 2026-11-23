// İş H (Adım 8) — Claude hesapları. One Claude Code subscription = one config dir, selected with the
// CLAUDE_CONFIG_DIR environment variable (honoured by the `claude` CLI). Accounts are stored in the state file's
// settings; the default one ("Benim", <HOME>/.claude) is ensured on every start, gets no variable and cannot be
// deleted. Projects pick an account (`claudeAccountId`); their LOCAL terminals get the variable. SSH projects ignore
// it: the folders live on the engine's machine (the Mac mini), not on the server.
//
// Safety: a config dir must lie strictly inside HOME (also after resolving symlinks). Missing folders are created
// with 0700; nothing is ever deleted, renamed or overwritten, and nothing inside a config dir is read (credentials
// live there or in the Keychain — logging in is done by the user in a terminal running `claude /login`).
import { lstatSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { PRIVATE_DIR_MODE } from "./fs-safety.ts";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ClaudeAccount, ParamsOf, Project } from "@kokpit/shared";
import { st, type Params, type SharedKey } from "@kokpit/shared/i18n";
import { normalizePath } from "./bg-agents.ts";
import { engineError, type Logger, type StateStore } from "./contracts.ts";
import { slugify } from "./slug.ts";

/** The variable Claude Code reads its config dir from. */
export const CLAUDE_CONFIG_ENV = "CLAUDE_CONFIG_DIR";


/** config `claudeAccounts` block (config.defaults.json). */
export interface ClaudeAccountsTunables {
  defaultId: string;
  defaultName: string;
  /** Folder name of the default account under HOME. */
  defaultDirName: string;
  idFallback: string;
  idMaxLen: number;
  /** Folders "Skill'leri paylaş" links to the default account's. */
  shareNames: string[];
  /** Arguments of the login terminal's `claude` command. */
  loginArgs: string[];
}

/** A single folder name: never a path, never hidden traversal. */
const FolderName = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !s.includes("/") && !s.includes("\0") && s !== "." && s !== "..", "tek bir klasör adı olmalı");
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const ClaudeAccountsFields = z.object({
  defaultId: z.string().max(200).regex(SLUG),
  defaultName: z.string().trim().min(1).max(100),
  defaultDirName: FolderName,
  idFallback: z.string().max(200).regex(SLUG),
  idMaxLen: z.number().int().min(1).max(200),
  shareNames: z.array(FolderName).max(20),
  loginArgs: z.array(z.string().max(1000)).max(20),
});
/** Full block after defaults and the user file are merged. */
export const ClaudeAccountsConfigSchema = ClaudeAccountsFields.strict();
/** As it may appear in a config file (any subset). */
export const ClaudeAccountsFileSchema = ClaudeAccountsFields.partial().strict();

export interface ClaudeAccountServiceDeps {
  store: Pick<StateStore, "getSettings" | "updateSettings" | "listProjects">;
  logger: Logger;
  homeDir: string;
  tunables: ClaudeAccountsTunables;
  realpath?: (p: string) => string;
}

/** One `claude agents` call per distinct folder. */
export interface AccountDir {
  accountId: string;
  name: string;
  configDir: string;
  isDefault: boolean;
}

export interface ShareResult {
  linked: string[];
  skipped: { name: string; reason: string }[];
}

export interface ClaudeAccountService {
  /** Ensures the default account exists (creates no folder). */
  init(): void;
  list(): ClaudeAccount[];
  get(id: string): ClaudeAccount | undefined;
  /** NOT_FOUND for an unknown id. */
  require(id: string): ClaudeAccount;
  create(input: ParamsOf<"claudeAccounts.create">): ClaudeAccount;
  update(input: ParamsOf<"claudeAccounts.update">): ClaudeAccount;
  delete(id: string): void;
  /** Absolute config dir of the project's account; the default account's when unset or unknown. */
  configDirFor(project: Pick<Project, "claudeAccountId">): string;
  /**
   * Folders the project's account may legitimately symlink into besides its own ("Skill'leri paylaş"): the default
   * account's folder for a non-default account, nothing otherwise. For the Claude inventory panel (İş C).
   */
  sharedRootsFor(project: Pick<Project, "claudeAccountId">): string[];
  /**
   * Extra terminal env: `{ CLAUDE_CONFIG_DIR }` for a non-default account, `{}` otherwise. `accountId` (login,
   * attach) wins over the project's. Projects without a folder here (SSH) never get it unless an account is named explicitly.
   */
  envFor(project: Project, accountId?: string): Record<string, string>;
  /** Creates the account's folder if missing (0700). */
  ensureDir(id: string): string;
  distinctDirs(): AccountDir[];
  /** Symlinks `<dir>/<name>` → `<default>/<name>` where nothing exists yet. Never overwrites. */
  shareSkills(id: string): ShareResult;
}

/** Pure: the config dir of the project's account, falling back to the default account. */
export function configDirFor(accounts: readonly ClaudeAccount[], project: Pick<Project, "claudeAccountId">): string {
  const own = project.claudeAccountId === undefined ? undefined : accounts.find((a) => a.id === project.claudeAccountId);
  const account = own ?? accounts.find((a) => a.isDefault);
  if (!account) throw engineError("INTERNAL", "engine.claudeAccounts.noDefault");
  return account.configDir;
}

const invalid = (key: SharedKey, params?: Params) => engineError("INVALID", key, params);
const isInside = (path: string, dir: string) => path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
const sameName = (a: string, b: string) => a.toLocaleLowerCase("tr") === b.toLocaleLowerCase("tr");

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

export function createClaudeAccountService(deps: ClaudeAccountServiceDeps): ClaudeAccountService {
  const { store, logger, tunables } = deps;
  const home = resolve(deps.homeDir);
  const normalize = (p: string) => normalizePath(p, deps.realpath);
  const defaultDir = join(home, tunables.defaultDirName);

  const stored = (): ClaudeAccount[] => store.getSettings().claudeAccounts ?? [];
  const save = (accounts: ClaudeAccount[]) => store.updateSettings({ claudeAccounts: accounts });
  const defaultAccount = (): ClaudeAccount => stored().find((a) => a.isDefault) ?? seedDefault();

  function seedDefault(): ClaudeAccount {
    return { id: tunables.defaultId, name: tunables.defaultName, configDir: defaultDir, isDefault: true };
  }

  function get(id: string): ClaudeAccount | undefined {
    return stored().find((a) => a.id === id);
  }

  function requireAccount(id: string): ClaudeAccount {
    const a = get(id);
    if (!a) throw engineError("NOT_FOUND", "engine.claudeAccounts.notFound", { id });
    return a;
  }

  /** `~/x` or `/abs` → a normalized absolute folder strictly inside HOME (symlinks resolved too). Pure checks. */
  function checkDir(input: string): string {
    const raw = input.trim();
    if (raw.includes("\0")) throw invalid("engine.claudeAccounts.badPath");
    const expanded = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
    if (!expanded.startsWith("/")) throw invalid("engine.claudeAccounts.notAbsolute");
    const dir = resolve(expanded);
    if (!isInside(dir, home)) throw invalid("engine.claudeAccounts.outsideHome", { home });
    if (!isInside(normalize(dir), normalize(home))) throw invalid("engine.claudeAccounts.symlinkOutsideHome");
    let isDir: boolean | undefined;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = undefined; // missing: created later
    }
    if (isDir === false) throw invalid("engine.claudeAccounts.notAFolder", { dir });
    return dir;
  }

  function makeDir(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (e) {
      throw invalid("engine.claudeAccounts.createFailed", { dir, reason: errnoCode(e) ?? String(e) });
    }
  }

  function checkUnique(name: string, dir: string, exceptId?: string): void {
    for (const a of stored()) {
      if (a.id === exceptId) continue;
      if (sameName(a.name, name)) throw invalid("engine.claudeAccounts.nameTaken", { name: a.name });
      if (a.configDir === dir) throw invalid("engine.claudeAccounts.dirTaken", { name: a.name });
    }
  }

  function allocateId(name: string): string {
    const base = slugify(name, tunables.idMaxLen, tunables.idFallback);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (!get(id)) return id;
    }
  }

  function envFor(project: Project, accountId?: string): Record<string, string> {
    if (accountId === undefined && project.location.kind !== "local" && project.location.kind !== "github") return {};
    const id = accountId ?? project.claudeAccountId;
    if (id === undefined) return {};
    const account = get(id);
    if (!account) {
      logger.warn("Claude hesabı bulunamadı; varsayılan kullanılıyor", { projectId: project.id, accountId: id });
      return {};
    }
    return account.isDefault ? {} : { [CLAUDE_CONFIG_ENV]: account.configDir };
  }

  return {
    init() {
      const accounts = stored();
      if (accounts.some((a) => a.isDefault)) return;
      save([seedDefault(), ...accounts.filter((a) => a.id !== tunables.defaultId)]);
      logger.info("varsayılan Claude hesabı eklendi", { configDir: defaultDir });
    },

    list: () => stored(),
    get,
    require: requireAccount,

    create(input) {
      const name = input.name.trim();
      const dir = checkDir(input.configDir);
      checkUnique(name, dir);
      makeDir(dir);
      const account: ClaudeAccount = { id: allocateId(name), name, configDir: dir };
      save([...stored(), account]);
      logger.info("Claude hesabı eklendi", { accountId: account.id, configDir: dir });
      return account;
    },

    update(input) {
      const current = requireAccount(input.id);
      const name = input.name?.trim() ?? current.name;
      let dir = current.configDir;
      if (input.configDir !== undefined) {
        const wanted = checkDir(input.configDir);
        if (current.isDefault && wanted !== current.configDir) throw invalid("engine.claudeAccounts.defaultDirFixed");
        dir = wanted;
      }
      checkUnique(name, dir, current.id);
      if (dir !== current.configDir) makeDir(dir);
      const next: ClaudeAccount = { ...current, name, configDir: dir };
      save(stored().map((a) => (a.id === current.id ? next : a)));
      logger.info("Claude hesabı güncellendi", { accountId: next.id });
      return next;
    },

    delete(id) {
      const account = requireAccount(id);
      if (account.isDefault) throw invalid("engine.claudeAccounts.defaultNotDeletable");
      const users = store.listProjects().filter((p) => p.claudeAccountId === id);
      if (users.length > 0) throw invalid("engine.claudeAccounts.inUse", { count: users.length, projects: users.map((p) => p.name).join(", ") });
      save(stored().filter((a) => a.id !== id));
      logger.info("Claude hesabı silindi (klasörü yerinde)", { accountId: id });
    },

    configDirFor: (project) => configDirFor(stored().length > 0 ? stored() : [seedDefault()], project),
    envFor,

    sharedRootsFor(project) {
      const own = configDirFor(stored().length > 0 ? stored() : [seedDefault()], project);
      const def = defaultAccount().configDir;
      return own === def ? [] : [def];
    },

    ensureDir(id) {
      const account = requireAccount(id);
      if (!account.isDefault) makeDir(checkDir(account.configDir));
      return account.configDir;
    },

    distinctDirs() {
      const seen = new Set<string>();
      const out: AccountDir[] = [];
      const ordered = [...stored()].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
      for (const a of ordered) {
        if (seen.has(a.configDir)) continue;
        seen.add(a.configDir);
        out.push({ accountId: a.id, name: a.name, configDir: a.configDir, isDefault: !!a.isDefault });
      }
      return out;
    },

    shareSkills(id) {
      const account = requireAccount(id);
      if (account.isDefault) throw invalid("engine.claudeAccounts.defaultAlreadyShares");
      const dir = checkDir(account.configDir);
      makeDir(dir);
      const source = defaultAccount().configDir;
      const result: ShareResult = { linked: [], skipped: [] };
      for (const name of tunables.shareNames) {
        const link = join(dir, name);
        const target = join(source, name);
        let exists = true;
        try {
          lstatSync(link);
        } catch {
          exists = false;
        }
        if (exists) {
          result.skipped.push({ name, reason: st("engine.claudeAccounts.skipExists") });
          continue;
        }
        try {
          if (!statSync(target).isDirectory()) throw new Error("not a dir");
        } catch {
          result.skipped.push({ name, reason: st("engine.claudeAccounts.skipMissing") });
          continue;
        }
        try {
          symlinkSync(target, link, "dir");
          result.linked.push(name);
        } catch (e) {
          result.skipped.push({ name, reason: errnoCode(e) === "EEXIST" ? st("engine.claudeAccounts.skipExists") : st("engine.claudeAccounts.skipLinkFailed", { reason: errnoCode(e) ?? "?" }) });
        }
      }
      logger.info("Claude hesabı klasörleri paylaşıldı", { accountId: id, linked: result.linked });
      return result;
    },
  };
}
