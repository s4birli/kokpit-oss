// İş F — in-memory files.* for FakeEngineClient. One tree per target key ("p:<projectId>" / "c:<cardId>");
// a target without a tree gets `tree` (the default one). Paths are "/"-separated; a key ending in "/" is an
// (empty) folder, parents are implied.
import { FILES_MEDIA_HTTP_PREFIX, FILES_PREVIEW_HTTP_PREFIX, type FileEntry, type FileLocation, type FileMediaKind, type ParamsOf, type ResultOf } from "@kokpit/shared";
import { EngineRequestError } from "../../engine/types.ts";

export type FakeFile =
  | string
  | { binary: true; size: number; media?: FileMediaKind; mime?: string }
  | { text: string; size: number; truncated: true }
  | { text: string; media: FileMediaKind; mime?: string };
export type FakeTree = Record<string, FakeFile>;

type FilesMethod = "files.list" | "files.read" | "files.mediaUrl" | "files.mediaRevoke" | "files.locate" | "files.previewUrl" | "files.previewRevoke";
type Handlers = { [M in FilesMethod]: (params: ParamsOf<M>) => ResultOf<M> };

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

export class FakeFiles {
  tree: FakeTree = {};
  readonly trees: Record<string, FakeTree> = {};
  /** Media URL paths handed out and not yet revoked (issue order). */
  readonly mediaUrls: string[] = [];
  private mediaSeq = 0;
  /** Yollar: path as written → what the engine would say; a string is the refusal (INVALID). Others: NOT_FOUND. */
  locations: Record<string, FileLocation | string> = {};
  /** Yollar: every files.locate request, oldest first. */
  readonly located: ParamsOf<"files.locate">[] = [];
  /** Yollar: preview addresses handed out and not yet revoked. */
  readonly previewUrls: string[] = [];

  private treeFor(p: { projectId?: string | undefined; cardId?: string | undefined }): FakeTree {
    const key = p.cardId !== undefined ? `c:${p.cardId}` : `p:${p.projectId ?? ""}`;
    return this.trees[key] ?? this.tree;
  }

  private static norm(path: string): string {
    if (path.startsWith("/") || path.split("/").includes("..")) throw new EngineRequestError("INVALID", "Yol proje klasörünün dışına çıkıyor");
    return path.split("/").filter((s) => s !== "" && s !== ".").join("/");
  }

  private static isDir(tree: FakeTree, dir: string): boolean {
    if (dir === "") return true;
    return Object.keys(tree).some((k) => k.startsWith(`${dir}/`));
  }

  readonly handlers: Handlers = {
    "files.list": (p) => {
      const tree = this.treeFor(p);
      const dir = FakeFiles.norm(p.path);
      if (tree[dir] !== undefined) throw new EngineRequestError("INVALID", "Bu bir klasör değil");
      if (!FakeFiles.isDir(tree, dir)) throw new EngineRequestError("NOT_FOUND", "Dosya ya da klasör bulunamadı");
      const prefix = dir === "" ? "" : `${dir}/`;
      const seen = new Map<string, FileEntry>();
      for (const [key, file] of Object.entries(tree)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest === "") continue;
        const [name, ...more] = rest.split("/");
        if (!name) continue;
        if (more.length > 0) seen.set(name, { name, kind: "dir" });
        else if (!seen.has(name)) seen.set(name, { name, kind: "file", size: fileSize(file) });
      }
      const entries = [...seen.values()].sort(
        (a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name),
      );
      return { entries, truncated: false };
    },
    "files.read": (p) => {
      const tree = this.treeFor(p);
      const path = FakeFiles.norm(p.path);
      const file = tree[path];
      if (file === undefined) {
        if (FakeFiles.isDir(tree, path)) throw new EngineRequestError("INVALID", "Yalnız dosyalar önizlenir");
        throw new EngineRequestError("NOT_FOUND", "Dosya ya da klasör bulunamadı");
      }
      if (typeof file === "string") return { text: file, size: byteLength(file), truncated: false };
      if ("binary" in file) return { binary: true, size: file.size, truncated: false, ...(file.media ? { media: file.media } : {}) };
      if ("media" in file) return { text: file.text, size: byteLength(file.text), truncated: false, media: file.media };
      return { text: file.text, size: file.size, truncated: true };
    },
    "files.mediaUrl": (p) => {
      const file = this.treeFor(p)[FakeFiles.norm(p.path)];
      if (file === undefined) throw new EngineRequestError("NOT_FOUND", "Dosya ya da klasör bulunamadı");
      if (typeof file === "string" || !("media" in file) || file.media === undefined) {
        throw new EngineRequestError("INVALID", "Bu dosya türü Kokpit'te açılamıyor");
      }
      const path = `${FILES_MEDIA_HTTP_PREFIX}${String(++this.mediaSeq).padStart(43, "t")}`;
      this.mediaUrls.push(path);
      return { path, kind: file.media, mime: file.mime ?? `${file.media}/x-test`, size: fileSize(file), expiresAt: new Date(0).toISOString() };
    },
    "files.mediaRevoke": (p) => {
      const at = this.mediaUrls.indexOf(p.path);
      if (at >= 0) this.mediaUrls.splice(at, 1);
      return {};
    },
    "files.locate": (p) => {
      this.located.push(p);
      const found = this.locations[p.path];
      if (found === undefined) throw new EngineRequestError("NOT_FOUND", "Dosya bulunamadı");
      if (typeof found === "string") throw new EngineRequestError("INVALID", found);
      return found;
    },
    "files.previewUrl": (p) => {
      const found = this.locations[p.path];
      if (found === undefined) throw new EngineRequestError("NOT_FOUND", "Dosya bulunamadı");
      if (typeof found === "string" || !found.browser) throw new EngineRequestError("INVALID", typeof found === "string" ? found : (found.browserRefusal ?? "Bu dosya türü tarayıcıda önizlenemez"));
      const path = `${FILES_PREVIEW_HTTP_PREFIX}${String(this.previewUrls.length + 1).padStart(43, "p")}/${found.path.slice(found.path.lastIndexOf("/") + 1)}`;
      this.previewUrls.push(path);
      return { path, single: false, expiresAt: "2026-11-18T00:30:00.000Z" };
    },
    "files.previewRevoke": ({ path }) => {
      const at = this.previewUrls.indexOf(path);
      if (at >= 0) this.previewUrls.splice(at, 1);
      return {};
    },
  };
}

function fileSize(file: FakeFile): number {
  if (typeof file === "string") return byteLength(file);
  return "size" in file ? file.size : byteLength(file.text);
}
