// Girişler: a project's saved logins for its browser (username + password per site).
//
// Where things live:
//   - the PASSWORD: one generic-password item per login in the macOS Keychain of the engine machine (keychain.ts);
//   - everything else (id, project, site origin, username, label, dates): the engine's state file.
//
// How the password travels:
//   - SAVE is accepted only for the site that is open in the project's browser at that moment: the engine asks the
//     active tab for its top-level origin (isolated world, no secret involved) and refuses any other origin, so the
//     app — or anything speaking its protocol — cannot bind credentials to a site the user is not looking at.
//   - SAVE: app → `logins.save` (the engine's authenticated WebSocket) → this service → stdin of `security -i` →
//     Keychain. It is not kept in memory after the call, and never written to the state, the log or an error.
//   - FILL: `logins.fill` carries ids only. The engine asks the open page for its origin (no secret involved), and
//     only if it equals the login's reads the secret (`security find-generic-password -w`, stdout pipe) and passes
//     it to the page as an argument of one CDP call (browser-login-fill.ts), which checks the origin again in the
//     same synchronous step. The app gets the names of the filled fields.
//   - There is no request that returns a password.
//
// Two things this cannot hide, and therefore asks about (both enforced HERE, not in the app):
//   - an agent attached to the same Chrome over CDP can read a filled password from the page. CDP gives a client no
//     way to see or close OTHER clients (`Target.getTargets().attached` is true for the engine's own session too,
//     and no event announces another client), so the engine cannot cut agents off for the moment of a fill. A fill
//     is ALWAYS refused (LOGIN_RISK_UNACCEPTED) until the user accepted that risk for the project (`setRisk`,
//     remembered in the state, revocable) — there is no "no agent around" shortcut: the browser's DevTools port is
//     a loopback port every program of this user can reach (terminals, card terminals, background agents through
//     the project's Claude settings file, other projects' agents). On top of that, while an agent is known to run
//     in the project (login-agents.ts), every single fill needs a fresh confirmation in the request.
//   - reading a password needs the user's click in the Keychain dialog (`keychainAccess: "confirm"`): the fill
//     waits for it (`confirmTimeoutMs`); a second fill of the same login meanwhile is refused instead of queueing
//     a second dialog, and after a denial or an unanswered dialog the login is left alone for `denyCooldownMs`.
//
// Rules:
//   - logins belong to one project; an id of another project is "not found";
//   - fills are rate-limited per project (attempts count, also failed ones);
//   - the log names ids only — usernames and sites are personal data;
//   - deleting a project deletes its Keychain items; what cannot be deleted right then (Keychain locked) is
//     remembered in the state and deleted after the next Keychain operation that works.
import { randomUUID } from "node:crypto";
import type { LoginFillField, LoginPolicy, ParamsOf, SavedLogin } from "@kokpit/shared";
import { LOGIN_FILL_FUNCTION, LOGIN_PROBE_FUNCTION, originMismatch, parseFill, parseProbe, saveOriginMismatch } from "./browser-login-fill.ts";
import type { IsolatedCall } from "./browser-isolated.ts";
import { engineError, type KeychainItemRef, type Logger, type LoginStore } from "./contracts.ts";
import type { SharedKey } from "@kokpit/shared/i18n";
import { keychainRef, KeychainError, type Keychain, type KeychainFailure } from "./keychain.ts";
import type { LoginsConfig } from "./logins-config.ts";

/** The little the service needs of the browser: one function call in the project's active tab. */
export interface LoginPage {
  /** NOT_FOUND when the project's browser is not running here. */
  callIsolated(projectId: string, call: IsolatedCall): Promise<unknown>;
}

export interface LoginServiceDeps {
  config: LoginsConfig;
  store: LoginStore;
  keychain: Keychain;
  /** Absent = this engine has no browser: fills answer INVALID. */
  page: LoginPage | undefined;
  logger: Logger;
  /**
   * Whether an agent is running in the project right now, as far as the engine can tell (login-agents.ts). Used
   * ONLY to ask again on each fill and to make the warning stronger — never to skip the per-project acceptance.
   * A failure counts as "yes". Absent = never.
   */
  agentsPresent?: (projectId: string) => boolean | Promise<boolean>;
  now?: () => Date;
  newId?: () => string;
}

export interface LoginService {
  /** Metadata of the project's logins. */
  list(projectId: string): SavedLogin[];
  /** New login, or a new password (and label) for the project's login with the same origin and username. */
  save(input: ParamsOf<"logins.save">): Promise<SavedLogin>;
  delete(id: string): Promise<void>;
  /** Fills the login into the project's active tab; resolves with the names of the filled fields. */
  fill(projectId: string, id: string, opts?: { confirmAgentRisk?: boolean | undefined }): Promise<LoginFillField[]>;
  /** What the app must know before offering a fill in the project. */
  policy(projectId: string): Promise<LoginPolicy>;
  /** The user accepts (true) or takes back (false) the agent risk for the project. */
  setRisk(projectId: string, accepted: boolean): Promise<LoginPolicy>;
  /** The project is being deleted: its logins are forgotten now, their Keychain items deleted in the background. */
  forgetProject(projectId: string): void;
  /** Resolves when no Keychain work is pending (shutdown, tests). */
  idle(): Promise<void>;
}

const MS_PER_S = 1000;
const TEXT = {
  riskFirst: "engine.logins.riskFirst",
  riskNow: "engine.logins.riskNow",
  waiting: "engine.logins.waiting",
  cooldown: "engine.logins.cooldown",
} as const;

function keychainText(kind: KeychainFailure, config: LoginsConfig): SharedKey {
  switch (kind) {
    case "interaction":
      return "engine.logins.keychainInteraction";
    case "timeout":
      return "engine.logins.keychainTimeout";
    case "denied":
      return "engine.logins.keychainDenied";
    case "unavailable":
      return "engine.logins.keychainUnavailable";
    case "notFound":
      return "engine.logins.keychainNotFound";
    case "garbage":
      return "engine.logins.keychainGarbage";
    default:
      return "engine.logins.keychainFailed";
  }
}

export function createLoginService(deps: LoginServiceDeps): LoginService {
  const { config, store, keychain, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  /** Keychain work never interleaves: each step waits for the one before it. */
  let queue: Promise<unknown> = Promise.resolve();
  /** projectId → times (ms) of the recent fill attempts. */
  const fillTimes = new Map<string, number[]>();
  /** Logins whose secret is being read right now (a Keychain dialog may be open for them). */
  const reading = new Set<string>();
  /** loginId → time (ms) before which it is not read again (the user said no, or did not answer). */
  const coolUntil = new Map<string, number>();
  /** Not knowing counts as "yes". */
  const agentsPresent = async (projectId: string): Promise<boolean> => {
    if (!deps.agentsPresent) return false;
    try {
      return (await deps.agentsPresent(projectId)) === true;
    } catch {
      return true;
    }
  };
  const policyOf = async (projectId: string): Promise<LoginPolicy> => ({
    keychainAccess: config.keychainAccess,
    agentRiskAccepted: store.isLoginRiskAccepted(projectId),
    agentsPresent: await agentsPresent(projectId),
  });

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  /** A KeychainError → what the user is told. Anything else passes through. */
  function asEngineError(err: unknown): unknown {
    if (!(err instanceof KeychainError)) return err;
    if (err.kind === "tooLarge") return engineError("INVALID", "engine.logins.secretTooLong", { max: config.maxSecretBytes });
    if (err.kind === "invalid") return engineError("INVALID", "engine.logins.badProjectId");
    return engineError("KEYCHAIN_FAILED", keychainText(err.kind, config));
  }

  function refOf(projectId: string, loginId: string): KeychainItemRef {
    try {
      return keychainRef(config, projectId, loginId);
    } catch (err) {
      throw asEngineError(err);
    }
  }

  /** Deletes remembered leftovers; what still fails stays remembered. Never throws. */
  async function retryOrphans(): Promise<void> {
    const orphans = store.listLoginOrphans();
    if (orphans.length === 0) return;
    const left: KeychainItemRef[] = [];
    for (const ref of orphans) {
      try {
        await keychain.delete(ref);
      } catch {
        left.push(ref);
      }
    }
    if (left.length !== orphans.length) {
      store.setLoginOrphans(left);
      logger.info("leftover keychain items deleted", { deleted: orphans.length - left.length, left: left.length });
    }
  }

  /** The top-level origin of the project's active tab, read in an isolated world. Involves no secret. */
  async function openOrigin(projectId: string): Promise<string> {
    if (!deps.page) throw engineError("INVALID", "engine.logins.noBrowser");
    return parseProbe(await deps.page.callIsolated(projectId, { worldName: config.fillWorldName, functionDeclaration: LOGIN_PROBE_FUNCTION, args: [] }));
  }

  function allowFill(projectId: string): void {
    const t = now().getTime();
    const recent = (fillTimes.get(projectId) ?? []).filter((x) => t - x < config.fillRateWindowMs);
    if (recent.length >= config.fillRateMax) {
      fillTimes.set(projectId, recent);
      throw engineError("RATE_LIMITED", "engine.logins.rateLimited");
    }
    recent.push(t);
    fillTimes.set(projectId, recent);
  }

  return {
    list: (projectId) => store.listLogins(projectId),

    save(input) {
      return serial(async () => {
        const { projectId, origin, username, password } = input;
        const mine = store.listLogins(projectId);
        const existing = mine.find((l) => l.origin === origin && l.username === username);
        if (!existing && mine.length >= config.maxPerProject) {
          throw engineError("INVALID", "engine.logins.tooMany", { max: config.maxPerProject });
        }
        // The site must be the one open right now (see the header). Before any secret moves.
        const open = await openOrigin(projectId);
        if (open !== origin) throw saveOriginMismatch(origin, open);
        const id = existing?.id ?? newId();
        const ref = refOf(projectId, id);
        try {
          await keychain.set(ref, password);
        } catch (err) {
          throw asEngineError(err);
        }
        const at = now().toISOString();
        const label = input.label ?? existing?.label;
        const login: SavedLogin = { id, projectId, origin, username, ...(label !== undefined ? { label } : {}), createdAt: existing?.createdAt ?? at, updatedAt: at };
        try {
          store.upsertLogin(login);
        } catch (err) {
          // A secret nobody can name any more must not stay behind.
          if (!existing) await keychain.delete(ref).catch(() => {});
          throw err;
        }
        logger.info("login saved", { projectId, loginId: id, created: !existing });
        await retryOrphans();
        return login;
      });
    },

    delete(id) {
      return serial(async () => {
        const login = store.getLogin(id);
        if (!login) throw engineError("NOT_FOUND", "engine.logins.notFound");
        try {
          await keychain.delete(refOf(login.projectId, login.id));
        } catch (err) {
          throw asEngineError(err);
        }
        store.removeLogin(id);
        logger.info("login deleted", { projectId: login.projectId, loginId: id });
        await retryOrphans();
      });
    },

    policy: policyOf,

    async setRisk(projectId, accepted) {
      store.setLoginRiskAccepted(projectId, accepted);
      logger.info("login agent risk", { projectId, accepted });
      return policyOf(projectId);
    },

    async fill(projectId, id, opts = {}) {
      const known = store.getLogin(id);
      // A login of another project does not exist as far as this project is concerned.
      if (!known || known.projectId !== projectId) throw engineError("NOT_FOUND", "engine.logins.notFound");
      // The user's informed "yes" — checked before anything is read or touched.
      if (!store.isLoginRiskAccepted(projectId)) throw engineError("LOGIN_RISK_UNACCEPTED", TEXT.riskFirst);
      if (opts.confirmAgentRisk !== true && (await agentsPresent(projectId))) throw engineError("LOGIN_RISK_UNACCEPTED", TEXT.riskNow);
      // One read — one dialog — per login at a time, and none right after a "no".
      if (reading.has(id)) throw engineError("KEYCHAIN_FAILED", TEXT.waiting);
      const wait = (coolUntil.get(id) ?? 0) - now().getTime();
      if (wait > 0) throw engineError("KEYCHAIN_FAILED", TEXT.cooldown, { count: Math.ceil(wait / MS_PER_S) });
      reading.add(id);
      return serial(async () => {
        const login = store.getLogin(id);
        if (!login || login.projectId !== projectId) throw engineError("NOT_FOUND", "engine.logins.notFound");
        if (!deps.page) throw engineError("INVALID", "engine.logins.noBrowser");
        const page = deps.page;
        allowFill(projectId);
        const world = config.fillWorldName;
        // 1. Which site is open NOW (not when the app drew its list)? No secret is involved yet: a wrong site
        //    never even reaches the Keychain.
        const open = await openOrigin(projectId);
        if (open !== login.origin) throw originMismatch(login.origin, open);
        // 2. The secret, straight from the Keychain…
        let secret: string;
        try {
          secret = await keychain.get(refOf(projectId, id));
        } catch (err) {
          if (err instanceof KeychainError && (err.kind === "denied" || err.kind === "timeout") && config.denyCooldownMs > 0) {
            coolUntil.set(id, now().getTime() + config.denyCooldownMs);
          }
          throw asEngineError(err);
        }
        // 3. …into the page, which checks its origin once more in the same step.
        const answer = await page.callIsolated(projectId, {
          worldName: world,
          functionDeclaration: LOGIN_FILL_FUNCTION,
          args: [login.origin, login.username, secret, config.fillFrameDepth],
        });
        const filled = parseFill(answer, login.origin);
        logger.info("login filled", { projectId, loginId: id, fields: filled });
        await retryOrphans();
        return filled;
      }).finally(() => reading.delete(id));
    },

    forgetProject(projectId) {
      const logins = store.listLogins(projectId);
      fillTimes.delete(projectId);
      store.setLoginRiskAccepted(projectId, false);
      if (logins.length === 0) return;
      const refs: KeychainItemRef[] = [];
      for (const login of logins) {
        store.removeLogin(login.id);
        try {
          refs.push(keychainRef(config, projectId, login.id));
        } catch {
          // An id that cannot name an item never had one.
        }
      }
      void serial(async () => {
        const failed: KeychainItemRef[] = [];
        for (const ref of refs) {
          try {
            await keychain.delete(ref);
          } catch {
            failed.push(ref);
          }
        }
        if (failed.length > 0) {
          store.setLoginOrphans([...store.listLoginOrphans(), ...failed]);
          logger.warn("keychain items of a deleted project could not be deleted yet; will retry", { projectId, count: failed.length });
        }
        logger.info("logins of a deleted project removed", { projectId, count: logins.length, pending: failed.length });
      }).catch((err: unknown) => {
        logger.error("removing a deleted project's logins failed", { projectId, err: err instanceof Error ? err.name : "error" });
      });
    },

    idle: () => queue.then(() => {}),
  };
}
