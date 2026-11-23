import { describe, expect, it } from "vitest";
import {
  AppUpdateManifestSchema,
  BuildIdSchema,
  PROTOCOL_VERSION,
  buildStamp,
  decideCompat,
  decideUpdate,
  isAppUpdateTokenPath,
  makeBuildId,
  satisfiesMinBuild,
  type AppUpdateManifest,
} from "./app-update.ts";
import { parseClientMessage, parseServerMessage } from "./protocol.ts";

const A = makeBuildId("0.1.0", "abc1234", new Date("2026-11-18T10:00:00Z"));
const B = makeBuildId("0.1.0", "def5678", new Date("2026-11-18T11:30:05Z"));
const manifest = (buildId: string): AppUpdateManifest => ({ buildId, version: "0.1.0", format: 1, bundleName: "Kokpit.app", sha256: "a".repeat(64), size: 10, unpackedSize: 30, entryCount: 3, createdAt: "2026-11-18T12:00:00.000Z", entriesSha256: "b".repeat(64), signingKeyId: "c".repeat(16), signature: `${"A".repeat(86)}==` });

describe("build ids", () => {
  it("carry version, UTC build time and commit, and are valid folder names", () => {
    expect(A).toBe("0.1.0+20261118100000.abc1234");
    expect(BuildIdSchema.safeParse(A).success).toBe(true);
    expect(buildStamp(B)).toBe("20261118113005");
  });

  it.each(["", "../x", "a/b", ".hidden", "a b", "x".repeat(121), "backup", "BACKUP", "builds", "profiles", "downloads"])("refuses %j", (id) => {
    expect(BuildIdSchema.safeParse(id).success).toBe(false);
  });

  it("minimum engine build compares build times; unknown shapes never satisfy", () => {
    expect(satisfiesMinBuild(B, A)).toBe(true);
    expect(satisfiesMinBuild(A, A)).toBe(true);
    expect(satisfiesMinBuild(A, B)).toBe(false);
    expect(satisfiesMinBuild("dev", A)).toBe(false);
    expect(satisfiesMinBuild(A, "dev")).toBe(false);
  });
});

describe("compatibility", () => {
  it("same number is ok; an engine without a number or behind is older; ahead means the app is older", () => {
    expect(decideCompat(3, 3)).toBe("ok");
    expect(decideCompat(3, undefined)).toBe("engine-older");
    expect(decideCompat(3, 2)).toBe("engine-older");
    expect(decideCompat(3, 4)).toBe("app-older");
  });
});

describe("update decision", () => {
  it("nothing published or already that build → none", () => {
    expect(decideUpdate(A, null, [])).toEqual({ kind: "none" });
    expect(decideUpdate(A, manifest(A), [])).toEqual({ kind: "none" });
  });

  it("a different published build is the target, also when it is older (a release taken back)", () => {
    expect(decideUpdate(A, manifest(B), []).kind).toBe("update");
    expect(decideUpdate(B, manifest(A), []).kind).toBe("update");
  });

  it("a build marked bad on this client is not tried again", () => {
    expect(decideUpdate(A, manifest(B), [B]).kind).toBe("bad");
  });
});

describe("manifest", () => {
  it.each([
    ["upper-case hash", { sha256: "A".repeat(64) }],
    ["short hash", { sha256: "ab" }],
    ["zero size", { size: 0 }],
    ["path as build id", { buildId: "../../etc" }],
  ])("refuses %s", (_n, patch) => {
    expect(AppUpdateManifestSchema.safeParse({ ...manifest(A), ...patch }).success).toBe(false);
  });
});

describe("download path", () => {
  it("is the prefix and one token, nothing else", () => {
    const token = "t".repeat(43);
    expect(isAppUpdateTokenPath(`/app-updates/${token}`)).toBe(true);
    for (const bad of [`/app-updates/${token}/x`, `/app-updates/${token}?a=1`, "/app-updates/../x", "/app-updates/short", `/files/media/${token}`]) {
      expect(isAppUpdateTokenPath(bad)).toBe(false);
    }
  });
});

describe("wire", () => {
  const build = { buildId: A, version: "0.1.0", commit: "abc1234", builtAt: "2026-11-18T10:00:00.000Z" };

  it("hello.ok carries the engine's build, protocol number and its proof — all required", () => {
    const proof = "p".repeat(43);
    const withIdentity = parseServerMessage(JSON.stringify({ type: "hello.ok", engineVersion: "0.1.0", engineBuild: build, protocol: PROTOCOL_VERSION, proof }));
    expect(withIdentity).toMatchObject({ ok: true, value: { engineBuild: build, protocol: PROTOCOL_VERSION, proof } });
    expect(parseServerMessage(JSON.stringify({ type: "hello.ok", engineVersion: "0.1.0" })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ type: "hello.ok", engineVersion: "0.1.0", engineBuild: build, protocol: PROTOCOL_VERSION })).ok).toBe(false);
  });

  it("app.update.check carries the app's build and protocol number", () => {
    const req = (params: unknown) => parseClientMessage(JSON.stringify({ type: "req", id: 1, method: "app.update.check", params }));
    expect(req({ clientId: "client-0001", app: build, protocol: PROTOCOL_VERSION }).ok).toBe(true);
    expect(req({ clientId: "client-0001", app: { ...build, buildId: "../x" }, protocol: PROTOCOL_VERSION }).ok).toBe(false);
    expect(req({ clientId: "x", app: build, protocol: PROTOCOL_VERSION }).ok).toBe(false);
  });

  it("a request with an unknown method is a well-formed request: it can be answered, not only dropped", () => {
    const r = parseClientMessage(JSON.stringify({ type: "req", id: 9, method: "future.method", params: { a: 1 } }));
    expect(r).toMatchObject({ ok: false, unknownMethod: { id: 9, method: "future.method" } });
  });

  it.each([
    ["no id", { type: "req", method: "future.method", params: {} }],
    ["params not an object", { type: "req", id: 1, method: "future.method", params: [] }],
    ["method not a string", { type: "req", id: 1, method: 5, params: {} }],
    ["method too long", { type: "req", id: 1, method: "m".repeat(201), params: {} }],
    ["extra envelope key", { type: "req", id: 1, method: "future.method", params: {}, x: 1 }],
  ])("a malformed envelope (%s) is not an unknown method", (_n, frame) => {
    const r = parseClientMessage(JSON.stringify(frame));
    expect(r.ok).toBe(false);
    expect((r as { unknownMethod?: unknown }).unknownMethod).toBeUndefined();
  });

  it("the error code for it exists", () => {
    const res = { type: "res", id: 1, ok: false, error: { code: "UNKNOWN_METHOD", message: "x" } };
    expect(parseServerMessage(JSON.stringify(res)).ok).toBe(true);
  });
});
