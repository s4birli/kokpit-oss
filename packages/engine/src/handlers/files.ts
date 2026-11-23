// İş F — Dosyalar: files.list / files.read / files.mediaUrl. Picks the folder (card worktree or project folder on
// this machine); FileService keeps every access inside it. A media URL belongs to the connection that asked.
// Yollar: files.locate / files.previewUrl — a path a terminal printed, resolved on this machine (handlers/paths.ts).
import { projectGitPath, type Card, type ParamsOf, type Project, type ResultOf } from "@kokpit/shared";
import type { PathActions } from "./paths.ts";
import { engineError } from "../contracts.ts";
import type { FileService } from "../files.ts";
import type { MediaService } from "../files-media.ts";

export interface FilesHandlerDeps {
  /** Absent = files disabled: every request answers INVALID. */
  files: FileService | undefined;
  /** Absent = no in-app media: files.mediaUrl answers INVALID. */
  media?: MediaService | undefined;
  requireProject(projectId: string): Project;
  requireCard(cardId: string): Card;
  /** Yollar. Absent = those requests answer INVALID. */
  paths?: PathActions | undefined;
}

type Target = { projectId?: string | undefined; cardId?: string | undefined };

export function createFilesHandlers<C extends { conn: object }>(deps: FilesHandlerDeps) {
  function service(): FileService {
    if (!deps.files) throw engineError("INVALID", "engine.handlers.files.off");
    return deps.files;
  }

  function paths(): PathActions {
    if (!deps.paths) throw engineError("INVALID", "engine.handlers.files.noPaths");
    return deps.paths;
  }

  /** The folder a request browses. Cards: their worktree; projects: their folder on the engine machine. */
  function rootOf(t: Target): string {
    if (t.cardId !== undefined) {
      const card = deps.requireCard(t.cardId);
      deps.requireProject(card.projectId);
      return card.worktreePath;
    }
    const project = deps.requireProject(t.projectId ?? "");
    if (project.location.kind === "ssh") {
      throw engineError("INVALID", "engine.handlers.files.ssh");
    }
    const root = projectGitPath(project);
    if (root === null) {
      throw project.location.kind === "github"
        ? engineError("NOT_FOUND", "engine.handlers.files.notCloned")
        : engineError("INVALID", "engine.handlers.files.noFolder");
    }
    return root;
  }

  return {
    "files.list": (_ctx: unknown, p: ParamsOf<"files.list">): ResultOf<"files.list"> => {
      const files = service();
      return files.list(rootOf(p), p.path);
    },
    "files.read": (_ctx: unknown, p: ParamsOf<"files.read">): ResultOf<"files.read"> => {
      const files = service();
      return files.read(rootOf(p), p.path);
    },
    "files.mediaUrl": (ctx: C, p: ParamsOf<"files.mediaUrl">): ResultOf<"files.mediaUrl"> => {
      service();
      if (!deps.media) throw engineError("INVALID", "engine.handlers.files.noMedia");
      return deps.media.issue(ctx.conn, rootOf(p), p.path);
    },
    "files.mediaRevoke": (ctx: C, p: ParamsOf<"files.mediaRevoke">): ResultOf<"files.mediaRevoke"> => {
      deps.media?.revoke(ctx.conn, p.path);
      return {};
    },
    "files.locate": async (_ctx: unknown, p: ParamsOf<"files.locate">): Promise<ResultOf<"files.locate">> => (await paths().locate(p)).location,
    "files.previewUrl": (_ctx: unknown, p: ParamsOf<"files.previewUrl">): Promise<ResultOf<"files.previewUrl">> => paths().previewUrl(p),
    "files.previewRevoke": (_ctx: unknown, p: ParamsOf<"files.previewRevoke">): ResultOf<"files.previewRevoke"> => {
      deps.paths?.revoke(p.path);
      return {};
    },
  };
}
