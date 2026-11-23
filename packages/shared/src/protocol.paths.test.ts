// Yollar: protocol additions — a path a terminal printed (files.locate, files.previewUrl, browser.openFile), the
// preview address and the "show the browser" event.
import { describe, expect, it } from "vitest";
import { PATH_LIMITS } from "./local-path.ts";
import {
  FILES_MEDIA_HTTP_PREFIX,
  FILES_PREVIEW_HTTP_PREFIX,
  FileLocationSchema,
  FilePreviewUrlSchema,
  parseClientMessage,
  parseFilesPreviewPath,
  parseServerMessage,
  ProjectSchema,
} from "./protocol.ts";

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));
const req = (method: string, params: unknown) => ({ type: "req", id: 1, method, params });
const METHODS = ["files.locate", "files.previewUrl", "browser.openFile"];
const TOKEN = "A".repeat(43);

describe("yollar protokolü", () => {
  it.each(METHODS)("%s takes a path and exactly one of terminalId / cardId / projectId", (method) => {
    expect(parse(req(method, { terminalId: "t1", path: "~/Documents/rapor/index.html" })).ok).toBe(true);
    expect(parse(req(method, { projectId: "p1", path: "/tmp/a/b.html" })).ok).toBe(true);
    expect(parse(req(method, { cardId: "c1", path: "dist/index.html", tail: " ve sonrası" })).ok).toBe(true);
    // Shape only: traversal, dot folders and existence are the engine's job.
    expect(parse(req(method, { terminalId: "t1", path: "../../.ssh/id_rsa" })).ok).toBe(true);
  });

  it.each([
    ["no owner", { path: "a/b.html" }],
    ["two owners", { terminalId: "t1", projectId: "p1", path: "a/b.html" }],
    ["three owners", { terminalId: "t1", projectId: "p1", cardId: "c1", path: "a/b.html" }],
    ["no path", { terminalId: "t1" }],
    ["empty path", { terminalId: "t1", path: "" }],
    ["non-string path", { terminalId: "t1", path: 7 }],
    ["overlong path", { terminalId: "t1", path: "a".repeat(PATH_LIMITS.maxPathChars + 1) }],
    ["overlong tail", { terminalId: "t1", path: "/a/b", tail: "x".repeat(PATH_LIMITS.maxTailChars + 1) }],
    ["extra field", { terminalId: "t1", path: "/a/b", url: "http://x" }],
  ])("rejects %s", (_n, params) => {
    for (const method of METHODS) {
      const r = parse(req(method, params));
      expect(r.ok, method).toBe(false);
      // A bad request answers INVALID instead of closing the socket.
      if (!r.ok) expect(r.badRequest?.method).toBe(method);
    }
  });

  it("splits a preview address into its token and the path below it", () => {
    expect(parseFilesPreviewPath(`${FILES_PREVIEW_HTTP_PREFIX}${TOKEN}/index.html`)).toEqual({ token: TOKEN, rest: "/index.html" });
    expect(parseFilesPreviewPath(`${FILES_PREVIEW_HTTP_PREFIX}${TOKEN}/a/b%20c.css`)).toEqual({ token: TOKEN, rest: "/a/b%20c.css" });
    expect(parseFilesPreviewPath(`${FILES_PREVIEW_HTTP_PREFIX}${TOKEN}/`)).toEqual({ token: TOKEN, rest: "/" });
    expect(parseFilesPreviewPath(`${FILES_PREVIEW_HTTP_PREFIX}${TOKEN}`)).toEqual({ token: TOKEN, rest: "" });
    for (const bad of [
      FILES_PREVIEW_HTTP_PREFIX,
      `${FILES_PREVIEW_HTTP_PREFIX}kisa/index.html`,
      `${FILES_PREVIEW_HTTP_PREFIX}../${TOKEN}/index.html`,
      `${FILES_PREVIEW_HTTP_PREFIX}${TOKEN}x%2f/index.html`,
      `${FILES_PREVIEW_HTTP_PREFIX}${"A".repeat(201)}/a`,
      `${FILES_MEDIA_HTTP_PREFIX}${TOKEN}/index.html`,
      `/files/preview${TOKEN}/a`,
      `x${FILES_PREVIEW_HTTP_PREFIX}${TOKEN}/a`,
    ]) {
      expect(parseFilesPreviewPath(bad), bad).toBeNull();
    }
  });

  it("files.previewRevoke takes only a preview address", () => {
    expect(parse(req("files.previewRevoke", { path: `${FILES_PREVIEW_HTTP_PREFIX}${TOKEN}/index.html` })).ok).toBe(true);
    expect(parse(req("files.previewRevoke", { path: `${FILES_MEDIA_HTTP_PREFIX}${TOKEN}` })).ok).toBe(false);
    expect(parse(req("files.previewRevoke", { path: "/health" })).ok).toBe(false);
  });

  it("describes a location and a preview address", () => {
    expect(FileLocationSchema.safeParse({ path: "/Users/ada/rapor/index.html", kind: "page", browser: true }).success).toBe(true);
    expect(FileLocationSchema.safeParse({ path: "/p/klip.mp4", kind: "media", media: "video", rootPath: "klip.mp4", cardId: "c1", browser: true }).success).toBe(true);
    expect(FileLocationSchema.safeParse({ path: "/Users/ada/.ssh/a.html", kind: "page", browser: false, browserRefusal: "Gizli klasör" }).success).toBe(true);
    expect(FileLocationSchema.safeParse({ path: "/p", kind: "socket", browser: false }).success).toBe(false);
    expect(FilePreviewUrlSchema.safeParse({ path: `${FILES_PREVIEW_HTTP_PREFIX}${TOKEN}/index.html`, single: false, expiresAt: "2026-11-18T00:00:00.000Z" }).success).toBe(true);
    expect(FilePreviewUrlSchema.safeParse({ path: "/index.html", single: false, expiresAt: "x" }).success).toBe(false);
  });

  it("the engine can ask the app to show a project's browser", () => {
    expect(parseServerMessage(JSON.stringify({ type: "event", name: "browser.reveal", projectId: "p1" })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ type: "event", name: "browser.reveal" })).ok).toBe(false);
  });

  it("a project may opt out of `open` going to its browser", () => {
    const project = { id: "p1", name: "P", location: { kind: "local", path: "/p" } };
    expect(ProjectSchema.parse({ ...project, openInBrowser: false }).openInBrowser).toBe(false);
    expect(ProjectSchema.parse(project).openInBrowser).toBeUndefined();
    expect(parse(req("projects.update", { projectId: "p1", openInBrowser: false })).ok).toBe(true);
    expect(parse(req("projects.update", { projectId: "p1", openInBrowser: "no" })).ok).toBe(false);
  });
});
