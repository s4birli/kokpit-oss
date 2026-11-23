// Dosyalar: the panel's pure decisions — which viewer a file gets, how tree and preview share the room, the URL a
// media file streams from, and what the player says when it cannot play.
import { FILE_MEDIA_KINDS, isFilesMediaTokenPath, type FileMediaKind, type FileReadResult } from "@kokpit/shared";
import type { UiConfig } from "../config.ts";
import { t, type MessageKey } from "../../../i18n/index.ts";
import { engineHttpUrl } from "../map-url.ts";

/** How a file is shown: text with line numbers, one of the streamed media viewers, or the "binary" note. */
export type Viewer = "text" | "binary" | FileMediaKind;

const isMediaKind = (v: unknown): v is FileMediaKind => (FILE_MEDIA_KINDS as readonly unknown[]).includes(v);

/**
 * The viewer for what `files.read` answered. A media kind wins over text (SVG is text, but is shown as a picture
 * inside <img>, never as markup in this page); a kind this app does not know is ignored.
 */
export function chooseViewer(result: FileReadResult): Viewer {
  if (isMediaKind(result.media)) return result.media;
  return result.text !== undefined && result.binary !== true ? "text" : "binary";
}

/** side: tree | preview next to each other; stacked: tree above the preview. */
export type FilesLayout = "side" | "stacked";

export function filesLayout(width: number, config: Pick<UiConfig, "filesSideBySideMinWidth">): FilesLayout {
  return Number.isFinite(width) && width >= config.filesSideBySideMinWidth ? "side" : "stacked";
}

/** The tree's share of the panel in a layout: the stored value inside the bounds, else the configured default. */
export function clampSplit(stored: unknown, layout: FilesLayout, config: Pick<UiConfig, "filesSplitRatio" | "filesSplitMinRatio">): number {
  const min = config.filesSplitMinRatio;
  const ratio = typeof stored === "number" && Number.isFinite(stored) ? stored : config.filesSplitRatio[layout];
  return Math.min(1 - min, Math.max(min, ratio));
}

/**
 * The engine streams media on the same listener as its WebSocket. Only a well-formed `/files/media/<token>` path
 * is accepted; anything else (absolute URLs, traversal, a query) → null.
 */
export function mediaFileUrl(engineUrl: string | undefined, path: string): string | null {
  return isFilesMediaTokenPath(path) ? engineHttpUrl(engineUrl, path) : null;
}

/** `MediaError.code` values (the DOM constants, named). */
export const MEDIA_ERROR = { aborted: 1, network: 2, decode: 3, unsupported: 4 } as const;

const NOUN: Record<FileMediaKind, MessageKey> = {
  video: "files.media.noun.video",
  audio: "files.media.noun.audio",
  image: "files.media.noun.image",
  pdf: "files.media.noun.pdf",
};

/**
 * What to say when the built-in player gave up on a file the engine has just confirmed to be there and of the
 * right container: a decode / unsupported-source error is a codec the player lacks.
 */
export function mediaFailure(code: number | undefined, file: { kind: FileMediaKind; mime: string; size: string }): string {
  const what = t("files.media.what", { mime: file.mime, size: file.size });
  if (code === MEDIA_ERROR.decode || code === MEDIA_ERROR.unsupported) {
    return t("files.media.codecFailed", { noun: t(NOUN[file.kind]), what });
  }
  return t("files.media.readFailed", { what });
}

/** A video whose picture track the player could not decode (the sound still plays). */
export function noPictureNote(file: { mime: string; size: string }): string {
  return t("files.media.noPicture", { what: t("files.media.what", { mime: file.mime, size: file.size }) });
}
