// Cards = one git worktree + branch per card, under DataPaths.worktreesDir.
// Creates and deletes are serialized per project so slug allocation and
// worktree bookkeeping never race.
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { projectGitPath, type Card, type Project } from "@kokpit/shared";
import {
  EngineError,
  engineError,
  type CardService,
  type DataPaths,
  type EngineConfig,
  type Logger,
  type StateStore,
} from "./contracts.ts";
import * as git from "./git.ts";
import { slugify } from "./slug.ts";

/** How many dirty paths a DIRTY_WORKTREE message names before summarising the rest. */
export const DEFAULT_DIRTY_LIST_LIMIT = 10;

const NOT_A_REPO_MESSAGE = "engine.cards.notARepo";

export interface CardServiceDeps {
  config: EngineConfig;
  paths: DataPaths;
  store: StateStore;
  logger: Logger;
  /** Runs before the worktree is removed (closes the card's terminals). */
  onBeforeRemove?: (cardId: string) => void | Promise<void>;
  newId?: () => string;
  now?: () => Date;
  slugMaxLen: number;
  slugFallback: string;
  dirtyListLimit?: number;
}

function gitFailed(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  if (err instanceof git.GitError) return new EngineError("GIT_FAILED", err.stderr.trim() || err.message);
  return new EngineError("GIT_FAILED", err instanceof Error ? err.message : String(err));
}

export function createCardService(deps: CardServiceDeps): CardService {
  const { config, paths, store, logger, slugMaxLen, slugFallback } = deps;
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());
  const dirtyListLimit = deps.dirtyListLimit ?? DEFAULT_DIRTY_LIST_LIMIT;
  const worktreesRoot = resolve(paths.worktreesDir);
  const locks = new Map<string, Promise<unknown>>();

  function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    locks.set(projectId, settled);
    void settled.then(() => {
      if (locks.get(projectId) === settled) locks.delete(projectId);
    });
    return next;
  }

  /** The project and its git repo on this machine; ssh projects have no repo here, so no cards. */
  function findProject(projectId: string): { project: Project; repo: string } {
    const project = store.getProject(projectId);
    if (!project) throw engineError("NOT_FOUND", "engine.cards.projectNotFound", { projectId });
    const repo = projectGitPath(project);
    if (repo === null) throw engineError("INVALID", "engine.cards.noCardsOnSsh", { project: project.name });
    return { project, repo };
  }

  function worktreePathFor(project: Project, slug: string): string {
    const p = resolve(worktreesRoot, project.id, slug);
    const rel = relative(worktreesRoot, p);
    if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).length !== 2) {
      throw engineError("INVALID", "engine.cards.worktreeOutside", { projectId: project.id });
    }
    return p;
  }

  async function allocate(
    project: Project,
    repo: string,
    base: string,
  ): Promise<{ slug: string; path: string; branch: string }> {
    const taken = new Set<string>();
    for (const c of store.listCards(project.id)) {
      taken.add(c.branch);
      taken.add(resolve(c.worktreePath));
    }
    for (let n = 1; ; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const branch = `${config.branchPrefix}${slug}`;
      const path = worktreePathFor(project, slug);
      if (taken.has(branch) || taken.has(path) || existsSync(path)) continue;
      if (await git.branchExists(repo, branch)) continue;
      return { slug, path, branch };
    }
  }

  async function create(projectId: string, name: string): Promise<Card> {
    const { project, repo } = findProject(projectId);
    if (!(await git.isInsideWorkTree(repo))) throw engineError("INVALID", NOT_A_REPO_MESSAGE);
    return withProjectLock(project.id, async () => {
      const slug = slugify(name, slugMaxLen, slugFallback);
      let target: { path: string; branch: string } | undefined;
      try {
        const base = config.baseBranch ?? (await git.defaultBranch(repo));
        target = await allocate(project, repo, slug);
        await git.worktreeAdd(repo, target.path, target.branch, base);
      } catch (err) {
        if (target && existsSync(target.path)) {
          // We verified the path did not exist before; remove what the failed add left behind.
          rmSync(target.path, { recursive: true, force: true });
          await git.worktreePrune(repo).catch(() => undefined);
        }
        throw gitFailed(err);
      }
      const card: Card = {
        id: newId(),
        projectId: project.id,
        name,
        branch: target.branch,
        worktreePath: target.path,
        createdAt: now().toISOString(),
      };
      store.addCard(card);
      logger.info("kart oluşturuldu", { cardId: card.id, projectId: project.id, branch: card.branch });
      return card;
    });
  }

  async function remove(cardId: string): Promise<void> {
    const initial = store.getCard(cardId);
    if (!initial) throw engineError("NOT_FOUND", "engine.cards.cardNotFound", { cardId });
    return withProjectLock(initial.projectId, async () => {
      const card = store.getCard(cardId);
      if (!card) throw engineError("NOT_FOUND", "engine.cards.cardNotFound", { cardId });
      const { repo } = findProject(card.projectId);

      if (!existsSync(card.worktreePath)) {
        logger.warn("kart worktree klasörü yok, kayıt siliniyor", { cardId, worktreePath: card.worktreePath });
        await deps.onBeforeRemove?.(cardId);
        await git.worktreePrune(repo).catch((err: unknown) =>
          logger.warn("git worktree prune başarısız", { cardId, error: gitFailed(err).message }),
        );
        store.removeCard(cardId);
        return;
      }

      let entries: git.StatusEntry[];
      try {
        entries = await git.statusPorcelain(card.worktreePath);
      } catch (err) {
        throw gitFailed(err);
      }
      if (entries.length > 0) {
        const shown = entries.slice(0, dirtyListLimit).map((e) => e.path);
        const more = entries.length - shown.length;
        throw more > 0
          ? engineError("DIRTY_WORKTREE", "engine.cards.dirtyMore", { paths: shown.join(", "), more })
          : engineError("DIRTY_WORKTREE", "engine.cards.dirty", { paths: shown.join(", ") });
      }

      await deps.onBeforeRemove?.(cardId);
      try {
        await git.worktreeRemove(repo, card.worktreePath);
        await git.worktreePrune(repo);
      } catch (err) {
        throw gitFailed(err);
      }
      store.removeCard(cardId);
      logger.info("kart silindi", { cardId, branch: card.branch });
    });
  }

  return {
    list: (projectId) => store.listCards(projectId),
    create,
    delete: remove,
  };
}
