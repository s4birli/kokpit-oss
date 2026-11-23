// Dosyalar — medya: the token URL that streams one file. Real files in a temp folder, a real HTTP server on
// loopback in front of `handleHttp`, a fake clock for expiry.
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FILES_MEDIA_HTTP_PREFIX, isFilesMediaTokenPath } from "@kokpit/shared";
import { EngineError } from "./contracts.ts";
import { createFileService, loadFilesConfig, type FilesConfig } from "./files.ts";
import { createMediaService, inlineDisposition, matchesSignature, mediaTypeOf, parseRange, type MediaService } from "./files-media.ts";
import { FakeLogger } from "../test/fakes/server-fakes.ts";

const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
const PNG_HEAD = Buffer.from("89504e470d0a1a0a0000000d", "hex");
const BODY = Buffer.concat([MP4_HEAD, Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251))]);
const SVG = `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>\n`;
const SPARSE_BYTES = 50 * 1024 * 1024;
const SECRET = "KOKPIT-MEDIA-SECRET";

let base: string;
let root: string;
let cfg: FilesConfig;
let clock = 1_000_000;
let logger: FakeLogger;
let media: MediaService;
let server: http.Server;
let port: number;
const owner = { name: "conn-1" };
const other = { name: "conn-2" };

function build(overrides: Partial<FilesConfig["media"]> = {}): void {
  media?.stop();
  cfg = loadFilesConfig({ media: overrides });
  const files = createFileService({ config: cfg });
  logger = new FakeLogger();
  media = createMediaService({ config: cfg.media, resolve: files.resolve, logger, now: () => clock });
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function request(method: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
const get = (path: string, range?: string) => request("GET", path, range === undefined ? {} : { range });

/** Opens a GET and leaves the body unread (the engine's stream stays open). Returns the status and a closer. */
function hang(path: string): Promise<{ status: number; close(): void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, agent: false }, (res) => {
      res.pause();
      resolve({ status: res.statusCode ?? 0, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
  return "ok";
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-media-")));
  root = join(base, "proje");
  mkdirSync(join(root, "cikti"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(base, "gizli.mp4"), Buffer.concat([MP4_HEAD, Buffer.from(SECRET)]));
  writeFileSync(join(root, ".git", "x.mp4"), MP4_HEAD);
  writeFileSync(join(root, "cikti", "video.mp4"), BODY);
  writeFileSync(join(root, "BUYUK.MP4"), BODY);
  writeFileSync(join(root, "bos.mp4"), "");
  writeFileSync(join(root, "sahte.mp4"), "<html><script>alert(1)</script></html>");
  writeFileSync(join(root, "sayfa.html"), "<html></html>");
  writeFileSync(join(root, "betik.js"), "alert(1)");
  writeFileSync(join(root, "resim.png"), PNG_HEAD);
  writeFileSync(join(root, "cizim.svg"), SVG);
  writeFileSync(join(root, "sahte.svg"), "<html><body>svg değil</body></html>");
  writeFileSync(join(root, "belge.pdf"), "%PDF-1.4\n%%EOF\n");
  writeFileSync(join(root, "ses.wav"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]));
  symlinkSync(join(base, "gizli.mp4"), join(root, "kacis.mp4"));
  symlinkSync(base, join(root, "ust"));
  symlinkSync(join(root, "sayfa.html"), join(root, "maske.mp4"));
  symlinkSync(join(root, "cikti", "video.mp4"), join(root, "kisayol.mp4"));
  const fd = openSync(join(root, "seyrek.mp4"), "w");
  writeSync(fd, MP4_HEAD, 0, MP4_HEAD.length, 0);
  ftruncateSync(fd, SPARSE_BYTES);
  writeSync(fd, Buffer.from("SON-BAYTLAR"), 0, 11, SPARSE_BYTES - 11);
  closeSync(fd);

  build();
  server = http.createServer((req, res) => {
    if (!media.handleHttp(req, res)) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  clock = 1_000_000;
  build();
});

afterAll(async () => {
  media.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(base, { recursive: true, force: true });
});

describe("media config", () => {
  it("knows the shipped types by extension, case-insensitively, and nothing active", () => {
    const kinds = Object.fromEntries(
      ["a.mp4", "a.M4V", "a.mov", "a.webm", "a.mp3", "a.m4a", "a.wav", "a.ogg", "a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.pdf"].map((n) => [n, media.kindOf(n)]),
    );
    expect(kinds).toEqual({
      "a.mp4": "video", "a.M4V": "video", "a.mov": "video", "a.webm": "video",
      "a.mp3": "audio", "a.m4a": "audio", "a.wav": "audio", "a.ogg": "audio",
      "a.png": "image", "a.JPG": "image", "a.jpeg": "image", "a.gif": "image", "a.webp": "image", "a.svg": "image",
      "a.pdf": "pdf",
    });
    for (const n of ["a.html", "a.htm", "a.js", "a.mjs", "a.xhtml", "a.xml", "a.txt", "mp4", "a", "a.mp4.html", "constructor", "a.constructor", "a.__proto__"]) {
      expect(media.kindOf(n), n).toBeUndefined();
    }
  });

  it.each([
    ["text/html", { kind: "image", mime: "text/html" }],
    ["javascript", { kind: "image", mime: "application/javascript" }],
    ["xhtml", { kind: "image", mime: "application/xhtml+xml" }],
    ["a parameter smuggling a type", { kind: "image", mime: "image/png, text/html" }],
    ["an unknown kind", { kind: "page", mime: "image/png" }],
  ])("refuses a type served as %s", (_n, type) => {
    const types = { x: { ...type, signatures: [[{ at: 0, text: "x" }]] } } as never;
    expect(() => loadFilesConfig({ media: { types } })).toThrow(/invalid files config: media\.types/);
  });

  it("refuses a policy without sandbox, and unknown keys", () => {
    expect(() => loadFilesConfig({ media: { contentSecurityPolicy: "default-src 'none'" } })).toThrow(/sandbox/);
    expect(() => loadFilesConfig({ media: { nope: 1 } as never })).toThrow(/invalid files config/);
  });

  it("keeps the other media defaults when one is overridden", () => {
    const c = loadFilesConfig({ media: { maxStreams: 1 } });
    expect(c.media.maxStreams).toBe(1);
    expect(c.media.types.mp4?.mime).toBe("video/mp4");
    expect(c.maxEntries).toBe(loadFilesConfig({}).maxEntries);
  });

  it("matches signatures at an offset, as a set, and anywhere", () => {
    const t = (n: string) => mediaTypeOf(cfg.media, n)!;
    expect(matchesSignature(t("a.mp4"), MP4_HEAD)).toBe(true);
    expect(matchesSignature(t("a.mp4"), Buffer.from("ftypisom"))).toBe(false);
    expect(matchesSignature(t("a.wav"), Buffer.from("RIFF0000WAVE"))).toBe(true);
    expect(matchesSignature(t("a.wav"), Buffer.from("RIFF0000WEBP"))).toBe(false);
    expect(matchesSignature(t("a.webp"), Buffer.from("RIFF0000WEBP"))).toBe(true);
    expect(matchesSignature(t("a.svg"), Buffer.from(SVG))).toBe(true);
    expect(matchesSignature(t("a.svg"), Buffer.from("<html>"))).toBe(false);
    expect(matchesSignature(t("a.png"), Buffer.alloc(0))).toBe(false);
  });
});

describe("inlineDisposition", () => {
  it("is always inline and names the file without letting the name break the header", () => {
    expect(inlineDisposition("/a/b/klip.mp4")).toBe("inline; filename*=UTF-8''klip.mp4");
    expect(inlineDisposition("/a/çıktı son.mp4")).toBe("inline; filename*=UTF-8''%C3%A7%C4%B1kt%C4%B1%20son.mp4");
    const nasty = inlineDisposition(`/a/x"; attachment; filename='y(1)*!\r\nSet-Cookie: a=b.mp4`);
    expect(nasty.startsWith("inline; filename*=UTF-8''")).toBe(true);
    expect(nasty.slice("inline; filename*=UTF-8''".length)).toMatch(/^[A-Za-z0-9%._~-]+$/);
  });
});

describe("parseRange", () => {
  it.each([
    [undefined, "full"],
    ["items=0-5", "full"],
    ["", "full"],
    ["bytes=0-0", { start: 0, end: 0 }],
    ["bytes=0-99", { start: 0, end: 99 }],
    ["bytes=10-", { start: 10, end: 99 }],
    ["bytes=90-500", { start: 90, end: 99 }],
    ["bytes=-10", { start: 90, end: 99 }],
    ["bytes=-500", { start: 0, end: 99 }],
    ["Bytes = 5-6", { start: 5, end: 6 }],
    ["bytes=100-", "unsatisfiable"],
    ["bytes=100-200", "unsatisfiable"],
    ["bytes=50-40", "unsatisfiable"],
    ["bytes=-0", "unsatisfiable"],
    ["bytes=-", "unsatisfiable"],
    ["bytes=", "unsatisfiable"],
    ["bytes=0-1,5-6", "unsatisfiable"],
    ["bytes=a-b", "unsatisfiable"],
    ["bytes=1.5-3", "unsatisfiable"],
    ["bytes=-1-3", "unsatisfiable"],
    ["bytes=0x10-0x20", "unsatisfiable"],
    ["bytes=99999999999999999999-", "unsatisfiable"],
    ["bytes=0-99999999999999999999999", "unsatisfiable"],
  ] as const)("%s of 100 bytes → %j", (header, expected) => {
    expect(parseRange(header, 100)).toEqual(expected);
  });

  it("has nothing to give from an empty file", () => {
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-5", 0)).toBe("unsatisfiable");
    expect(parseRange(undefined, 0)).toBe("full");
  });
});

describe("issuing a media URL", () => {
  it("answers a token path, the kind, the allowlisted type and the size", () => {
    const r = media.issue(owner, root, "cikti/video.mp4");
    expect(isFilesMediaTokenPath(r.path)).toBe(true);
    expect(r).toMatchObject({ kind: "video", mime: "video/mp4", size: BODY.length });
    expect(new Date(r.expiresAt).getTime()).toBe(clock + cfg.media.tokenTtlMs);
    // Unguessable: enough random bytes, never the same twice.
    expect(r.path.length - FILES_MEDIA_HTTP_PREFIX.length).toBeGreaterThanOrEqual(43);
    expect(media.issue(owner, root, "cikti/video.mp4").path).not.toBe(r.path);
  });

  it.each([
    ["..", "../gizli.mp4", "INVALID"],
    ["absolute", join("/", "etc", "hosts"), "INVALID"],
    ["a link out of the project", "kacis.mp4", "INVALID"],
    ["a folder link out of the project", "ust/gizli.mp4", "INVALID"],
    ["a hidden folder", ".git/x.mp4", "NOT_FOUND"],
    ["a missing file", "yok.mp4", "NOT_FOUND"],
    ["a backslash", "cikti\\video.mp4", "INVALID"],
    ["a NUL", "cikti/video.mp4\0.png", "INVALID"],
    ["a folder", "cikti", "INVALID"],
    ["html", "sayfa.html", "INVALID"],
    ["a script", "betik.js", "INVALID"],
    ["html named .mp4", "sahte.mp4", "INVALID"],
    ["html named .svg", "sahte.svg", "INVALID"],
    ["a media name linked to html", "maske.mp4", "INVALID"],
    ["an empty file", "bos.mp4", "INVALID"],
  ])("refuses %s", (_n, path, expected) => {
    expect(code(() => media.issue(owner, root, path))).toBe(expected);
    expect(media.stats().tokens).toBe(0);
  });

  it("follows a link that stays inside the project", () => {
    expect(media.issue(owner, root, "kisayol.mp4").size).toBe(BODY.length);
  });

  it("refuses a file over the size cap", () => {
    build({ maxBytes: BODY.length - 1 });
    expect(code(() => media.issue(owner, root, "cikti/video.mp4"))).toBe("INVALID");
  });

  it("keeps at most maxTokensPerConnection per connection and maxTokens in all, dropping the oldest", async () => {
    build({ maxTokensPerConnection: 2, maxTokens: 3 });
    const a = media.issue(owner, root, "cikti/video.mp4").path;
    const b = media.issue(owner, root, "resim.png").path;
    const c = media.issue(owner, root, "belge.pdf").path;
    expect((await get(a)).status).toBe(404);
    expect((await get(b)).status).toBe(200);
    expect((await get(c)).status).toBe(200);
    const d = media.issue(other, root, "resim.png").path;
    const e = media.issue({}, root, "resim.png").path;
    expect(media.stats().tokens).toBe(3);
    expect((await get(b)).status).toBe(404);
    expect((await get(d)).status).toBe(200);
    expect((await get(e)).status).toBe(200);
  });
});

describe("serving", () => {
  it("GET answers the whole file with a closed set of headers", async () => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    const r = await get(path);
    expect(r.status).toBe(200);
    expect(r.body.equals(BODY)).toBe(true);
    expect(r.headers).toMatchObject({
      "content-type": "video/mp4",
      "content-length": String(BODY.length),
      "accept-ranges": "bytes",
      "content-disposition": "inline; filename*=UTF-8''video.mp4",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": cfg.media.contentSecurityPolicy,
    });
    expect(r.headers["content-range"]).toBeUndefined();
    // CORS stays closed: no page may read the bytes with fetch().
    expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it.each([
    ["bytes=0-0", 0, 0],
    ["bytes=0-99", 0, 99],
    ["bytes=100-", 100, BODY.length - 1],
    ["bytes=-100", BODY.length - 100, BODY.length - 1],
    [`bytes=${BODY.length - 1}-`, BODY.length - 1, BODY.length - 1],
    ["bytes=4000-999999", 4000, BODY.length - 1],
    [`bytes=-${BODY.length * 2}`, 0, BODY.length - 1],
  ])("Range %s answers 206 with exactly those bytes", async (range, start, end) => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    const r = await get(path, range);
    expect(r.status).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes ${start}-${end}/${BODY.length}`);
    expect(r.headers["content-length"]).toBe(String(end - start + 1));
    expect(r.body.equals(BODY.subarray(start, end + 1))).toBe(true);
    expect(r.headers["content-type"]).toBe("video/mp4");
  });

  it.each(["bytes=0-1,10-11", `bytes=${BODY.length}-`, "bytes=9-3", "bytes=-0", "bytes=x-y", "bytes=-"])("Range %s answers 416 and no bytes", async (range) => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    const r = await get(path, range);
    expect(r.status).toBe(416);
    expect(r.headers["content-range"]).toBe(`bytes */${BODY.length}`);
    expect(r.body.length).toBe(0);
    // A refused range does not end the URL.
    expect((await get(path, "bytes=0-0")).status).toBe(206);
  });

  it("ignores a range in another unit", async () => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    const r = await get(path, "pages=1-2");
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(BODY.length);
  });

  it("HEAD answers the headers without a body, with and without a range", async () => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    const whole = await request("HEAD", path);
    expect(whole.status).toBe(200);
    expect(whole.headers["content-length"]).toBe(String(BODY.length));
    expect(whole.headers["content-type"]).toBe("video/mp4");
    expect(whole.body.length).toBe(0);
    const part = await request("HEAD", path, { range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 10-19/${BODY.length}`);
    expect(part.body.length).toBe(0);
    expect(media.stats().activeStreams).toBe(0);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("%s is not allowed", async (method) => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    const r = await request(method, path, method === "OPTIONS" ? { origin: "http://evil.example", "access-control-request-method": "GET" } : {});
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("GET, HEAD");
    expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    expect(r.body.length).toBe(0);
  });

  it("serves each type as its allowlisted content type, SVG sandboxed", async () => {
    for (const [file, mime] of [
      ["resim.png", "image/png"],
      ["cizim.svg", "image/svg+xml"],
      ["belge.pdf", "application/pdf"],
      ["ses.wav", "audio/wav"],
      ["BUYUK.MP4", "video/mp4"],
    ] as const) {
      const r = await get(media.issue(owner, root, file).path);
      expect(r.status, file).toBe(200);
      expect(r.headers["content-type"], file).toBe(mime);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toMatch(/(^|;)\s*sandbox(;|$)/);
      expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    }
  });

  it("answers 404 without a body for anything that is not a live token", async () => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    const token = path.slice(FILES_MEDIA_HTTP_PREFIX.length);
    for (const bad of [
      FILES_MEDIA_HTTP_PREFIX,
      `${FILES_MEDIA_HTTP_PREFIX}${"A".repeat(43)}`,
      `${FILES_MEDIA_HTTP_PREFIX}${token.slice(0, -1)}`,
      `${FILES_MEDIA_HTTP_PREFIX}${token}x`,
      `${path}/`,
      `${path}/../x`,
      `${path}?download=1`,
      `${path}#x`.replace("#", "%23"),
      `${FILES_MEDIA_HTTP_PREFIX}cikti/video.mp4`,
      `${FILES_MEDIA_HTTP_PREFIX}..%2f..%2fetc%2fhosts`,
      `${FILES_MEDIA_HTTP_PREFIX}${token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase()}`,
    ]) {
      const r = await get(bad);
      expect(r.status, bad).toBe(404);
      expect(r.body.length, bad).toBe(0);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
    }
    // None of that used the real URL up.
    expect((await get(path)).status).toBe(200);
  });

  it("leaves other paths to the caller", async () => {
    expect((await get("/health")).status).toBe(418);
    expect((await get("/files/medya")).status).toBe(418);
    expect((await get("/map/abc")).status).toBe(418);
  });

  it("never logs a token", async () => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    const token = path.slice(FILES_MEDIA_HTTP_PREFIX.length);
    await get(path);
    await get(`${path}x`);
    await get(path, "bytes=9-1");
    media.revoke(owner, path);
    await get(path);
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("media url rejected");
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(token.slice(0, 12));
  });
});

describe("expiry and revocation", () => {
  it("expires tokenTtlMs after issue when unused", async () => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    clock += cfg.media.tokenTtlMs - 1;
    expect((await request("HEAD", path)).status).toBe(200);
    clock += cfg.media.tokenTtlMs;
    expect((await get(path)).status).toBe(404);
    // …and stays dead.
    clock -= cfg.media.tokenTtlMs;
    expect((await get(path)).status).toBe(404);
    expect(media.stats().tokens).toBe(0);
  });

  it("each use moves the deadline", async () => {
    const { path } = media.issue(owner, root, "cikti/video.mp4");
    for (let i = 0; i < 4; i++) {
      clock += cfg.media.tokenTtlMs - 1;
      expect((await get(path, "bytes=0-9")).status).toBe(206);
    }
  });

  it("revoke ends one URL of its owner only", async () => {
    const mine = media.issue(owner, root, "cikti/video.mp4").path;
    const also = media.issue(owner, root, "resim.png").path;
    media.revoke(other, mine);
    expect((await get(mine)).status).toBe(200);
    media.revoke(owner, mine);
    expect((await get(mine)).status).toBe(404);
    expect((await get(also)).status).toBe(200);
    media.revoke(owner, "/files/media/../x");
    media.revoke(owner, `${FILES_MEDIA_HTTP_PREFIX}${"B".repeat(43)}`);
  });

  it("revokeOwner ends every URL of a dropped connection, and nobody else's", async () => {
    const a = media.issue(owner, root, "cikti/video.mp4").path;
    const b = media.issue(owner, root, "resim.png").path;
    const c = media.issue(other, root, "resim.png").path;
    media.revokeOwner(owner);
    expect((await get(a)).status).toBe(404);
    expect((await get(b)).status).toBe(404);
    expect((await get(c)).status).toBe(200);
  });

  it("stop ends everything, running streams included", async () => {
    const { path } = media.issue(owner, root, "seyrek.mp4");
    const open = await hang(path);
    expect(open.status).toBe(200);
    expect(media.stats().activeStreams).toBe(1);
    media.stop();
    expect(media.stats()).toMatchObject({ tokens: 0, activeStreams: 0 });
    open.close();
    expect((await get(path)).status).toBe(404);
  });
});

describe("the URL is bound to one file", () => {
  let scratch: string;
  const put = (name: string, body: Buffer | string = BODY): string => {
    writeFileSync(join(scratch, name), body);
    return `gecici/${name}`;
  };
  beforeAll(() => {
    scratch = join(root, "gecici");
    mkdirSync(scratch);
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch);
  });

  it("a deleted file answers 404", async () => {
    const { path } = media.issue(owner, root, put("a.mp4"));
    unlinkSync(join(scratch, "a.mp4"));
    expect((await get(path)).status).toBe(404);
  });

  it("a file swapped for a link out of the project is not followed", async () => {
    const { path } = media.issue(owner, root, put("a.mp4"));
    unlinkSync(join(scratch, "a.mp4"));
    symlinkSync(join(base, "gizli.mp4"), join(scratch, "a.mp4"));
    const r = await get(path);
    expect(r.status).toBe(404);
    expect(r.body.toString()).not.toContain(SECRET);
  });

  it("a folder swapped for a link out of the project is not followed", async () => {
    mkdirSync(join(scratch, "alt"));
    writeFileSync(join(scratch, "alt", "gizli.mp4"), BODY);
    const { path } = media.issue(owner, root, "gecici/alt/gizli.mp4");
    renameSync(join(scratch, "alt"), join(scratch, "eski"));
    symlinkSync(base, join(scratch, "alt"));
    const r = await get(path);
    expect(r.status).toBe(404);
    expect(r.body.toString()).not.toContain(SECRET);
  });

  it("content that stops matching its type is not served, and the URL is done", async () => {
    const { path } = media.issue(owner, root, put("a.mp4"));
    writeFileSync(join(scratch, "a.mp4"), "<html><script>alert(1)</script></html>");
    expect((await get(path)).status).toBe(404);
    writeFileSync(join(scratch, "a.mp4"), BODY);
    expect((await get(path)).status).toBe(404);
  });

  it("a file rewritten in place is served at its new size", async () => {
    const { path } = media.issue(owner, root, put("a.mp4"));
    const longer = Buffer.concat([BODY, Buffer.from("devam")]);
    writeFileSync(join(scratch, "a.mp4"), longer);
    const r = await get(path);
    expect(r.status).toBe(200);
    expect(r.body.equals(longer)).toBe(true);
  });

  it("a file grown past the size cap is refused", async () => {
    build({ maxBytes: BODY.length + 2 });
    const { path } = media.issue(owner, root, put("a.mp4"));
    writeFileSync(join(scratch, "a.mp4"), Buffer.concat([BODY, Buffer.from("fazla")]));
    expect((await get(path)).status).toBe(404);
  });
});

describe("streaming", () => {
  it("seeks to the end of a 50 MB file without reading the rest", async () => {
    const { path, size } = media.issue(owner, root, "seyrek.mp4");
    expect(size).toBe(SPARSE_BYTES);
    const before = media.stats().bytesRead;
    const r = await get(path, "bytes=-11");
    expect(r.status).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes ${SPARSE_BYTES - 11}-${SPARSE_BYTES - 1}/${SPARSE_BYTES}`);
    expect(r.body.toString()).toBe("SON-BAYTLAR");
    // The signature check plus the 11 bytes asked for — not 50 MB.
    expect(media.stats().bytesRead - before).toBe(cfg.media.sniffBytes + 11);

    const mid = media.stats().bytesRead;
    const m = await get(path, `bytes=${SPARSE_BYTES / 2}-${SPARSE_BYTES / 2 + 99_999}`);
    expect(m.body.length).toBe(100_000);
    expect(media.stats().bytesRead - mid).toBe(cfg.media.sniffBytes + 100_000);
    expect(media.stats().activeStreams).toBe(0);
  });

  it("stops reading when the client goes away", async () => {
    const { path } = media.issue(owner, root, "seyrek.mp4");
    const before = media.stats().bytesRead;
    const open = await hang(path);
    expect(media.stats().activeStreams).toBe(1);
    open.close();
    await expect.poll(() => media.stats().activeStreams).toBe(0);
    // Backpressure: only what the socket buffers took was read.
    expect(media.stats().bytesRead - before).toBeLessThan(SPARSE_BYTES / 2);
  });

  it("sends at most maxStreams bodies at once; HEAD and finished streams do not count", async () => {
    build({ maxStreams: 2 });
    const { path } = media.issue(owner, root, "seyrek.mp4");
    const a = await hang(path);
    const b = await hang(path);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(media.stats().activeStreams).toBe(2);
    const third = await get(path, "bytes=0-9");
    expect(third.status).toBe(503);
    expect(third.headers["retry-after"]).toBe(String(cfg.media.retryAfterS));
    expect(third.body.length).toBe(0);
    expect((await request("HEAD", path)).status).toBe(200);
    a.close();
    await expect.poll(() => media.stats().activeStreams).toBe(1);
    expect((await get(path, "bytes=0-9")).status).toBe(206);
    b.close();
    await expect.poll(() => media.stats().activeStreams).toBe(0);
  });
});
