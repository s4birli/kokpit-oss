// Kendini güncelleme: turns a built .app folder into Kokpit's update format (see app-bundle.ts) — the entry list
// and the gzip blob. Node only (the engine's publish step, and tests); not part of the package's main entry.
//
// What is carried: directories, regular files (content, and whether they are executable) and symbolic links.
// What is not: owners, timestamps and extended attributes. A code signature seals file contents and the bundle's
// structure, not those — a bundle rebuilt from this format passes `codesign --verify --deep --strict` (measured:
// docs/kabul-testleri.md §21). Anything else in the folder (a device, a pipe, a hard-linked file) stops the packing.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import { BUNDLE_FILE_MODES, validateBundleEntries, type BundleEntry, type BundleLimits } from "./app-bundle.ts";

export interface PackResult {
  entries: BundleEntry[];
  /** Sum of the file sizes. */
  unpackedSize: number;
  /** The blob as written: its size and SHA-256. */
  blob: { size: number; sha256: string };
}

const EXEC_BIT = 0o100;

/**
 * Walks `bundlePath` (names sorted, parents first), writes the files' contents gzip-compressed into `blobPath` and
 * returns the entry list. Throws when the bundle holds something the format has no record for, or when the list
 * would not pass the app's own validation — a build the apps would refuse is never published.
 */
export async function packBundle(bundlePath: string, blobPath: string, limits: BundleLimits, gzipLevel?: number): Promise<PackResult> {
  const raw: BundleEntry[] = [];
  const files: { abs: string; size: number }[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    const names = (await readdir(abs)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const full = join(abs, name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        raw.push({ path, type: "symlink", target: await readlink(full) });
      } else if (st.isDirectory()) {
        raw.push({ path, type: "dir" });
        await walk(full, path);
      } else if (st.isFile()) {
        if (st.nlink > 1) throw new Error(`${path}: hard-linked files cannot be packed`);
        // sha256 is filled in while the content is streamed into the blob.
        raw.push({ path, type: "file", mode: (st.mode & EXEC_BIT) !== 0 ? BUNDLE_FILE_MODES[1] : BUNDLE_FILE_MODES[0], size: st.size, sha256: "0".repeat(64) });
        files.push({ abs: full, size: st.size });
      } else {
        throw new Error(`${path}: not a file, folder or link`);
      }
    }
  };
  const top = await lstat(bundlePath);
  if (!top.isDirectory()) throw new Error(`${bundlePath} is not a folder`);
  await walk(bundlePath, "");
  // Names and structure are checked before anything is read or written.
  validateBundleEntries(raw, limits);

  const gzip = createGzip(gzipLevel !== undefined ? { level: gzipLevel } : {});
  const out = createWriteStream(blobPath, { mode: 0o600 });
  const blobHash = createHash("sha256");
  let blobSize = 0;
  gzip.on("data", (chunk: Buffer) => {
    blobHash.update(chunk);
    blobSize += chunk.length;
  });
  gzip.pipe(out);
  const finished = once(out, "finish");
  let fileIndex = 0;
  let unpackedSize = 0;
  for (const entry of raw) {
    if (entry.type !== "file") continue;
    const f = files[fileIndex++]!;
    const hash = createHash("sha256");
    let seen = 0;
    for await (const chunk of createReadStream(f.abs) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      seen += chunk.length;
      if (!gzip.write(chunk)) await once(gzip, "drain");
    }
    // A file that changed while it was read would make the list lie about the blob.
    if (seen !== f.size) throw new Error(`${entry.path}: changed while it was being packed`);
    entry.sha256 = hash.digest("hex");
    unpackedSize += seen;
  }
  gzip.end();
  await finished;
  return { entries: validateBundleEntries(raw, limits), unpackedSize, blob: { size: blobSize, sha256: blobHash.digest("hex") } };
}
