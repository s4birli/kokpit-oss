// Kendini güncelleme: everything that is checked between "bytes arrived" and "this bundle may replace the app".
// Nothing from the download is executed here or before. The bytes are turned into files by our own code alone
// (unpack.ts); the macOS tools that run afterwards (plutil, codesign, xattr) only read the result.
//
//   0. the manifest is signed by the publisher key this app carries, and the entry list is the signed one
//   1. size and SHA-256 of the blob equal the manifest's (which came over the authenticated WebSocket)
//   2. the entry list is valid as a whole — plain names, parents first, no path twice (case ignored), links that
//      stay inside the bundle, sizes and count within the caps (validateBundleEntries; done before this is called,
//      and again here)
//   3. the bundle is written from list and blob into a fresh folder next to the app: every file exactly its
//      listed size and SHA-256, nothing more or less in the stream
//   4. the result on disk is walked and compared with the list: same entries, types, sizes, modes, link targets
//   5. Info.plist: bundle identifier = the running app's; version and build id = the manifest's
//   6. `codesign --verify --deep --strict` passes (the bundle is complete and unmodified since it was signed)
//   7. when the running app has a stable signing identity (not ad-hoc), the new bundle satisfies the same
//      designated requirement — so the engine key alone cannot ship code signed by someone else
//   8. no quarantine attribute stays on it (a quarantined bundle would be translocated on launch)
//
// 0 is the defence against anyone who is not the publisher (an impostor engine, a leaked access key); 1 against
// tampering or damage on the way. 2–4 defend against the ENGINE (or the build it
// publishes) being malicious or broken — by then the bytes are known to be exactly what the engine meant to send.
// 5–7 tie the result to this app. What none of it can do: tell a good build from a bad one that an engine holding
// the key chose to publish and that is correctly signed (ad-hoc signing proves no origin) — see the trust model in
// docs/kabul-testleri.md §21.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BundleFormatError, validateBundleEntries, type AppUpdateManifest, type BundleEntry } from "@kokpit/shared";
import { checkManifestSignature, entriesMatchManifest } from "./signature.ts";
import type { UpdateConfig } from "./config.ts";
import { rawFs, rawFsp } from "./fs-raw.ts";
import { compareWithEntries, UnpackError, unpackBundle } from "./unpack.ts";
import { t } from "../../i18n/index.ts";

// The staged bundle contains `app.asar`; Electron's asar-aware `fs` must not look into it (fs-raw.ts).
const { createReadStream } = rawFs;
const { mkdir, rm, stat } = rawFsp;

export type VerifyCheck = "unsigned" | "size" | "hash" | "entries" | "unpack" | "identity" | "signature" | "requirement" | "quarantine";

export class VerifyError extends Error {
  /** Names the check that failed (tests, the log). */
  readonly code: VerifyCheck;
  constructor(code: VerifyCheck, message: string) {
    super(message);
    this.name = "VerifyError";
    this.code = code;
  }
}

export interface ToolResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** Runs one of macOS's tools; injectable for tests. Never a shell. */
export type RunTool = (cmd: string, args: string[]) => Promise<ToolResult>;

export interface BundleIdentity {
  bundleId: string;
  version: string;
  buildId: string | undefined;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** Step 1. */
export async function verifyBlobHash(path: string, expected: { size: number; sha256: string }): Promise<void> {
  const st = await stat(path);
  if (st.size !== expected.size) throw new VerifyError("size", t("update.verify.sizeMismatch", { actual: st.size, expected: expected.size }));
  const actual = await sha256File(path);
  if (actual !== expected.sha256) throw new VerifyError("hash", t("update.verify.hashMismatch"));
}

export const bundleLimitsOf = (cfg: Pick<UpdateConfig, "maxBundleFiles" | "maxBundleLinks" | "maxFileBytes" | "maxUnpackedBytes">): BundleLimitsLike => ({
  maxEntries: cfg.maxBundleFiles,
  maxLinks: cfg.maxBundleLinks,
  maxFileBytes: cfg.maxFileBytes,
  maxTotalBytes: cfg.maxUnpackedBytes,
});

/** Reads the identity fields of a bundle's Info.plist. */
export async function readBundleIdentity(bundlePath: string, cfg: UpdateConfig, run: RunTool): Promise<BundleIdentity> {
  const r = await run(cfg.tools.plutil, ["-convert", "json", "-o", "-", "--", join(bundlePath, "Contents", "Info.plist")]);
  if (r.status !== 0) throw new VerifyError("identity", t("update.verify.plistUnreadable"));
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    throw new VerifyError("identity", t("update.verify.plistUnreadable"));
  }
  const str = (key: string): string | undefined => (typeof info[key] === "string" && info[key] !== "" ? (info[key] as string) : undefined);
  const bundleId = str(cfg.bundleIdPlistKey);
  const version = str(cfg.versionPlistKey);
  if (bundleId === undefined || version === undefined) throw new VerifyError("identity", t("update.verify.plistNoIdentity"));
  return { bundleId, version, buildId: str(cfg.buildIdPlistKey) };
}

/** The designated requirement of a bundle; undefined for an ad-hoc signature (its requirement is just its own hash). */
export async function stableRequirement(bundlePath: string, cfg: UpdateConfig, run: RunTool): Promise<string | undefined> {
  const r = await run(cfg.tools.codesign, ["-d", "-r-", "--", bundlePath]);
  if (r.status !== 0) return undefined;
  const m = /^(?:# )?designated => (.+)$/m.exec(`${r.stdout}\n${r.stderr}`);
  const req = m?.[1]?.trim();
  return req === undefined || req === "" || /^cdhash\b/.test(req) ? undefined : req;
}

type BundleLimitsLike = { maxEntries: number; maxLinks: number; maxFileBytes: number; maxTotalBytes: number };

export interface VerifyInput {
  /** The downloaded blob. */
  blobPath: string;
  /** The bundle's entry list as the engine sent it (checked again here). */
  entries: readonly BundleEntry[];
  /** Folder on the app's volume the bundle is written into; replaced if it exists, removed again on any failure. */
  extractDir: string;
  manifest: AppUpdateManifest;
  /** The publisher's public key this app was built with (undefined: this build verifies nothing — and installs nothing). */
  publicKey: string | undefined;
  /** The running app: bundle folder name, identifier, and its stable designated requirement if it has one. */
  running: { bundleName: string; bundleId: string; requirement?: string | undefined };
}

/** Steps 1–8. Resolves to the path of the verified bundle inside `extractDir`. */
export async function verifyAndUnpack(input: VerifyInput, cfg: UpdateConfig, run: RunTool): Promise<string> {
  const { blobPath, extractDir, manifest, running } = input;
  const signed = checkManifestSignature(manifest, input.publicKey);
  if (!signed.ok) throw new VerifyError("unsigned", signed.message);
  if (!entriesMatchManifest(input.entries, manifest)) throw new VerifyError("unsigned", t("update.verify.listNotSigned"));
  await verifyBlobHash(blobPath, manifest);
  let entries: BundleEntry[];
  try {
    entries = validateBundleEntries(input.entries, bundleLimitsOf(cfg));
  } catch (err) {
    if (err instanceof BundleFormatError) throw new VerifyError("entries", err.message);
    throw err;
  }
  const unpacked = entries.reduce((sum, e) => sum + (e.type === "file" ? e.size : 0), 0);
  if (entries.length !== manifest.entryCount || unpacked !== manifest.unpackedSize) throw new VerifyError("entries", t("update.verify.listNotManifest"));
  if (manifest.bundleName !== running.bundleName) throw new VerifyError("identity", t("update.verify.otherBundleName", { name: manifest.bundleName }));

  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true, mode: 0o700 });
  try {
    const bundle = join(extractDir, running.bundleName);
    try {
      await unpackBundle(blobPath, entries, bundle);
    } catch (err) {
      if (err instanceof UnpackError) throw new VerifyError("unpack", err.message);
      throw err;
    }

    const identity = await readBundleIdentity(bundle, cfg, run);
    if (identity.bundleId !== running.bundleId) throw new VerifyError("identity", t("update.verify.otherApp", { bundleId: identity.bundleId }));
    if (identity.buildId !== manifest.buildId) throw new VerifyError("identity", t("update.verify.buildIdMismatch"));
    if (identity.version !== manifest.version) throw new VerifyError("identity", t("update.verify.versionMismatch"));

    const sig = await run(cfg.tools.codesign, ["--verify", "--deep", "--strict", "--", bundle]);
    if (sig.status !== 0) throw new VerifyError("signature", t("update.verify.codeSignature"));
    if (running.requirement !== undefined) {
      const req = await run(cfg.tools.codesign, ["--verify", `-R=${running.requirement}`, "--", bundle]);
      if (req.status !== 0) throw new VerifyError("requirement", t("update.verify.requirement"));
    }

    // Our own writing sets no quarantine; if something did (a security tool), it comes off — the content was
    // verified above, and a quarantined bundle would be run from a translocated copy.
    const q = await run(cfg.tools.xattr, ["-p", cfg.quarantineAttr, bundle]);
    if (q.status === 0) {
      const cleared = await run(cfg.tools.xattr, ["-d", "-r", cfg.quarantineAttr, bundle]);
      if (cleared.status !== 0) throw new VerifyError("quarantine", t("update.verify.quarantine"));
    }
    return bundle;
  } catch (err) {
    await rm(extractDir, { recursive: true, force: true });
    throw err;
  }
}

export interface ReverifyInput {
  stagedBundle: string;
  /** The validated, signed entry list the build was written from (kept next to it). */
  entries: readonly BundleEntry[];
  buildId: string;
  version: string;
  running: { bundleId: string; requirement?: string | undefined };
}

/**
 * Right before the swap — the staged bundle sat on disk since it was verified: the same checks again. The tree is
 * exactly the list (types, sizes, modes, link targets, nothing extra), every file still has its listed SHA-256, the
 * identity is this app's and this build's, the signature verifies, and (with a stable identity) it satisfies the
 * running app's designated requirement. Throws VerifyError.
 */
export async function reverifyStaged(i: ReverifyInput, cfg: UpdateConfig, run: RunTool): Promise<void> {
  try {
    await compareWithEntries(i.stagedBundle, i.entries);
  } catch (err) {
    if (err instanceof UnpackError) throw new VerifyError("unpack", err.message);
    throw err;
  }
  for (const e of i.entries) {
    if (e.type !== "file") continue;
    if ((await sha256File(join(i.stagedBundle, ...e.path.split("/")))) !== e.sha256) throw new VerifyError("unpack", t("update.verify.stagedFileChanged"));
  }
  const identity = await readBundleIdentity(i.stagedBundle, cfg, run);
  if (identity.bundleId !== i.running.bundleId || identity.buildId !== i.buildId || identity.version !== i.version) {
    throw new VerifyError("identity", t("update.verify.stagedIdentityChanged"));
  }
  const sig = await run(cfg.tools.codesign, ["--verify", "--deep", "--strict", "--", i.stagedBundle]);
  if (sig.status !== 0) throw new VerifyError("signature", t("update.verify.stagedSignature"));
  if (i.running.requirement !== undefined) {
    const req = await run(cfg.tools.codesign, ["--verify", `-R=${i.running.requirement}`, "--", i.stagedBundle]);
    if (req.status !== 0) throw new VerifyError("requirement", t("update.verify.stagedRequirement"));
  }
}
