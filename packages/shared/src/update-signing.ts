// Kendini güncelleme: the publisher key that signs app updates (Ed25519). Node only — the engine's publish step,
// the app's build script and the app's main process; not part of the package's main entry.
//
// The key pair lives in ONE folder outside the repo (engine config `appUpdates.signingKeyDir`, default
// `~/.config/kokpit/app-signing`): `private.pem` (PKCS#8, 0600) and `public.key` (the raw 32-byte key, base64).
// The deploy step creates it once (`publish-app.ts keygen`); the app's build embeds the PUBLIC key; the publish step
// signs every published build with the private key; the app refuses any update not signed by the key it carries.
//
// Honest limit: the private key sits on the same machine as the engine. The signature protects against anyone on
// the network (an impostor at the engine's address) and against a leak of the engine's ACCESS key; it does not
// protect against someone who controls the engine Mac's user account — they can read this folder.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonicalEntries, signedPayload, type SignedManifestFields } from "./app-update-sign.ts";

export const SIGNING_PRIVATE_FILE = "private.pem";
export const SIGNING_PUBLIC_FILE = "public.key";
const RAW_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class SigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningKeyError";
  }
}

export interface SigningKey {
  privateKey: KeyObject;
  /** Raw public key, base64. */
  publicKey: string;
  /** First 16 hex digits of SHA-256 of the raw public key: names the key in manifests and messages. */
  keyId: string;
}

export function keyIdOf(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 16);
}

function rawPublicKey(pub: KeyObject): string {
  const der = pub.export({ type: "spki", format: "der" });
  return der.subarray(der.length - RAW_KEY_BYTES).toString("base64");
}

/** The folder must be ours alone: a real folder (no link), owned by this user, nobody else may enter it. */
function checkPrivateDir(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SigningKeyError(`${dir} is not a folder (or is a link)`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new SigningKeyError(`${dir} belongs to another user`);
  if ((st.mode & 0o077) !== 0) throw new SigningKeyError(`${dir} can be read by others (mode ${(st.mode & 0o777).toString(8)}; must be 700)`);
}

function readPrivate(path: string): KeyObject {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SigningKeyError(`${path} is not a file`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new SigningKeyError(`${path} belongs to another user`);
    if ((st.mode & 0o077) !== 0) throw new SigningKeyError(`${path} can be read by others (must be 600)`);
    const key = createPrivateKey(readFileSync(fd));
    if (key.asymmetricKeyType !== "ed25519") throw new SigningKeyError(`${path} is not an Ed25519 key`);
    return key;
  } finally {
    closeSync(fd);
  }
}

function writeExclusive(path: string, data: string, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** The key pair in `dir`; created (once) when the folder holds none. */
export function ensureSigningKey(dir: string): SigningKey {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkPrivateDir(dir);
  const privatePath = join(dir, SIGNING_PRIVATE_FILE);
  let privateKey: KeyObject;
  try {
    privateKey = readPrivate(privatePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const pair = generateKeyPairSync("ed25519");
    writeExclusive(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 0o600);
    privateKey = readPrivate(privatePath);
  }
  const publicKey = rawPublicKey(createPublicKey(privateKey));
  const publicPath = join(dir, SIGNING_PUBLIC_FILE);
  let stored: string | undefined;
  try {
    stored = readFileSync(publicPath, "utf8").trim();
  } catch {
    writeExclusive(publicPath, `${publicKey}\n`, 0o644);
    stored = publicKey;
  }
  if (stored !== publicKey) throw new SigningKeyError(`${publicPath} does not belong to ${privatePath}`);
  return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}

/** The public key in `dir`, or undefined when there is none (nothing is created). For the app's build. */
export function readSigningPublicKey(dir: string): string | undefined {
  try {
    const key = readFileSync(join(dir, SIGNING_PUBLIC_FILE), "utf8").trim();
    return isPublicKey(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

export function isPublicKey(b64: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(b64) && Buffer.from(b64, "base64").length === RAW_KEY_BYTES;
}

/** SHA-256 (hex) of an entry list as signed (canonicalEntries); undefined for something that is not a list. */
export function entriesSha256(entries: unknown): string | undefined {
  const text = canonicalEntries(entries);
  return text === undefined ? undefined : createHash("sha256").update(text).digest("hex");
}

export function signManifest(key: SigningKey, fields: SignedManifestFields): string {
  return sign(null, Buffer.from(signedPayload(fields)), key.privateKey).toString("base64");
}

/** True only for a well-formed signature by `publicKeyB64` over exactly these fields. */
export function verifyManifest(publicKeyB64: string, fields: SignedManifestFields, signatureB64: unknown): boolean {
  if (!isPublicKey(publicKeyB64) || typeof signatureB64 !== "string") return false;
  const sig = Buffer.from(signatureB64, "base64");
  if (sig.length !== SIGNATURE_BYTES || sig.toString("base64") !== signatureB64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64, "base64")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(signedPayload(fields)), key, sig);
  } catch {
    return false;
  }
}
