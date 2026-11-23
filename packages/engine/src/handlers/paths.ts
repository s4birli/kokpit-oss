// Yollar: one place that turns "a path a terminal printed" into what the engine does with it — for the app's
// requests (files.locate, files.previewUrl, browser.openFile) and for `open` run inside a terminal (terminal-open.ts).
//
// Whose path it is decides where it is looked for and what it may open into: a terminal (its project, its card, its
// current directory), a card, or a project. SSH projects (and kinds without a folder) are refused: their files are not on this machine.
import { projectGitPath, type Card, type FileLocation, type FilePreviewUrl, type LocalPathRef, type Project, type TerminalInfo } from "@kokpit/shared";
import { EngineError, engineError } from "../contracts.ts";
import type { PreviewService } from "../files-preview.ts";
import type { CwdLookup, PathLocator, PathOwner } from "../local-paths.ts";
import { urlHost } from "../net.ts";

export interface PathActionsDeps {
  locator: PathLocator;
  preview: PreviewService;
  cwd: CwdLookup;
  requireProject(projectId: string): Project;
  requireCard(cardId: string): Card;
  /** The terminal, or undefined when there is none with that id. */
  terminal(terminalId: string): TerminalInfo | undefined;
  /** Process id of the terminal's shell, when it runs. */
  terminalPid(terminalId: string): number | undefined;
  /** Where a browser on this machine reaches the engine's listener. */
  localAddress(): { host: string; port: number } | undefined;
}

export interface PathActions {
  /** What the path points at. Throws EngineError: NOT_FOUND (nothing there), INVALID (SSH project, no folder here). */
  locate(ref: LocalPathRef): Promise<{ project: Project; location: FileLocation; roots: readonly string[] }>;
  /** A preview address (path only) for the file. Throws EngineError with the refusal. */
  previewUrl(ref: LocalPathRef): Promise<FilePreviewUrl>;
  /** The same as a full address for the project's Chrome on this machine. */
  engineUrl(ref: LocalPathRef): Promise<{ projectId: string; url: string }>;
  revoke(urlPath: string): void;
}


export function createPathActions(deps: PathActionsDeps): PathActions {
  async function ownerOf(ref: LocalPathRef): Promise<{ project: Project; owner: PathOwner }> {
    let project: Project;
    let card: Card | undefined;
    let cwd: string | undefined;
    if (ref.terminalId !== undefined) {
      const terminal = deps.terminal(ref.terminalId);
      if (!terminal) throw new EngineError("NOT_FOUND", `terminal ${ref.terminalId} not found`);
      project = deps.requireProject(terminal.projectId);
      card = terminal.cardId !== undefined ? deps.requireCard(terminal.cardId) : undefined;
    } else if (ref.cardId !== undefined) {
      card = deps.requireCard(ref.cardId);
      project = deps.requireProject(card.projectId);
    } else {
      project = deps.requireProject(ref.projectId ?? "");
    }
    if (project.location.kind === "ssh") throw engineError("INVALID", "engine.handlers.paths.remote");
    if (ref.terminalId !== undefined) {
      const pid = deps.terminalPid(ref.terminalId);
      cwd = pid === undefined ? undefined : await deps.cwd.cwdOf(pid);
    }
    const projectRoot = projectGitPath(project);
    const root = card?.worktreePath ?? projectRoot;
    const roots = [card?.worktreePath, projectRoot].filter((r): r is string => typeof r === "string");
    return { project, owner: { root, roots, cwd, ...(card ? { cardId: card.id } : {}) } };
  }

  async function locate(ref: LocalPathRef) {
    const { project, owner } = await ownerOf(ref);
    return { project, location: deps.locator.locate(owner, ref), roots: owner.roots };
  }

  async function previewUrl(ref: LocalPathRef, guard?: (project: Project) => void): Promise<FilePreviewUrl & { projectId: string }> {
    const { project, location, roots } = await locate(ref);
    guard?.(project);
    if (!location.browser) throw location.browserRefusal !== undefined ? new EngineError("INVALID", location.browserRefusal) : engineError("INVALID", "engine.handlers.paths.unsupported");
    return { ...deps.preview.issue(project.id, location.path, roots), projectId: project.id };
  }

  return {
    locate,
    async previewUrl(ref) {
      const { projectId: _projectId, ...url } = await previewUrl(ref);
      return url;
    },
    async engineUrl(ref) {
      const address = deps.localAddress();
      if (!address) throw engineError("INVALID", "engine.handlers.paths.notListening");
      // Refused before anything is issued: that Chrome runs on another machine.
      const { projectId, path } = await previewUrl(ref, (project) => {
        if (project.browser?.runOn === "client") throw engineError("INVALID", "engine.handlers.paths.clientBrowser");
      });
      return { projectId, url: `http://${urlHost(address.host)}:${address.port}${path}` };
    },
    revoke: (urlPath) => deps.preview.revoke(urlPath),
  };
}
