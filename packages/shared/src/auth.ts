// Mutual authentication of a WebSocket connection between a client (the app, the updater, the screen MCP server,
// scripts) and the engine. The shared secret NEVER crosses the wire, and each side proves it holds it:
//
//   client → engine   auth.hello      { nonce: Nc, grant? }          (grant: the id of a scoped screen grant)
//   engine → client   auth.challenge  { nonce: Ne }
//   client → engine   auth.proof      { proof: HMAC(S, "kokpit-client" ‖ Ne ‖ Nc) }
//   engine → client   hello.ok        { …, proof: HMAC(S, "kokpit-engine" ‖ Nc ‖ Ne) }   — or close 4401
//
// S is the access key (UTF-8), or for a screen grant SHA-256 of the grant's token (the engine keeps only that
// digest). Nonces are 32 fresh random bytes; proofs are compared in constant time. The client treats the connection
// as authenticated only after it verified the ENGINE's proof, and sends nothing but the two auth frames before
// that. A server that does not hold S cannot produce `hello.ok`, but it does learn one client proof: an HMAC over
// two nonces it knows. That is a target for offline guessing — harmless only if S cannot be guessed, so an access
// key must be at least 32 random bytes (`isStrongAccessKey`): the engine refuses to start with a weaker one and the
// app refuses to save one. (Grant secrets are SHA-256 of 32 random bytes.)
//
// What this does NOT give: integrity of the frames AFTER the handshake. Plain `ws://` carries no channel binding, so
// a party on the network path between a real client and the real engine could relay the handshake and then read or
// change traffic. The engine is reached over loopback or Tailscale (WireGuard-encrypted), and app updates are
// accepted only over such a transport and only when signed (app-update-sign.ts) — see docs §2 and §21.
//
// Isomorphic: WebCrypto only (renderer, Electron main, Node).
import { z } from "zod";
import { st } from "./i18n/catalog.ts";
import { zm } from "./zod-message.ts";

export const AUTH_NONCE_BYTES = 32;

/** Random bytes an access key must carry at least (a captured proof must not allow offline guessing). */
export const ACCESS_KEY_MIN_BYTES = 32;
const STRONG_B64URL_RE = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((ACCESS_KEY_MIN_BYTES * 8) / 6)},}$`);
const STRONG_HEX_RE = new RegExp(`^[0-9a-fA-F]{${ACCESS_KEY_MIN_BYTES * 2},}$`);
/**
 * The form of a key made from ≥32 random bytes: base64url (≥43 chars) or hex (≥64 chars). A format check — it
 * cannot tell randomness — but it rules out every short or human-typed (spaces, punctuation) key.
 */
export function isStrongAccessKey(key: string): boolean {
  // A key made only of hex characters carries 4 bits each: judged as hex (else 48 hex chars = 24 bytes would pass).
  if (/^[0-9a-fA-F]+$/.test(key)) return STRONG_HEX_RE.test(key);
  return STRONG_B64URL_RE.test(key);
}
/** How to make one, in the current locale (shown in the app and in the engine's refusal). */
export function accessKeyRule(): string {
  return st("validation.auth.keyRule", { min: ACCESS_KEY_MIN_BYTES });
}
export const AUTH_LABELS = { client: "kokpit-client", engine: "kokpit-engine" } as const;
type Label = (typeof AUTH_LABELS)[keyof typeof AUTH_LABELS];

/** 32 bytes, base64url without padding. */
const B64_32_RE = /^[A-Za-z0-9_-]{43}$/;
export const NonceSchema = z.string().regex(B64_32_RE, zm("validation.auth.nonce"));
export const ProofSchema = z.string().regex(B64_32_RE, zm("validation.auth.proof"));
/** A screen grant's public id (a UUID); the secret token never travels. */
export const GrantIdSchema = z.string().regex(/^[0-9a-f-]{8,64}$/, zm("validation.auth.grantId"));

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += B64URL[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of text) {
    value = (value << 6) | B64URL.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

export function newNonce(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(AUTH_NONCE_BYTES)));
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The HMAC secret of the access key. */
export function keySecret(key: string): Uint8Array {
  return utf8(key);
}

/** The HMAC secret of a screen grant: SHA-256 of its token (what the engine stores). */
export async function grantSecret(token: string): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", utf8(token) as BufferSource));
}

/** `HMAC-SHA256(secret, label ‖ first ‖ second)`, the nonces as their raw bytes; base64url. */
export async function authProof(secret: Uint8Array, label: Label, first: string, second: string): Promise<string> {
  const a = fromBase64Url(first);
  const b = fromBase64Url(second);
  if (!a || !b || a.length !== AUTH_NONCE_BYTES || b.length !== AUTH_NONCE_BYTES) throw new Error("bad nonce");
  const key = await globalThis.crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const labelBytes = utf8(label);
  const data = new Uint8Array(labelBytes.length + a.length + b.length);
  data.set(labelBytes, 0);
  data.set(a, labelBytes.length);
  data.set(b, labelBytes.length + a.length);
  return toBase64Url(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, data as BufferSource)));
}

/** Constant-time equality of two strings of the same alphabet (length is not secret). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when `proof` is the right proof; false for anything malformed. */
export async function proofMatches(secret: Uint8Array, label: Label, first: string, second: string, proof: unknown): Promise<boolean> {
  if (typeof proof !== "string" || !B64_32_RE.test(proof)) return false;
  try {
    return constantTimeEqual(await authProof(secret, label, first, second), proof);
  } catch {
    return false;
  }
}

/** What a client authenticates with. */
export type AuthCredential =
  /** The engine's access key (the app, scripts). */
  | { kind: "key"; key: string }
  /** A scoped screen grant: its public id and its secret token. */
  | { kind: "grant"; grantId: string; token: string };

/** A screen grant as one string (`<id>.<token>`), as the engine hands it to the screen MCP server. */
export function formatGrantCredential(grantId: string, token: string): string {
  return `${grantId}.${token}`;
}

export function parseGrantCredential(text: string): AuthCredential | undefined {
  const dot = text.indexOf(".");
  if (dot <= 0) return undefined;
  const grantId = text.slice(0, dot);
  const token = text.slice(dot + 1);
  return GrantIdSchema.safeParse(grantId).success && token.length > 0 ? { kind: "grant", grantId, token } : undefined;
}

/** How a handshake ended, as far as the client can tell. */
export type HandshakeFailure =
  /** The server closed with 4401 before it ever sent a challenge: an engine from before this protocol. */
  | "outdated-engine"
  /** The engine refused the proof (wrong key, unknown or revoked grant). */
  | "unauthorized"
  /** The server's `hello.ok` carried no valid proof: it is not the engine that holds the secret. */
  | "unverified"
  /** Something else out of order. */
  | "protocol";

export interface HelloOkFrame {
  type: "hello.ok";
  engineVersion: string;
  engineBuild: { buildId: string; version: string; commit: string; builtAt: string };
  protocol: number;
  proof: string;
}

export type HandshakeStep =
  /** Send this frame and wait for the next one. */
  | { kind: "send"; frame: { type: "auth.proof"; proof: string } }
  /** Authenticated: the engine proved itself. */
  | { kind: "ok"; hello: HelloOkFrame }
  | { kind: "fail"; reason: HandshakeFailure };

export interface ClientHandshake {
  /** The first frame to send once the socket is open. */
  hello(): { type: "auth.hello"; nonce: string; grant?: string };
  /** A frame received before authentication (already parsed). */
  receive(frame: { type: string; [k: string]: unknown }): Promise<HandshakeStep>;
  /** What a close with `code` before `ok` means. */
  closed(code: number): HandshakeFailure;
}

/** Close code of a refused authentication (same value as CLOSE_CODES.UNAUTHORIZED). */
const UNAUTHORIZED = 4401;

export function createClientHandshake(credential: AuthCredential): ClientHandshake {
  const clientNonce = newNonce();
  let stage: "hello" | "proof-sent" | "done" = "hello";
  let serverNonce = "";
  let secret: Promise<Uint8Array> | undefined;
  const secretOf = (): Promise<Uint8Array> => (secret ??= credential.kind === "key" ? Promise.resolve(keySecret(credential.key)) : grantSecret(credential.token));
  return {
    hello: () => ({ type: "auth.hello", nonce: clientNonce, ...(credential.kind === "grant" ? { grant: credential.grantId } : {}) }),
    async receive(frame) {
      if (stage === "hello" && frame.type === "auth.challenge" && NonceSchema.safeParse(frame.nonce).success) {
        serverNonce = frame.nonce as string;
        // A server that echoes our own nonce is trying to make us answer its own challenge.
        if (serverNonce === clientNonce) return { kind: "fail", reason: "protocol" };
        stage = "proof-sent";
        return { kind: "send", frame: { type: "auth.proof", proof: await authProof(await secretOf(), AUTH_LABELS.client, serverNonce, clientNonce) } };
      }
      if (stage === "proof-sent" && frame.type === "hello.ok") {
        stage = "done";
        const ok = await proofMatches(await secretOf(), AUTH_LABELS.engine, clientNonce, serverNonce, frame.proof);
        return ok ? { kind: "ok", hello: frame as unknown as HelloOkFrame } : { kind: "fail", reason: "unverified" };
      }
      // `hello.ok` before a challenge (an impostor, or an engine from before this protocol answering something else).
      return { kind: "fail", reason: frame.type === "hello.ok" ? "unverified" : "protocol" };
    },
    closed: (code) => (code === UNAUTHORIZED ? (stage === "hello" ? "outdated-engine" : "unauthorized") : "protocol"),
  };
}

/** Text for the user, per failure, in the current locale (i18n: each property is read at use). */
export const HANDSHAKE_MESSAGES: Readonly<Record<HandshakeFailure, string>> = {
  get "outdated-engine"() {
    return st("validation.auth.handshake.outdatedEngine");
  },
  get unauthorized() {
    return st("validation.auth.handshake.unauthorized");
  },
  get unverified() {
    return st("validation.auth.handshake.unverified");
  },
  get protocol() {
    return st("validation.auth.handshake.protocol");
  },
};
