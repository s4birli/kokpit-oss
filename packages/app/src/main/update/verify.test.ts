// @vitest-environment node
// Kendini güncelleme — from blob + entry list to a verified bundle, with our own unpacker and macOS's real
// plutil / codesign / xattr on small, really signed bundles made here in a temp folder: what a good build passes,
// and every way a bad one is refused — leaving nothing behind — before anything could run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import type { BundleEntry } from "@kokpit/shared";
import { packBundle } from "@kokpit/shared/bundle-pack";
import { ensureSigningKey, entriesSha256, signManifest, type SigningKey } from "@kokpit/shared/update-signing";
import type { AppUpdateManifest } from "@kokpit/shared";
import { DEFAULT_UPDATE_CONFIG as cfg } from "./config.ts";
import { compareWithEntries, unpackBundle, UnpackError } from "./unpack.ts";
import { bundleLimitsOf, reverifyStaged, stableRequirement, verifyAndUnpack, VerifyError, type RunTool, type VerifyInput } from "./verify.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-update-verify-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BUNDLE_ID = "dev.kokpit.verifytest";
const BUILD = "0.1.0+20261118100000.abc1234";
const NAME = "Kokpit.app";
const LIMITS = bundleLimitsOf(cfg);
/** The publisher key the "running app" was built with, and another one (an attacker's). */
const PUBLISHER: SigningKey = ensureSigningKey(join(root, "publisher"));
const ATTACKER: SigningKey = ensureSigningKey(join(root, "attacker"));

/** A manifest for `p`, signed by `key` over these fields (as the engine's publish step makes it). */
function signedManifest(p: Packed, patch: Partial<AppUpdateManifest> = {}, key: SigningKey = PUBLISHER, entries: readonly BundleEntry[] = p.entries): AppUpdateManifest {
  const bytes = readFileSync(p.blob);
  const fields = {
    buildId: BUILD,
    version: "0.1.0",
    format: 1 as const,
    bundleName: NAME,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    unpackedSize: p.unpackedSize,
    entryCount: p.entries.length,
    entriesSha256: entriesSha256(entries)!,
    createdAt: "2026-11-18T12:00:00.000Z",
    ...patch,
  };
  return { ...fields, signingKeyId: key.keyId, signature: signManifest(key, fields) };
}

const run: RunTool = async (cmd, args) => {
  try {
    return { status: 0, stdout: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? null, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

let n = 0;
const fresh = (prefix: string): string => {
  const dir = join(root, `${prefix}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

interface BundleOptions {
  bundleId?: string;
  buildId?: string | null;
  version?: string;
  /** Runs on the bundle folder before it is signed. */
  beforeSign?(bundle: string): void;
  /** Runs after signing (tampering before it is packed). */
  afterSign?(bundle: string): void;
  sign?: boolean;
}

interface Packed {
  bundle: string;
  blob: string;
  entries: BundleEntry[];
  unpackedSize: number;
}

/** A minimal, really signed (ad-hoc) app bundle, packed the way the engine publishes it. */
async function makeBundle(o: BundleOptions = {}): Promise<Packed> {
  const dir = fresh("src");
  const bundle = join(dir, NAME);
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
  const keys: Record<string, string> = {
    CFBundleIdentifier: o.bundleId ?? BUNDLE_ID,
    CFBundleExecutable: "Kokpit",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: o.version ?? "0.1.0",
    ...(o.buildId === null ? {} : { KokpitBuildId: o.buildId ?? BUILD }),
  };
  const body = Object.entries(keys).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("");
  writeFileSync(join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}</dict></plist>`);
  // A real Mach-O (a copy of /usr/bin/true), so the signature is a real code signature. It is never executed.
  execFileSync("/bin/cp", ["/usr/bin/true", join(bundle, "Contents", "MacOS", "Kokpit")]);
  writeFileSync(join(bundle, "Contents", "Resources", "data.txt"), "içerik\n");
  writeFileSync(join(bundle, "Contents", "Resources", "empty.dat"), "");
  symlinkSync("data.txt", join(bundle, "Contents", "Resources", "alias.txt"));
  o.beforeSign?.(bundle);
  if (o.sign !== false) execFileSync(cfg.tools.codesign, ["--force", "--deep", "--sign", "-", bundle], { stdio: "pipe" });
  o.afterSign?.(bundle);
  const blob = join(dir, "bundle.bin.gz");
  const packed = await packBundle(bundle, blob, LIMITS);
  return { bundle, blob, entries: packed.entries, unpackedSize: packed.unpackedSize };
}

/**
 * Verify input for `p`. `entries` is what the engine sends; by default the manifest signs that same list — pass
 * `signedEntries` to sign another one (the engine sending a list the publisher did not sign).
 */
function inputFor(
  p: Packed,
  patch: Partial<AppUpdateManifest> = {},
  running: Partial<VerifyInput["running"]> = {},
  entries: readonly BundleEntry[] = p.entries,
  signedEntries: readonly BundleEntry[] = entries,
): VerifyInput {
  return {
    blobPath: p.blob,
    entries,
    extractDir: join(fresh("stage"), "unpacked"),
    manifest: signedManifest(p, patch, PUBLISHER, signedEntries),
    publicKey: PUBLISHER.publicKey,
    running: { bundleName: NAME, bundleId: BUNDLE_ID, ...running },
  };
}

async function refused(input: VerifyInput, tools: RunTool = run): Promise<VerifyError> {
  const err = await verifyAndUnpack(input, cfg, tools).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VerifyError);
  // A refused build leaves nothing unpacked behind.
  expect(existsSync(input.extractDir)).toBe(false);
  return err as VerifyError;
}

/** Rewrites the blob with other content (and returns a Packed whose manifest hash will match the new bytes). */
function reblob(p: Packed, change: (content: Buffer) => Buffer): Packed {
  const blob = join(fresh("blob"), "bundle.bin.gz");
  writeFileSync(blob, gzipSync(change(gunzipSync(readFileSync(p.blob)))));
  return { ...p, blob };
}
const fileEntry = (p: Packed, suffix: string) => p.entries.find((e) => e.type === "file" && e.path.endsWith(suffix)) as Extract<BundleEntry, { type: "file" }>;
const withEntry = (p: Packed, suffix: string, patch: Record<string, unknown>): BundleEntry[] => p.entries.map((e) => (e.path.endsWith(suffix) ? ({ ...e, ...patch } as BundleEntry) : e));

describe("a good build", () => {
  it("is written next to the app from list + blob, passes every check — and its signature still verifies (round trip)", async () => {
    const p = await makeBundle();
    const input = inputFor(p);
    const staged = await verifyAndUnpack(input, cfg, run);
    expect(staged).toBe(join(input.extractDir, NAME));
    expect(readFileSync(join(staged, "Contents", "Resources", "data.txt"), "utf8")).toBe("içerik\n");
    expect(readlinkSync(join(staged, "Contents", "Resources", "alias.txt"))).toBe("data.txt");
    expect(lstatSync(join(staged, "Contents", "MacOS", "Kokpit")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(staged, "Contents", "Info.plist")).mode & 0o777).toBe(0o644);
    expect(lstatSync(join(staged, "Contents", "Resources", "empty.dat")).size).toBe(0);
    expect(lstatSync(staged).mode & 0o777).toBe(0o755);
    // Only what the list names is there, and the code signature made BEFORE packing holds for the rebuilt bundle.
    expect(readdirSync(input.extractDir)).toEqual([NAME]);
    expect((await run(cfg.tools.codesign, ["--verify", "--deep", "--strict", staged])).status).toBe(0);
    // Byte for byte the same files as the original.
    for (const e of p.entries) if (e.type === "file") expect(readFileSync(join(staged, e.path)).equals(readFileSync(join(p.bundle, e.path))), e.path).toBe(true);
  });

  it("an existing (stale) folder at the staging place is replaced, not merged into", async () => {
    const p = await makeBundle();
    const input = inputFor(p);
    mkdirSync(join(input.extractDir, NAME, "Contents"), { recursive: true });
    writeFileSync(join(input.extractDir, NAME, "Contents", "leftover.sh"), "x");
    const staged = await verifyAndUnpack(input, cfg, run);
    expect(existsSync(join(staged, "Contents", "leftover.sh"))).toBe(false);
  });
});

describe("the publisher's signature (checked before anything else)", () => {
  it("the reviewer's case: an ad-hoc signed bundle with the right ids, NOT signed by the publisher, is refused", async () => {
    const p = await makeBundle();
    // Signed by someone else's key (an impostor engine, a leaked access key): the fields are perfect, the key is not.
    const input = { ...inputFor(p), manifest: signedManifest(p, {}, ATTACKER) };
    const err = await refused(input);
    expect(err.code).toBe("unsigned");
    expect(err.message).toContain("başka bir yayıncı anahtarıyla");
  });

  it("the attacker reuses the publisher's key id with its own signature", async () => {
    const p = await makeBundle();
    const forged = { ...signedManifest(p, {}, ATTACKER), signingKeyId: PUBLISHER.keyId };
    expect((await refused({ ...inputFor(p), manifest: forged })).message).toContain("imzası geçersiz");
  });

  it("any field changed after signing (here: the blob's hash and size, to slip in other bytes)", async () => {
    const p = await makeBundle();
    const good = signedManifest(p);
    for (const tampered of [{ ...good, sha256: "0".repeat(64) }, { ...good, size: good.size + 1 }, { ...good, buildId: "0.1.0+20991231000000.evil" }]) {
      expect((await refused({ ...inputFor(p), manifest: tampered })).code).toBe("unsigned");
    }
  });

  it("an app built without a publisher key installs nothing", async () => {
    const p = await makeBundle();
    expect((await refused({ ...inputFor(p), publicKey: undefined })).message).toContain("imza anahtarı olmadan");
  });

  it("an entry list other than the signed one (the engine adds an entry) is refused", async () => {
    const p = await makeBundle();
    const extra = [...p.entries, { path: "Contents/Resources/evil.sh", type: "file" as const, mode: 0o755 as const, size: 0, sha256: createHash("sha256").digest("hex") }];
    expect((await refused(inputFor(p, {}, {}, extra, p.entries))).code).toBe("unsigned");
  });
});

describe("refused before anything is written", () => {
  it("wrong hash (one byte changed in transit), truncated download", async () => {
    const p = await makeBundle();
    const flipped = inputFor(p);
    const bytes = readFileSync(p.blob);
    bytes[bytes.length >> 1]! ^= 0xff;
    writeFileSync(p.blob, bytes);
    expect((await refused(flipped)).code).toBe("hash");
    const q = await makeBundle();
    const cut = inputFor(q);
    writeFileSync(q.blob, readFileSync(q.blob).subarray(0, -10));
    expect((await refused(cut)).code).toBe("size");
  });

  it.each([
    ["a path out of the bundle", (p: Packed) => withEntry(p, "data.txt", { path: "../../evil.txt" })],
    ["an absolute path", (p: Packed) => withEntry(p, "data.txt", { path: "/tmp/evil.txt" })],
    ["a link out of the bundle", (p: Packed) => withEntry(p, "alias.txt", { target: "../../../../etc/hosts" })],
    ["a link with an absolute target", (p: Packed) => withEntry(p, "alias.txt", { target: "/etc/hosts" })],
    ["a setuid file", (p: Packed) => withEntry(p, "MacOS/Kokpit", { mode: 0o4755 })],
    ["a case-colliding path", (p: Packed) => [...p.entries, { ...fileEntry(p, "data.txt"), path: "Contents/Resources/DATA.txt" }]],
    ["a file inside a link", (p: Packed) => [...p.entries, { ...fileEntry(p, "data.txt"), path: "Contents/Resources/alias.txt/x" }]],
    ["an entry less than the manifest announced", (p: Packed) => p.entries.filter((e) => !e.path.endsWith("empty.dat"))],
  ])("an entry list with %s", async (_n, make) => {
    const p = await makeBundle();
    const input = inputFor(p, {}, {}, make(p));
    expect((await refused(input)).code).toBe("entries");
    expect(existsSync(join(root, "evil.txt"))).toBe(false);
  });

  it("a manifest for a bundle of another name (signed, so the publisher said so)", async () => {
    const p = await makeBundle();
    expect((await refused(inputFor(p, { bundleName: "Other.app" }))).code).toBe("identity");
  });
});

describe("refused while writing: the blob must hold exactly what the list says", () => {
  it("a file's content differs from its listed hash (same length) — nothing is left behind", async () => {
    const p = await makeBundle();
    const at = p.unpackedSize - fileEntry(p, "data.txt").size; // data.txt is the last file with content
    const bad = reblob(p, (c) => {
      c[at] = c[at]! ^ 0x01;
      return c;
    });
    const err = await refused(inputFor(bad));
    expect(err.code).toBe("unpack");
    expect(err.message).toContain("özet");
  });

  it("a blob shorter than the list, and one longer", async () => {
    const p = await makeBundle();
    expect((await refused(inputFor(reblob(p, (c) => c.subarray(0, c.length - 3))))).message).toContain("kısa");
    expect((await refused(inputFor(reblob(p, (c) => Buffer.concat([c, Buffer.from("fazlası")]))))).message).toContain("uzun");
  });

  it("a blob that inflates far beyond the list (a bomb) is stopped at the first byte too many", async () => {
    const p = await makeBundle();
    const bomb = reblob(p, (c) => Buffer.concat([c, Buffer.alloc(64 * 1024 * 1024)]));
    expect(readFileSync(bomb.blob).length).toBeLessThan(200_000);
    const started = Date.now();
    expect((await refused(inputFor(bomb))).message).toContain("uzun");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a blob that is not gzip at all, and one cut in the middle of the stream", async () => {
    const p = await makeBundle();
    const junk = { ...p, blob: join(fresh("blob"), "junk") };
    writeFileSync(junk.blob, Buffer.alloc(5000, 7));
    expect((await refused(inputFor(junk))).code).toBe("unpack");
    const cut = { ...p, blob: join(fresh("blob"), "cut") };
    writeFileSync(cut.blob, readFileSync(p.blob).subarray(0, readFileSync(p.blob).length >> 1));
    expect((await refused(inputFor(cut))).code).toBe("unpack");
  });

  it("a list that claims another size or hash for a file than the blob holds", async () => {
    const p = await makeBundle();
    const size = fileEntry(p, "data.txt").size;
    // One byte moved from data.txt to the file before it: totals still match the manifest.
    const shifted = p.entries.map((e) => (e.type !== "file" ? e : e.path.endsWith("data.txt") ? { ...e, size: size - 1 } : e.path.endsWith("MacOS/Kokpit") ? { ...e, size: e.size + 1 } : e));
    expect((await refused(inputFor(p, {}, {}, shifted))).code).toBe("unpack");
    expect((await refused(inputFor(p, {}, {}, withEntry(p, "data.txt", { sha256: "0".repeat(64) })))).code).toBe("unpack");
  });
});

describe("unpackBundle on its own", () => {
  it("never writes into a place that already exists (no merging, no following)", async () => {
    const p = await makeBundle();
    const dest = join(fresh("dest"), NAME);
    mkdirSync(dest);
    await expect(unpackBundle(p.blob, p.entries, dest)).rejects.toBeInstanceOf(Error);
    // A link standing where the bundle should go is not followed either.
    const dir = fresh("dest");
    const elsewhere = fresh("elsewhere");
    symlinkSync(elsewhere, join(dir, NAME));
    await expect(unpackBundle(p.blob, p.entries, join(dir, NAME))).rejects.toBeInstanceOf(Error);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("the tree comparison catches anything the list does not say: an extra file, a changed mode, a retargeted link, a missing entry", async () => {
    const p = await makeBundle();
    const make = async (): Promise<string> => {
      const dest = join(fresh("dest"), NAME);
      await unpackBundle(p.blob, p.entries, dest);
      return dest;
    };
    await expect(compareWithEntries(await make(), p.entries)).resolves.toBeUndefined();
    const extra = await make();
    writeFileSync(join(extra, "Contents", "extra.sh"), "x");
    await expect(compareWithEntries(extra, p.entries)).rejects.toBeInstanceOf(UnpackError);
    const mode = await make();
    chmodSync(join(mode, "Contents", "Info.plist"), 0o777);
    await expect(compareWithEntries(mode, p.entries)).rejects.toThrow("dosya");
    const link = await make();
    rmSync(join(link, "Contents", "Resources", "alias.txt"));
    symlinkSync("/etc/hosts", join(link, "Contents", "Resources", "alias.txt"));
    await expect(compareWithEntries(link, p.entries)).rejects.toThrow("bağlantı");
    const missing = await make();
    rmSync(join(missing, "Contents", "Resources", "empty.dat"));
    await expect(compareWithEntries(missing, p.entries)).rejects.toThrow("eksik");
  });
});

describe("refused after writing", () => {
  it("another application's bundle identifier", async () => {
    const err = await refused(inputFor(await makeBundle({ bundleId: "com.example.other" })));
    expect(err.code).toBe("identity");
    expect(err.message).toContain("com.example.other");
  });

  it("a build id that is not the manifest's, none at all, or another version", async () => {
    expect((await refused(inputFor(await makeBundle({ buildId: "0.1.0+20200101000000.old0000" })))).code).toBe("identity");
    expect((await refused(inputFor(await makeBundle({ buildId: null })))).code).toBe("identity");
    expect((await refused(inputFor(await makeBundle({ version: "9.9.9" })))).code).toBe("identity");
  });

  it("a file changed, added, or the executable replaced after signing (the engine published a tampered bundle)", async () => {
    const changed = await makeBundle({ afterSign: (b) => writeFileSync(join(b, "Contents", "Resources", "data.txt"), "değişti\n") });
    expect((await refused(inputFor(changed))).code).toBe("signature");
    const added = await makeBundle({ afterSign: (b) => writeFileSync(join(b, "Contents", "Resources", "extra.js"), "boom()") });
    expect((await refused(inputFor(added))).code).toBe("signature");
    const swapped = await makeBundle({ afterSign: (b) => execFileSync("/bin/cp", ["/bin/echo", join(b, "Contents", "MacOS", "Kokpit")]) });
    expect((await refused(inputFor(swapped))).code).toBe("signature");
  });

  it("not signed at all", async () => {
    expect((await refused(inputFor(await makeBundle({ sign: false })))).code).toBe("signature");
  });
});

describe("signing identity", () => {
  it("an ad-hoc signed app has no stable requirement (its requirement is its own hash)", async () => {
    expect(await stableRequirement((await makeBundle()).bundle, cfg, run)).toBeUndefined();
  });

  it("a stable requirement is read from codesign's output", async () => {
    const fake: RunTool = async () => ({ status: 0, stdout: "", stderr: 'Executable=/x\n# designated => identifier "dev.kokpit.app" and certificate leaf = H"ab12"\n' });
    expect(await stableRequirement("/x.app", cfg, fake)).toBe('identifier "dev.kokpit.app" and certificate leaf = H"ab12"');
  });

  it("when the running app has one, a build that does not satisfy it is refused — and one that does passes", async () => {
    const p = await makeBundle();
    const calls: string[][] = [];
    const tools = (satisfied: boolean): RunTool => async (cmd, args) => {
      if (cmd === cfg.tools.codesign && args.some((a) => a.startsWith("-R="))) {
        calls.push(args);
        return { status: satisfied ? 0 : 3, stdout: "", stderr: "" };
      }
      return run(cmd, args);
    };
    const requirement = 'identifier "dev.kokpit.app" and certificate leaf = H"ab12"';
    expect((await refused(inputFor(p, {}, { requirement }), tools(false))).code).toBe("requirement");
    expect(calls[0]).toContain(`-R=${requirement}`);
    await expect(verifyAndUnpack(inputFor(p, {}, { requirement }), cfg, tools(true))).resolves.toContain(NAME);
  });
});

describe("quarantine", () => {
  it("a quarantine attribute on the written bundle is removed (it would cause translocation); the signature still verifies", async () => {
    const p = await makeBundle();
    let marked = false;
    const tools: RunTool = async (cmd, args) => {
      // Mark the bundle right after it was written, as a security tool might (before the first tool reads it).
      if (cmd === cfg.tools.plutil && !marked) {
        execFileSync(cfg.tools.xattr, ["-w", cfg.quarantineAttr, "0081;00000000;Test;", join(args.at(-1)!, "..", "..")]);
        marked = true;
      }
      return run(cmd, args);
    };
    const staged = await verifyAndUnpack(inputFor(p), cfg, tools);
    expect(marked).toBe(true);
    expect((await run(cfg.tools.xattr, ["-p", cfg.quarantineAttr, staged])).status).not.toBe(0);
    expect((await run(cfg.tools.codesign, ["--verify", "--deep", "--strict", staged])).status).toBe(0);
  });
});

describe("reverify right before the swap", () => {
  async function staged(): Promise<{ p: Packed; bundle: string }> {
    const p = await makeBundle();
    return { p, bundle: await verifyAndUnpack(inputFor(p), cfg, run) };
  }
  const again = (p: Packed, bundle: string) => reverifyStaged({ stagedBundle: bundle, entries: p.entries, buildId: BUILD, version: "0.1.0", running: { bundleId: BUNDLE_ID } }, cfg, run);

  it("an untouched staged build passes", async () => {
    const { p, bundle } = await staged();
    await expect(again(p, bundle)).resolves.toBeUndefined();
  });

  it("a file changed on disk since it was verified (same size) is caught by its hash", async () => {
    const { p, bundle } = await staged();
    const f = join(bundle, "Contents", "Resources", "data.txt");
    const bytes = readFileSync(f);
    bytes[0] = bytes[0]! ^ 1;
    writeFileSync(f, bytes);
    await expect(again(p, bundle)).rejects.toMatchObject({ code: "unpack" });
  });

  it("a file added, a link retargeted, a mode changed: the tree no longer is the list", async () => {
    const added = await staged();
    writeFileSync(join(added.bundle, "Contents", "Resources", "extra.js"), "x");
    await expect(again(added.p, added.bundle)).rejects.toMatchObject({ code: "unpack" });
    const linked = await staged();
    rmSync(join(linked.bundle, "Contents", "Resources", "alias.txt"));
    symlinkSync("/etc/hosts", join(linked.bundle, "Contents", "Resources", "alias.txt"));
    await expect(again(linked.p, linked.bundle)).rejects.toMatchObject({ code: "unpack" });
    const moded = await staged();
    chmodSync(join(moded.bundle, "Contents", "Info.plist"), 0o755);
    await expect(again(moded.p, moded.bundle)).rejects.toMatchObject({ code: "unpack" });
  });

  it("with a stable identity, the requirement is checked again too", async () => {
    const { p, bundle } = await staged();
    const calls: string[][] = [];
    const tools: RunTool = async (cmd, args) => {
      if (args.some((a) => a.startsWith("-R="))) {
        calls.push(args);
        return { status: 3, stdout: "", stderr: "" };
      }
      return run(cmd, args);
    };
    await expect(
      reverifyStaged({ stagedBundle: bundle, entries: p.entries, buildId: BUILD, version: "0.1.0", running: { bundleId: BUNDLE_ID, requirement: 'identifier "x"' } }, cfg, tools),
    ).rejects.toMatchObject({ code: "requirement" });
    expect(calls).toHaveLength(1);
  });
});
