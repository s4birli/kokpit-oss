// Projects = named locations (a local folder, a github clone, a folder on an ssh host).
// Records live in the StateStore. Deleting a project only removes the record; files,
// clones and worktrees are never touched.
import { mkdirSync, rmSync, statSync } from "node:fs";
import { PRIVATE_DIR_MODE } from "./fs-safety.ts";
import { join, resolve } from "node:path";
import {
  RequestParams,
  type ClientProjectLocation,
  type ParamsOf,
  type Project,
  type ProjectBrowser,
  type ProjectLocation,
  type SshHost,
  type Tool,
} from "@kokpit/shared";
import type { z } from "zod";
import { st } from "@kokpit/shared/i18n";
import {
  EngineError,
  engineError,
  type DataPaths,
  type EngineConfig,
  type HostPaths,
  type Logger,
  type ProjectService,
  type StateStore,
} from "./contracts.ts";
import type { EngineTunables } from "./config.ts";
import { slugify } from "./slug.ts";

/** StateStore seed keys (see StateStore.isSeeded). */
export const SEED_BUILTIN_PROJECT = "builtin-project";
export const SEED_CONFIG_PROJECTS = "config-projects";

export interface ProjectServiceDeps {
  config: Pick<EngineConfig, "projects"> & {
    tunables: Pick<EngineTunables, "slugMaxLen" | "slugFallback" | "builtinProjectId" | "builtinProjectName">;
  };
  paths: Pick<DataPaths, "reposDir">;
  hostPaths: Pick<HostPaths, "homeDir">;
  store: StateStore;
  logger: Logger;
  sshHosts: { get(hostId: string): SshHost | undefined };
  tools: { get(toolId: string): Tool | undefined };
  /** main.ts binds the timeout: `(url, dest) => git.clone(url, dest, tunables.gitCloneTimeoutMs)`. */
  git: { clone(url: string, dest: string): Promise<void> };
  /** Runs right before the record is removed (main.ts closes the project's terminals here). */
  onBeforeDelete?: (projectId: string) => void;
  /**
   * Adım 9 İş A: runs after an update is stored (main.ts brings the project's Claude settings file in line).
   * A throw is logged; the update stands.
   */
  onAfterUpdate?: (next: Project, previous: Project) => void;
  /** İş B: built-in "Browser tasks" project (seeded once; its folder is created under dataDir). */
  browserProject?: { id: string; name: string; path: string };
  /** İş H: Claude accounts a project may pick (`claudeAccountId`). Absent = any id is refused. */
  claudeAccounts?: { get(id: string): unknown };
}

/** İş B seed key. */
export const SEED_BROWSER_PROJECT = "browser-project";

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.map(String).join(".");
    const detail = issue?.message ?? st("engine.projects.invalid");
    throw where ? engineError("INVALID", "engine.projects.badRequestAt", { field: where, detail }) : engineError("INVALID", "engine.projects.badRequest", { detail });
  }
  return r.data;
}

/**
 * A REMOTE path as the user gave it: never resolved with this machine's path rules (`..`, symlinks and the
 * remote's layout are the remote's business); only trailing slashes go, and "/" stays "/".
 */
function trimTrailingSlashes(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t === "" ? "/" : t;
}

function cloneFailure(err: unknown): EngineError {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const msg = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : (err as Error)?.message;
  return engineError("GIT_FAILED", "engine.projects.cloneFailed", { reason: msg ?? String(err) });
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const { config, paths, hostPaths, store, logger } = deps;
  const { slugMaxLen, slugFallback, builtinProjectId, builtinProjectName } = config.tunables;
  /** Ids handed out to creates that are still cloning; keeps concurrent creates apart. */
  const reserved = new Set<string>();

  function requireTool(toolId: string): void {
    if (!deps.tools.get(toolId)) throw engineError("NOT_FOUND", "engine.projects.toolNotFound", { id: toolId });
  }

  /** İş H */
  function requireAccount(accountId: string): void {
    if (!deps.claudeAccounts?.get(accountId)) throw engineError("NOT_FOUND", "engine.projects.accountNotFound", { id: accountId });
  }

  function requireProject(projectId: string): Project {
    const p = store.getProject(projectId);
    if (!p) throw engineError("NOT_FOUND", "engine.projects.notFound", { id: projectId });
    return p;
  }

  function requireDirectory(path: string): void {
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      throw engineError("INVALID", "engine.projects.folderNotFound", { path });
    }
    if (!isDir) throw engineError("INVALID", "engine.projects.notAFolder", { path });
  }

  /** A non-github client location as stored: local paths resolved, remote paths only trimmed. Pure (no checks). */
  function normalizeLocation(loc: Exclude<ClientProjectLocation, { kind: "github" }>): ProjectLocation {
    if (loc.kind === "local") return { kind: "local", path: resolve(loc.path) };
    if (loc.kind === "ssh") {
      return loc.path === undefined ? { kind: "ssh", hostId: loc.hostId } : { kind: "ssh", hostId: loc.hostId, path: trimTrailingSlashes(loc.path) };
    }
    return loc;
  }

  /** The location must be usable now: a local folder exists, an ssh host is known (URLs: checked by the schema). */
  function requireLocation(loc: ProjectLocation): void {
    if (loc.kind === "local") requireDirectory(loc.path);
    if (loc.kind === "ssh" && !deps.sshHosts.get(loc.hostId)) {
      throw engineError("NOT_FOUND", "engine.projects.sshHostNotFound", { id: loc.hostId });
    }
  }

  /**
   * İş P: the location `update` should store, or undefined when it does not change. Running terminals keep their
   * old place (their process already runs there); terminals opened afterwards resolve the new one.
   */
  function nextLocation(current: Project, wanted: ClientProjectLocation | undefined): ProjectLocation | undefined {
    if (wanted === undefined) return undefined;
    if (current.location.kind === "github" || wanted.kind === "github") {
      if (current.location.kind === "github" && wanted.kind === "github" && wanted.url === current.location.url) return undefined;
      throw engineError("INVALID", current.location.kind === "github" ? "engine.projects.githubLocationFixed" : "engine.projects.cannotBecomeGithub");
    }
    const location = normalizeLocation(wanted);
    if (JSON.stringify(location) === JSON.stringify(current.location)) return undefined;
    if (current.builtin) throw engineError("INVALID", "engine.projects.builtinLocationFixed", { name: current.name });
    const cards = store.listCards(current.id).length;
    if (cards > 0) throw engineError("INVALID", "engine.projects.hasCards", { count: cards });
    requireLocation(location);
    return location;
  }

  /** Free id from the name; for github also free on disk (an existing dir is never reused or deleted). */
  function allocateId(name: string, needsCloneDir: boolean): string {
    const base = slugify(name, slugMaxLen, slugFallback);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (store.getProject(id) || reserved.has(id)) continue;
      if (needsCloneDir && exists(join(paths.reposDir, id))) continue;
      return id;
    }
  }

  async function init(): Promise<void> {
    if (!store.isSeeded(SEED_BUILTIN_PROJECT)) {
      if (!store.getProject(builtinProjectId)) {
        store.upsertProject({
          id: builtinProjectId,
          name: builtinProjectName,
          location: { kind: "local", path: hostPaths.homeDir },
          builtin: true,
        });
      }
      store.markSeeded(SEED_BUILTIN_PROJECT);
    }
    const bp = deps.browserProject;
    // The folder is (re)created on every start so the project's terminals always have somewhere to open.
    if (bp && !exists(bp.path)) mkdirSync(bp.path, { mode: PRIVATE_DIR_MODE });
    if (bp && !store.isSeeded(SEED_BROWSER_PROJECT)) {
      if (!store.getProject(bp.id)) {
        store.upsertProject({ id: bp.id, name: bp.name, location: { kind: "local", path: bp.path }, builtin: true });
      }
      store.markSeeded(SEED_BROWSER_PROJECT);
    }
    if (!store.isSeeded(SEED_CONFIG_PROJECTS)) {
      for (const p of config.projects) {
        if (store.getProject(p.id)) {
          logger.warn("config projesi zaten kayıtlı, atlandı", { projectId: p.id });
          continue;
        }
        store.upsertProject(p);
      }
      store.markSeeded(SEED_CONFIG_PROJECTS);
    }
  }

  async function create(raw: ParamsOf<"projects.create">): Promise<Project> {
    const input = parse(RequestParams["projects.create"], raw);
    if (input.defaultToolId !== undefined) requireTool(input.defaultToolId);
    if (input.claudeAccountId !== undefined) requireAccount(input.claudeAccountId);
    const loc = input.location;
    // Optional fields every new project record carries over (`browser`: İş B, `claudeAccountId`: İş H).
    const tool = {
      ...(input.defaultToolId === undefined ? {} : { defaultToolId: input.defaultToolId }),
      ...(input.browser === undefined ? {} : { browser: nextBrowser(undefined, input.browser) }),
      ...(input.claudeAccountId === undefined ? {} : { claudeAccountId: input.claudeAccountId }),
      ...(input.claudeBrowserEnv === undefined ? {} : { claudeBrowserEnv: input.claudeBrowserEnv }),
    };

    if (loc.kind !== "github") {
      const location = normalizeLocation(loc);
      requireLocation(location);
      const project: Project = { id: allocateId(input.name, false), name: input.name, location, ...tool };
      store.upsertProject(project);
      logger.info("proje oluşturuldu", { projectId: project.id, kind: loc.kind });
      return project;
    }

    const id = allocateId(input.name, true);
    const dest = join(paths.reposDir, id);
    reserved.add(id);
    try {
      try {
        await deps.git.clone(loc.url, dest);
      } catch (err) {
        // allocateId verified dest did not exist, so whatever is there now is the failed clone's.
        rmSync(dest, { recursive: true, force: true });
        throw cloneFailure(err);
      }
      // Tool or record may have changed while cloning.
      if (input.defaultToolId !== undefined && !deps.tools.get(input.defaultToolId)) {
        rmSync(dest, { recursive: true, force: true });
        throw engineError("NOT_FOUND", "engine.projects.toolNotFound", { id: input.defaultToolId });
      }
      const project: Project = { id, name: input.name, location: { kind: "github", url: loc.url, path: dest }, ...tool };
      try {
        store.upsertProject(project);
      } catch (err) {
        rmSync(dest, { recursive: true, force: true });
        throw err;
      }
      logger.info("proje klonlandı", { projectId: id, dest });
      return project;
    } finally {
      reserved.delete(id);
    }
  }

  /**
   * `browser` as sent, except that a request naming no `window` keeps the project's (an app that only knows `runOn`
   * must not bring a hidden browser's window back, or hide a shown one). "hidden" is the default: not stored.
   */
  function nextBrowser(current: ProjectBrowser | undefined, input: ProjectBrowser): ProjectBrowser {
    const window = input.window ?? current?.window;
    return { runOn: input.runOn, ...(window === undefined || window === "hidden" ? {} : { window }) };
  }

  function update(raw: ParamsOf<"projects.update">): Project {
    const input = parse(RequestParams["projects.update"], raw);
    const current = requireProject(input.projectId);
    if (typeof input.defaultToolId === "string") requireTool(input.defaultToolId);
    if (typeof input.claudeAccountId === "string") requireAccount(input.claudeAccountId);
    const { defaultToolId: _old, claudeAccountId: _oldAccount, openInBrowser: _oldOpen, ...rest } = current;
    // Yollar: on unless turned off; stored only while off.
    const openInBrowser = input.openInBrowser ?? current.openInBrowser !== false;
    const toolId = input.defaultToolId === undefined ? current.defaultToolId : (input.defaultToolId ?? undefined);
    const accountId = input.claudeAccountId === undefined ? current.claudeAccountId : (input.claudeAccountId ?? undefined);
    const location = nextLocation(current, input.location);
    const next: Project = {
      ...rest,
      ...(location === undefined ? {} : { location }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(toolId === undefined ? {} : { defaultToolId: toolId }),
      ...(input.browser === undefined ? {} : { browser: nextBrowser(current.browser, input.browser) }),
      ...(accountId === undefined ? {} : { claudeAccountId: accountId }),
      ...(input.claudeBrowserEnv === undefined ? {} : { claudeBrowserEnv: input.claudeBrowserEnv }),
      ...(openInBrowser ? {} : { openInBrowser: false }),
    };
    store.upsertProject(next);
    if (location !== undefined) logger.info("proje konumu değişti", { projectId: next.id, kind: location.kind });
    try {
      deps.onAfterUpdate?.(next, current);
    } catch (err) {
      logger.warn("proje güncellemesi sonrası iş başarısız", { projectId: next.id, err: err instanceof Error ? err.message : String(err) });
    }
    return next;
  }

  function remove(projectId: string): void {
    const project = requireProject(projectId);
    if (project.builtin) throw engineError("INVALID", "engine.projects.builtinUndeletable", { name: project.name });
    const cards = store.listCards(projectId).length;
    if (cards > 0) throw engineError("INVALID", "engine.projects.hasCards", { count: cards });
    deps.onBeforeDelete?.(projectId);
    store.removeProject(projectId);
    logger.info("proje silindi", { projectId });
  }

  return {
    init,
    list: () => store.listProjects(),
    get: (projectId) => store.getProject(projectId),
    create,
    update,
    delete: remove,
  };
}
