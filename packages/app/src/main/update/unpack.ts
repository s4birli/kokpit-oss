// Kendini güncelleme: the ONLY code that turns downloaded bytes into files — Kokpit's own update format
// (@kokpit/shared app-bundle.ts), no archive tool and no second parser.
//
// Input: an entry list that already passed `validateBundleEntries` (plain ASCII names, parents first, links that
// stay inside), and the gzip blob whose SHA-256 already matched the manifest. Into a folder that this code creates
// itself (it must not exist), it makes exactly what the list names:
//   directories  mkdir (never recursive: the parent is always an entry written before)
//   files        open(O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW), exactly `size` bytes from the stream, hashed while
//                written and compared with the list; mode 0644 or 0755, nothing else
//   links        symlink(), last — so no file is ever written through one
// The decompressed stream must hold exactly the listed bytes: one byte more or less, or one hash that differs, and
// the whole folder is removed. Afterwards the result on disk is walked with lstat and compared with the list.
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import type { BundleEntry } from "@kokpit/shared";
import { rawFs, rawFsp } from "./fs-raw.ts";
import { t } from "../../i18n/index.ts";

// Never Electron's asar-aware `fs`: the bundle holds `app.asar`, which must be written and compared as a plain file.
const { constants, createReadStream } = rawFs;
const { lstat, mkdir, open, readdir, readlink, rm, symlink } = rawFsp;

export class UnpackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpackError";
  }
}

const DIR_MODE = 0o755;
const PERMISSION_BITS = 0o777;
type FileEntry = Extract<BundleEntry, { type: "file" }>;

/** `<root>/<entry path>`; the path was validated (plain components, no `..`), so this cannot leave `root`. */
const at = (root: string, entry: BundleEntry): string => join(root, ...entry.path.split("/"));

/**
 * Writes the bundle described by `entries` from the gzip blob into `destBundle`, which must not exist (its parent
 * must). Throws UnpackError — and leaves nothing behind — when the blob does not hold exactly what the list says.
 */
export async function unpackBundle(blobPath: string, entries: readonly BundleEntry[], destBundle: string): Promise<void> {
  // The destination is ours from the first moment: created here, exclusively, owner-only until it is complete.
  await mkdir(destBundle, { mode: 0o700 });
  const source = createReadStream(blobPath);
  const gunzip = createGunzip();
  source.on("error", (err) => gunzip.destroy(err));
  // Bad data can make the stream fail before the loop below listens to it; without a listener that would be an
  // uncaught exception in the main process. The loop still sees the failure when it reads.
  gunzip.on("error", () => {});
  source.pipe(gunzip);
  let handle: FileHandle | undefined;
  try {
    for (const e of entries) if (e.type === "dir") await mkdir(at(destBundle, e), { mode: DIR_MODE });

    const files = entries.filter((e): e is FileEntry => e.type === "file");
    let index = -1;
    let current: FileEntry | undefined;
    let left = 0;
    let hash = createHash("sha256");

    const finish = async (): Promise<void> => {
      if (!current || !handle) return;
      if (hash.digest("hex") !== current.sha256) throw new UnpackError(t("update.unpack.fileHash"));
      // The mode is set on the open file: the process umask does not get a say.
      await handle.chmod(current.mode);
      await handle.close();
      handle = undefined;
      current = undefined;
    };
    /** Opens the next file(s); files of size zero are complete at once. False when there is none left. */
    const next = async (): Promise<boolean> => {
      for (;;) {
        await finish();
        const entry = files[++index];
        if (!entry) return false;
        current = entry;
        left = entry.size;
        hash = createHash("sha256");
        handle = await open(at(destBundle, entry), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        if (left > 0) return true;
      }
    };

    let more = await next();
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length) {
        if (!more || !handle) throw new UnpackError(t("update.unpack.tooLong"));
        const take = Math.min(left, chunk.length - offset);
        const piece = chunk.subarray(offset, offset + take);
        hash.update(piece);
        await handle.write(piece);
        offset += take;
        left -= take;
        if (left === 0) more = await next();
      }
    }
    if (more) throw new UnpackError(t("update.unpack.tooShort"));
    await finish();

    // Links last: until now nothing in the tree could redirect a write.
    for (const e of entries) if (e.type === "symlink") await symlink(e.target, at(destBundle, e));
    await compareWithEntries(destBundle, entries);
    const top = await open(destBundle, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await top.chmod(DIR_MODE);
    } finally {
      await top.close();
    }
  } catch (err) {
    source.destroy();
    gunzip.destroy();
    await handle?.close().catch(() => {});
    await rm(destBundle, { recursive: true, force: true });
    if (err instanceof UnpackError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw new UnpackError(code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR" ? t("update.unpack.corrupt") : t("update.unpack.writeFailed", { error: code ?? (err as Error).message }));
  }
}

/**
 * Walks what is on disk (lstat — nothing is followed) and compares it with the list: the same paths and nothing
 * else, each of its type, files of their size and mode, links with their target.
 */
export async function compareWithEntries(bundlePath: string, entries: readonly BundleEntry[]): Promise<void> {
  const expected = new Map(entries.map((e) => [e.path, e]));
  let seen = 0;
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of await readdir(abs)) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const e = expected.get(path);
      if (!e) throw new UnpackError(t("update.unpack.extra"));
      seen++;
      const st = await lstat(join(abs, name));
      if (e.type === "dir") {
        if (!st.isDirectory()) throw new UnpackError(t("update.unpack.mismatchFolder"));
        await walk(join(abs, name), path);
      } else if (e.type === "file") {
        if (!st.isFile() || st.size !== e.size || (st.mode & PERMISSION_BITS) !== e.mode || st.nlink !== 1) throw new UnpackError(t("update.unpack.mismatchFile"));
      } else if (!st.isSymbolicLink() || (await readlink(join(abs, name))) !== e.target) {
        throw new UnpackError(t("update.unpack.mismatchLink"));
      }
    }
  };
  if (!(await lstat(bundlePath)).isDirectory()) throw new UnpackError(t("update.unpack.notFolder"));
  await walk(bundlePath, "");
  if (seen !== expected.size) throw new UnpackError(t("update.unpack.missing"));
}
