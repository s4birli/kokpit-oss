// İş F — Dosyalar: protocol additions.
import { describe, expect, it } from "vitest";
import { FileEntrySchema, FileMediaUrlSchema, FileReadResultSchema, FILES_LIMITS, FILES_MEDIA_HTTP_PREFIX, isFilesMediaTokenPath, parseClientMessage } from "./protocol.ts";

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));
const ok = (m: unknown) => parse(m).ok;
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });

describe("dosyalar protokolü", () => {
  it.each(["files.list", "files.read", "files.mediaUrl"])("%s takes exactly one of projectId / cardId and a path", (method) => {
    expect(ok(req(method, { projectId: "p1", path: "" }))).toBe(true);
    expect(ok(req(method, { cardId: "c1", path: "src/a.ts" }))).toBe(true);
    // Shape only: traversal is the engine's job (it answers INVALID); the frame itself is well-formed.
    expect(ok(req(method, { projectId: "p1", path: "../x" }))).toBe(true);
  });

  it.each([
    ["no target", { path: "" }],
    ["both targets", { projectId: "p1", cardId: "c1", path: "" }],
    ["missing path", { projectId: "p1" }],
    ["non-string path", { projectId: "p1", path: 3 }],
    ["overlong path", { projectId: "p1", path: "a".repeat(FILES_LIMITS.maxPathChars + 1) }],
    ["extra field", { projectId: "p1", path: "", root: "/" }],
  ])("rejects %s", (_n, params) => {
    for (const method of ["files.list", "files.read", "files.mediaUrl"]) {
      const r = parse(req(method, params));
      expect(r.ok).toBe(false);
      // A bad request answers INVALID instead of closing the socket.
      if (!r.ok) expect(r.badRequest?.method).toBe(method);
    }
  });

  it("describes entries and read results", () => {
    expect(FileEntrySchema.safeParse({ name: "a.ts", kind: "file", size: 3 }).success).toBe(true);
    expect(FileEntrySchema.safeParse({ name: "src", kind: "dir" }).success).toBe(true);
    expect(FileEntrySchema.safeParse({ name: "l", kind: "symlink", target: "dir" }).success).toBe(true);
    expect(FileEntrySchema.safeParse({ name: "x", kind: "socket" }).success).toBe(false);
    expect(FileReadResultSchema.safeParse({ text: "hi", size: 2, truncated: false }).success).toBe(true);
    expect(FileReadResultSchema.safeParse({ binary: true, size: 9, truncated: false }).success).toBe(true);
    expect(FileReadResultSchema.safeParse({ size: 2 }).success).toBe(false);
  });

  const TOKEN = "A".repeat(43);

  it("recognises only well-formed media token paths", () => {
    expect(isFilesMediaTokenPath(`${FILES_MEDIA_HTTP_PREFIX}${TOKEN}`)).toBe(true);
    for (const bad of [
      FILES_MEDIA_HTTP_PREFIX,
      `${FILES_MEDIA_HTTP_PREFIX}kisa`,
      `${FILES_MEDIA_HTTP_PREFIX}${TOKEN}/x`,
      `${FILES_MEDIA_HTTP_PREFIX}${TOKEN}?a=1`,
      `${FILES_MEDIA_HTTP_PREFIX}../${TOKEN}`,
      `${FILES_MEDIA_HTTP_PREFIX}${TOKEN}%2e`,
      `/map/${TOKEN}`,
      `/files/media${TOKEN}`,
      `x${FILES_MEDIA_HTTP_PREFIX}${TOKEN}`,
      `${FILES_MEDIA_HTTP_PREFIX}${"A".repeat(201)}`,
    ]) {
      expect(isFilesMediaTokenPath(bad), bad).toBe(false);
    }
  });

  it("files.mediaRevoke takes one token path and nothing else", () => {
    expect(ok(req("files.mediaRevoke", { path: `${FILES_MEDIA_HTTP_PREFIX}${TOKEN}` }))).toBe(true);
    for (const params of [{}, { path: "/etc/passwd" }, { path: `${FILES_MEDIA_HTTP_PREFIX}${TOKEN}`, projectId: "p1" }, { path: 3 }]) {
      const r = parse(req("files.mediaRevoke", params));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.badRequest?.method).toBe("files.mediaRevoke");
    }
  });

  it("describes media kinds and media URLs", () => {
    expect(FileReadResultSchema.safeParse({ binary: true, size: 9, truncated: false, media: "video" }).success).toBe(true);
    expect(FileReadResultSchema.safeParse({ binary: true, size: 9, truncated: false, media: "html" }).success).toBe(false);
    const url = { path: `${FILES_MEDIA_HTTP_PREFIX}${TOKEN}`, kind: "video", mime: "video/mp4", size: 10, expiresAt: "2026-01-01T00:00:00.000Z" };
    expect(FileMediaUrlSchema.safeParse(url).success).toBe(true);
    expect(FileMediaUrlSchema.safeParse({ ...url, path: "http://evil.example/x" }).success).toBe(false);
    expect(FileMediaUrlSchema.safeParse({ ...url, kind: "script" }).success).toBe(false);
  });
});
