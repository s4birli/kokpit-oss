// Kendini güncelleme: fetches the archive over HTTP from the engine's listener into a `.part` file, resuming with
// `Range` where an earlier connection stopped. The bytes are not trusted here — verify.ts checks size and SHA-256
// against the manifest afterwards; this only refuses to write more than the manifest's size.
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { t } from "../../i18n/index.ts";

export type DownloadErrorCode = "http" | "network" | "too-large" | "aborted";

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  constructor(code: DownloadErrorCode, message: string) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
  }
}

export interface DownloadInput {
  /** A fresh URL for the archive; asked again before every connection (a URL dies with its WebSocket or when idle). */
  url(): Promise<string>;
  /** The `.part` file; an existing one is continued. */
  partPath: string;
  size: number;
  attempts: number;
  idleTimeoutMs: number;
  onProgress?(received: number): void;
  signal?: AbortSignal;
}

const HTTP_OK = 200;
const HTTP_PARTIAL = 206;
const HTTP_RANGE_NOT_SATISFIABLE = 416;

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** One connection: appends to (or restarts) the part file. Resolves when the response ended. */
function fetchOnce(url: string, i: DownloadInput, have: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      i.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const req = lib.get(target, { agent: false, headers: have > 0 ? { range: `bytes=${have}-` } : {} }, (res) => {
      const status = res.statusCode ?? 0;
      if (status === HTTP_RANGE_NOT_SATISFIABLE) {
        // The part file does not fit this archive (another build's leftover): start over.
        res.resume();
        rm(i.partPath, { force: true }).then(() => finish(new DownloadError("network", t("update.download.restarting"))), finish);
        return;
      }
      if (status !== HTTP_OK && status !== HTTP_PARTIAL) {
        res.resume();
        finish(new DownloadError("http", t("update.download.http", { status })));
        return;
      }
      // 200 = the engine sent the whole archive, whatever was asked: the part file starts again.
      const appending = status === HTTP_PARTIAL && have > 0;
      let received = appending ? have : 0;
      const out = createWriteStream(i.partPath, { flags: appending ? "a" : "w", mode: 0o600 });
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > i.size) {
          req.destroy();
          out.destroy();
          finish(new DownloadError("too-large", t("update.download.tooMuch")));
          return;
        }
        i.onProgress?.(received);
      });
      // A connection that breaks mid-way: what arrived is flushed to the part file first, so the next attempt
      // continues after it instead of starting over.
      let broken: Error | undefined;
      res.on("error", (err) => {
        broken = err;
        out.end();
      });
      out.on("error", (err) => finish(new DownloadError("network", err.message)));
      out.on("finish", () => finish(broken ? new DownloadError("network", broken.message) : undefined));
      res.pipe(out);
    });
    const onAbort = (): void => {
      req.destroy();
      finish(new DownloadError("aborted", t("update.download.aborted")));
    };
    i.signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(i.idleTimeoutMs, () => req.destroy(new Error("idle timeout")));
    req.on("error", (err) => finish(new DownloadError("network", err.message)));
  });
}

/** Resolves once the part file holds `size` bytes. Throws DownloadError after `attempts` connections. */
export async function downloadArchive(i: DownloadInput): Promise<void> {
  let last: DownloadError | undefined;
  for (let attempt = 0; attempt < i.attempts; attempt++) {
    if (i.signal?.aborted) throw new DownloadError("aborted", t("update.download.aborted"));
    let have = await sizeOf(i.partPath);
    if (have > i.size) {
      await rm(i.partPath, { force: true });
      have = 0;
    }
    if (have === i.size) return;
    try {
      await fetchOnce(await i.url(), i, have);
    } catch (err) {
      if (!(err instanceof DownloadError)) throw err;
      if (err.code === "aborted" || err.code === "too-large") throw err;
      last = err;
      continue;
    }
    if ((await sizeOf(i.partPath)) === i.size) return;
    // The connection ended early without an error: the next attempt continues from what is on disk.
    last = new DownloadError("network", t("update.download.closedEarly"));
  }
  throw last ?? new DownloadError("network", t("update.download.failed"));
}
