import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalEntries, signedPayload, type SignedManifestFields } from "./app-update-sign.ts";
import { ensureSigningKey, entriesSha256, keyIdOf, readSigningPublicKey, signManifest, SigningKeyError, verifyManifest } from "./update-signing.ts";

const root = mkdtempSync(join(tmpdir(), "kokpit-signing-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = (): string => join(root, `k${n++}`);

const FIELDS: SignedManifestFields = {
  buildId: "0.1.0+20261118100000.abc",
  version: "0.1.0",
  format: 1,
  bundleName: "Kokpit.app",
  sha256: "a".repeat(64),
  size: 10,
  unpackedSize: 30,
  entryCount: 3,
  entriesSha256: "b".repeat(64),
  createdAt: "2026-11-18T12:00:00.000Z",
};

describe("publisher key", () => {
  it("is created once: a private key only its owner can read, the public key next to it", () => {
    const d = dir();
    const a = ensureSigningKey(d);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(statSync(join(d, "private.pem")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(d, "private.pem"), "utf8")).toContain("BEGIN PRIVATE KEY");
    expect(readSigningPublicKey(d)).toBe(a.publicKey);
    expect(a.keyId).toBe(keyIdOf(a.publicKey));
    // Again: the same key, not a new one.
    expect(ensureSigningKey(d).publicKey).toBe(a.publicKey);
  });

  it("no key → the build reads none and creates none", () => {
    const d = dir();
    expect(readSigningPublicKey(d)).toBeUndefined();
    expect(() => statSync(d)).toThrow();
  });

  it("refuses a folder others can read, a folder that is a link, a private key others can read, a mismatched public key", () => {
    const open = dir();
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => ensureSigningKey(open)).toThrow(SigningKeyError);

    const real = dir();
    ensureSigningKey(real);
    const link = dir();
    symlinkSync(real, link);
    expect(() => ensureSigningKey(link)).toThrow(SigningKeyError);

    const loose = dir();
    ensureSigningKey(loose);
    chmodSync(join(loose, "private.pem"), 0o644);
    expect(() => ensureSigningKey(loose)).toThrow("600");

    const mixed = dir();
    ensureSigningKey(mixed);
    writeFileSync(join(mixed, "public.key"), `${ensureSigningKey(dir()).publicKey}\n`);
    expect(() => ensureSigningKey(mixed)).toThrow("does not belong");
  });
});

describe("signatures", () => {
  const key = ensureSigningKey(join(root, "sig"));
  const sig = signManifest(key, FIELDS);

  it("verify with the right key over exactly these fields", () => {
    expect(verifyManifest(key.publicKey, FIELDS, sig)).toBe(true);
  });

  it.each(Object.keys(FIELDS).map((k) => [k]))("any change of %s breaks it", (field) => {
    const v = FIELDS[field as keyof SignedManifestFields];
    const changed = { ...FIELDS, [field]: typeof v === "number" ? v + 1 : `${String(v)}x` };
    expect(verifyManifest(key.publicKey, changed, sig)).toBe(false);
  });

  it("adding a minimum engine build breaks it too", () => {
    expect(verifyManifest(key.publicKey, { ...FIELDS, minEngineBuild: "0.1.0+20991231000000.x" }, sig)).toBe(false);
  });

  it("another key, a malformed or truncated signature, a malformed key: never valid", () => {
    expect(verifyManifest(ensureSigningKey(dir()).publicKey, FIELDS, sig)).toBe(false);
    for (const bad of [undefined, "", "x", sig.slice(0, -4), `${sig}AA`, "A".repeat(86) + "=="]) expect(verifyManifest(key.publicKey, FIELDS, bad)).toBe(false);
    for (const badKey of ["", "x", "A".repeat(44)]) expect(verifyManifest(badKey, FIELDS, sig)).toBe(false);
  });

  it("the payload names the build time explicitly", () => {
    expect(signedPayload(FIELDS)).toContain('"20261118100000"');
  });
});

describe("entry list hash", () => {
  const list = [
    { path: "Contents", type: "dir" },
    { path: "Contents/a", type: "file", mode: 0o644, size: 1, sha256: "c".repeat(64) },
    { path: "Contents/l", type: "symlink", target: "a" },
  ];

  it("is over a fixed field order: key order in the JSON does not matter, values and order of entries do", () => {
    const reordered = list.map((e) => Object.fromEntries(Object.entries(e).reverse()));
    expect(entriesSha256(reordered)).toBe(entriesSha256(list));
    expect(entriesSha256([list[0], list[2], list[1]])).not.toBe(entriesSha256(list));
    expect(entriesSha256([list[0], { ...list[1], mode: 0o755 }, list[2]])).not.toBe(entriesSha256(list));
    expect(entriesSha256([list[0], list[1], { ...list[2], target: "b" }])).not.toBe(entriesSha256(list));
  });

  it("is undefined for anything that is not a list of objects", () => {
    for (const bad of [undefined, null, "x", {}, [1], [null], [[]]]) expect(canonicalEntries(bad)).toBeUndefined();
  });
});
