import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accessKeyRule,
  isStrongAccessKey,
  AUTH_LABELS,
  authProof,
  constantTimeEqual,
  createClientHandshake,
  formatGrantCredential,
  fromBase64Url,
  grantSecret,
  keySecret,
  newNonce,
  parseGrantCredential,
  proofMatches,
  toBase64Url,
} from "./auth.ts";

const KEY = "the-shared-access-key-0123456789";
const b64 = (b: Buffer) => b.toString("base64url");

/** The engine's side, written independently with node:crypto, so the two implementations check each other. */
function engineProof(secret: Buffer | string, label: string, first: string, second: string): string {
  return b64(createHmac("sha256", secret).update(Buffer.concat([Buffer.from(label), Buffer.from(first, "base64url"), Buffer.from(second, "base64url")])).digest());
}

describe("encoding", () => {
  it("base64url round-trips every length and matches Node's", () => {
    for (let n = 0; n < 70; n++) {
      const bytes = randomBytes(n);
      expect(toBase64Url(bytes)).toBe(b64(bytes));
      expect(Buffer.from(fromBase64Url(b64(bytes))!).equals(bytes)).toBe(true);
    }
    expect(fromBase64Url("a+b/")).toBeUndefined();
    expect(fromBase64Url("a")).toBeUndefined();
  });

  it("nonces are 32 fresh random bytes", () => {
    const seen = new Set(Array.from({ length: 200 }, newNonce));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(fromBase64Url(n)!.length).toBe(32);
  });
});

describe("proofs", () => {
  const a = newNonce();
  const b = newNonce();

  it("are HMAC-SHA256(secret, label ‖ first ‖ second) over the raw nonce bytes", async () => {
    expect(await authProof(keySecret(KEY), AUTH_LABELS.client, a, b)).toBe(engineProof(KEY, "kokpit-client", a, b));
    expect(await authProof(keySecret(KEY), AUTH_LABELS.engine, b, a)).toBe(engineProof(KEY, "kokpit-engine", b, a));
  });

  it("a client proof is never an engine proof, and order matters (no reflection)", async () => {
    const client = await authProof(keySecret(KEY), AUTH_LABELS.client, a, b);
    expect(await proofMatches(keySecret(KEY), AUTH_LABELS.engine, a, b, client)).toBe(false);
    expect(await proofMatches(keySecret(KEY), AUTH_LABELS.client, b, a, client)).toBe(false);
    expect(await proofMatches(keySecret(KEY), AUTH_LABELS.client, a, b, client)).toBe(true);
    expect(await proofMatches(keySecret("another-key-of-the-same-length!!"), AUTH_LABELS.client, a, b, client)).toBe(false);
  });

  it.each([undefined, 5, "", "x".repeat(43), "!".repeat(43), "a".repeat(44)])("a malformed proof %j never matches", async (p) => {
    expect(await proofMatches(keySecret(KEY), AUTH_LABELS.client, a, b, p)).toBe(false);
  });

  it("refuses nonces that are not 32 bytes", async () => {
    await expect(authProof(keySecret(KEY), AUTH_LABELS.client, "abc", b)).rejects.toThrow();
  });

  it("constant-time compare is plain equality", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });

  it("a grant's secret is SHA-256 of its token (what the engine stores)", async () => {
    expect(Buffer.from(await grantSecret("tok")).equals(createHash("sha256").update("tok").digest())).toBe(true);
  });
});

describe("grant credential", () => {
  it("is `<id>.<token>`; the id is public, the token secret", () => {
    const id = "3b1f0c2e-1d2a-4c5b-9e8f-0123456789ab";
    expect(parseGrantCredential(formatGrantCredential(id, "ab.cd"))).toEqual({ kind: "grant", grantId: id, token: "ab.cd" });
    for (const bad of ["", ".tok", "ID.tok", "../x.tok", "id-only"]) expect(parseGrantCredential(bad)).toBeUndefined();
  });
});

/** Plays a REAL engine with node:crypto. */
async function realEngine(handshake: ReturnType<typeof createClientHandshake>, secret: Buffer | string) {
  const hello = handshake.hello();
  const serverNonce = b64(randomBytes(32));
  const step = await handshake.receive({ type: "auth.challenge", nonce: serverNonce });
  if (step.kind !== "send") throw new Error(`expected a proof, got ${step.kind}`);
  const clientOk = step.frame.proof === engineProof(secret, "kokpit-client", serverNonce, hello.nonce);
  const ok = await handshake.receive({ type: "hello.ok", engineVersion: "0", engineBuild: {}, protocol: 2, proof: engineProof(secret, "kokpit-engine", hello.nonce, serverNonce) });
  return { hello, clientOk, ok };
}

describe("client handshake", () => {
  it("the key never appears in any frame; both sides prove themselves", async () => {
    const h = createClientHandshake({ kind: "key", key: KEY });
    const r = await realEngine(h, KEY);
    expect(JSON.stringify(r.hello)).not.toContain(KEY);
    expect(r.clientOk).toBe(true);
    expect(r.ok.kind).toBe("ok");
  });

  it("a grant connection names only the grant id; the token never travels", async () => {
    const id = "3b1f0c2e-1d2a-4c5b-9e8f-0123456789ab";
    const h = createClientHandshake({ kind: "grant", grantId: id, token: "secret-token" });
    const r = await realEngine(h, createHash("sha256").update("secret-token").digest());
    expect(r.hello).toEqual({ type: "auth.hello", nonce: r.hello.nonce, grant: id });
    expect(r.clientOk).toBe(true);
    expect(r.ok.kind).toBe("ok");
  });

  it("an impostor without the key: gets an HMAC, never the key, and its hello.ok is refused", async () => {
    const h = createClientHandshake({ kind: "key", key: KEY });
    const sent: string[] = [JSON.stringify(h.hello())];
    const step = await h.receive({ type: "auth.challenge", nonce: newNonce() });
    if (step.kind === "send") sent.push(JSON.stringify(step.frame));
    expect(sent.join("\n")).not.toContain(KEY);
    for (const proof of [undefined, "", newNonce(), "A".repeat(43)]) {
      const again = createClientHandshake({ kind: "key", key: KEY });
      again.hello();
      await again.receive({ type: "auth.challenge", nonce: newNonce() });
      expect(await again.receive({ type: "hello.ok", engineVersion: "0", engineBuild: {}, protocol: 2, proof })).toEqual({ kind: "fail", reason: "unverified" });
    }
  });

  it("hello.ok without a challenge (the old protocol, or an impostor skipping it) is refused", async () => {
    const h = createClientHandshake({ kind: "key", key: KEY });
    h.hello();
    expect(await h.receive({ type: "hello.ok", engineVersion: "0" })).toEqual({ kind: "fail", reason: "unverified" });
  });

  it("a challenge that echoes the client's own nonce is refused (reflection)", async () => {
    const h = createClientHandshake({ kind: "key", key: KEY });
    expect(await h.receive({ type: "auth.challenge", nonce: h.hello().nonce })).toEqual({ kind: "fail", reason: "protocol" });
  });

  it("a second challenge, a malformed challenge or any other frame is a protocol failure", async () => {
    const h = createClientHandshake({ kind: "key", key: KEY });
    h.hello();
    expect((await h.receive({ type: "auth.challenge", nonce: "short" })).kind).toBe("fail");
    const h2 = createClientHandshake({ kind: "key", key: KEY });
    h2.hello();
    await h2.receive({ type: "auth.challenge", nonce: newNonce() });
    expect(await h2.receive({ type: "auth.challenge", nonce: newNonce() })).toEqual({ kind: "fail", reason: "protocol" });
    expect(await createClientHandshake({ kind: "key", key: KEY }).receive({ type: "res", id: 1 })).toEqual({ kind: "fail", reason: "protocol" });
  });

  it("4401 before any challenge = an engine from before this protocol; after the proof = key refused", async () => {
    const h = createClientHandshake({ kind: "key", key: KEY });
    h.hello();
    expect(h.closed(4401)).toBe("outdated-engine");
    await h.receive({ type: "auth.challenge", nonce: newNonce() });
    expect(h.closed(4401)).toBe("unauthorized");
    expect(h.closed(1006)).toBe("protocol");
  });

  it("every handshake uses a fresh nonce", () => {
    expect(createClientHandshake({ kind: "key", key: KEY }).hello().nonce).not.toBe(createClientHandshake({ kind: "key", key: KEY }).hello().nonce);
  });
});

describe("access key strength (one captured proof must not allow offline guessing)", () => {
  it("accepts 32+ random bytes as base64url (43+) or hex (64+)", () => {
    expect(isStrongAccessKey(randomBytes(32).toString("base64url"))).toBe(true);
    expect(isStrongAccessKey(randomBytes(32).toString("hex"))).toBe(true);
    expect(isStrongAccessKey(randomBytes(48).toString("base64url"))).toBe(true);
  });
  it.each([
    ["a human phrase", "kokpit-mac-mini-2026"],
    ["24 random bytes in hex (48 chars)", "ab".repeat(24)],
    ["42 base64url chars", "A".repeat(42)],
    ["standard base64 with + and /", `${randomBytes(32).toString("base64")}`.replace(/[A-Za-z]/, "+").padEnd(44, "/")],
    ["spaces", `${randomBytes(32).toString("base64url")} `],
    ["empty", ""],
  ])("refuses %s", (_n, key) => {
    expect(isStrongAccessKey(key)).toBe(false);
  });
  it("the rule text says how to make one", () => {
    expect(accessKeyRule()).toMatch(/32/);
    expect(accessKeyRule()).toMatch(/randomBytes|openssl/);
  });
});
