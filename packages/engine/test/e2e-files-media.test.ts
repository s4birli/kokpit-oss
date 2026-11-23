// Dosyalar — medya end-to-end against the real engine: `files.mediaUrl` over the authenticated WebSocket, then the
// file over HTTP on the same listener with Range. The URL dies with its connection, on revoke and when idle.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const SECRET = "KOKPIT-MEDIA-E2E-SECRET-7d1f";
const TOKEN_TTL_MS = 1500;
const MAX_STREAMS = 2;
const SPARSE_BYTES = 50 * 1024 * 1024;
/** Far below what reading 50 MB would take to be meaningful as "did not read it all": bytes, not time, are asserted. */
const TAIL = "SON-BAYTLAR";
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
const VIDEO = Buffer.concat([MP4_HEAD, Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 253))]);
const PNG = Buffer.from("89504e470d0a1a0a0000000d", "hex");

let root: string;
let repo: string;
let engine: EngineProc | undefined;
let c: Client;
let projectId: string;
let cardId: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function request(method: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: engine!.host, port: engine!.port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
const get = (path: string, range?: string) => request("GET", path, range === undefined ? {} : { range });

function hang(path: string): Promise<{ status: number; close(): void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: engine!.host, port: engine!.port, method: "GET", path, agent: false }, (res) => {
      res.pause();
      resolve({ status: res.statusCode ?? 0, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

type MediaUrl = { path: string; kind: string; mime: string; size: number; expiresAt: string };
const mediaUrl = (params: Record<string, unknown>, client: Client = c) => client.req<MediaUrl>("files.mediaUrl", params);

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-files-media-")));
  repo = join(root, "depo");
  mkdirSync(join(repo, "cikti"), { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "gizli.mp4"), Buffer.concat([MP4_HEAD, Buffer.from(SECRET)]));
  writeFileSync(join(repo, "cikti", "video.mp4"), VIDEO);
  writeFileSync(join(repo, "logo.png"), PNG);
  writeFileSync(join(repo, "sayfa.html"), "<html><script>alert(1)</script></html>");
  writeFileSync(join(repo, "sahte.mp4"), "<html><script>alert(1)</script></html>");
  writeFileSync(join(repo, "README.md"), "# Depo\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=e2e@kokpit.test", "-c", "user.name=e2e", "add", ".");
  git(repo, "-c", "user.email=e2e@kokpit.test", "-c", "user.name=e2e", "commit", "-q", "-m", "ilk");
  // Untracked: a big sparse video and the escapes.
  const fd = openSync(join(repo, "seyrek.mp4"), "w");
  writeSync(fd, MP4_HEAD, 0, MP4_HEAD.length, 0);
  ftruncateSync(fd, SPARSE_BYTES);
  writeSync(fd, Buffer.from(TAIL), 0, TAIL.length, SPARSE_BYTES - TAIL.length);
  closeSync(fd);
  symlinkSync(join(root, "gizli.mp4"), join(repo, "kacis.mp4"));
  symlinkSync(root, join(repo, "ust"));

  const configPath = join(root, "engine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      flushIntervalMs: 100,
      killGraceMs: 200,
      files: { media: { tokenTtlMs: TOKEN_TTL_MS, maxStreams: MAX_STREAMS } },
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home") });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Depo", location: { kind: "local", path: repo } })).project.id;
  const { card } = await c.req<{ card: { id: string; worktreePath: string } }>("cards.create", { projectId, name: "Medya kartı" });
  cardId = card.id;
  writeFileSync(join(card.worktreePath, "kart.png"), PNG);
}, 60000);

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("Dosyalar — medya end-to-end", () => {
  it("files.read names the media kind; files.mediaUrl streams the file with Range", async () => {
    expect(await c.req("files.read", { projectId, path: "cikti/video.mp4" })).toMatchObject({ binary: true, media: "video", size: VIDEO.length });
    const url = await mediaUrl({ projectId, path: "cikti/video.mp4" });
    expect(url).toMatchObject({ kind: "video", mime: "video/mp4", size: VIDEO.length });
    expect(url.path).toMatch(/^\/files\/media\/[A-Za-z0-9_-]{43,}$/);

    const whole = await get(url.path);
    expect(whole.status).toBe(200);
    expect(whole.body.equals(VIDEO)).toBe(true);
    expect(whole.headers).toMatchObject({
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      "content-disposition": "inline; filename*=UTF-8''video.mp4",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    expect(whole.headers["access-control-allow-origin"]).toBeUndefined();

    const part = await get(url.path, "bytes=100-199");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 100-199/${VIDEO.length}`);
    expect(part.body.equals(VIDEO.subarray(100, 200))).toBe(true);
    expect((await get(url.path, "bytes=-10")).body.equals(VIDEO.subarray(VIDEO.length - 10))).toBe(true);
    expect((await get(url.path, `bytes=${VIDEO.length - 5}-`)).body.equals(VIDEO.subarray(VIDEO.length - 5))).toBe(true);

    const head = await request("HEAD", url.path);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(VIDEO.length));
    expect(head.body.length).toBe(0);
  });

  it("refuses unsatisfiable and multiple ranges with 416, other methods with 405", async () => {
    const { path } = await mediaUrl({ projectId, path: "cikti/video.mp4" });
    for (const range of ["bytes=0-1,4-5", `bytes=${VIDEO.length}-`, "bytes=7-2", "bytes=-0"]) {
      const r = await get(path, range);
      expect(r.status, range).toBe(416);
      expect(r.headers["content-range"], range).toBe(`bytes */${VIDEO.length}`);
    }
    for (const method of ["POST", "PUT", "DELETE"]) expect((await request(method, path)).status, method).toBe(405);
  });

  it("serves a card's file from its worktree", async () => {
    const url = await mediaUrl({ cardId, path: "kart.png" });
    expect(url).toMatchObject({ kind: "image", mime: "image/png" });
    expect((await get(url.path)).body.equals(PNG)).toBe(true);
    await expect(mediaUrl({ projectId, path: "kart.png" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each([
    ["../gizli.mp4", "INVALID"],
    ["cikti/../../gizli.mp4", "INVALID"],
    ["/etc/hosts", "INVALID"],
    ["kacis.mp4", "INVALID"],
    ["ust/gizli.mp4", "INVALID"],
    [".git/config", "NOT_FOUND"],
    ["%2e%2e%2fgizli.mp4", "NOT_FOUND"],
    ["sayfa.html", "INVALID"],
    ["README.md", "INVALID"],
    ["sahte.mp4", "INVALID"],
    ["cikti", "INVALID"],
  ])("gives no URL for %s (%s)", async (path, code) => {
    await expect(mediaUrl({ projectId, path })).rejects.toMatchObject({ code });
  });

  it("the HTTP route needs a live token and nothing else gets a file", async () => {
    const { path } = await mediaUrl({ projectId, path: "logo.png" });
    for (const bad of ["/files/media/", `/files/media/${"A".repeat(43)}`, `${path}x`, `${path}/..`, `${path}?a=1`, "/files/media/logo.png", "/files/media/..%2f..%2fgizli.mp4", "/files/"]) {
      const r = await get(bad);
      expect(r.status, bad).toBe(404);
      expect(r.body.toString(), bad).not.toContain(SECRET);
    }
    // The access key is not a token, and is not needed with one.
    expect((await get(`/files/media/${KEY}`)).status).toBe(404);
    expect((await get(path)).status).toBe(200);
  });

  it("refuses malformed requests without dropping the connection", async () => {
    await expect(c.req("files.mediaUrl", { path: "logo.png" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(c.req("files.mediaUrl", { projectId, cardId, path: "logo.png" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(c.req("files.mediaRevoke", { path: "/etc/passwd" })).rejects.toMatchObject({ code: "INVALID" });
    expect((await mediaUrl({ projectId, path: "logo.png" })).kind).toBe("image");
  });

  it("ssh projects get no media URL (Turkish note)", async () => {
    const { host } = await c.req<{ host: { id: string } }>("sshHosts.create", { name: "Uzak", hostname: "uzak.example" });
    const { project } = await c.req<{ project: { id: string } }>("projects.create", { name: "Uzak", location: { kind: "ssh", hostId: host.id, path: repo } });
    await expect(mediaUrl({ projectId: project.id, path: "logo.png" })).rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/SSH/) });
  });

  it("files.mediaRevoke ends the URL; another connection cannot end it", async () => {
    const other = await Client.connect(engine!.port, KEY);
    try {
      const { path } = await mediaUrl({ projectId, path: "logo.png" });
      await other.req("files.mediaRevoke", { path });
      expect((await get(path)).status).toBe(200);
      await c.req("files.mediaRevoke", { path });
      expect((await get(path)).status).toBe(404);
    } finally {
      await other.close();
    }
  });

  it("a URL dies with the connection that asked for it", async () => {
    const other = await Client.connect(engine!.port, KEY);
    const mine = await mediaUrl({ projectId, path: "logo.png" });
    const theirs = await mediaUrl({ projectId, path: "logo.png" }, other);
    expect((await get(theirs.path)).status).toBe(200);
    await other.close();
    await expect.poll(async () => (await get(theirs.path)).status).toBe(404);
    expect((await get(mine.path)).status).toBe(200);
  });

  it("a URL expires when it is not used, and each use keeps it alive", async () => {
    const { path } = await mediaUrl({ projectId, path: "logo.png" });
    const started = Date.now();
    while (Date.now() - started < TOKEN_TTL_MS * 2) {
      expect((await get(path, "bytes=0-3")).status).toBe(206);
      await new Promise((r) => setTimeout(r, TOKEN_TTL_MS / 3));
    }
    await new Promise((r) => setTimeout(r, TOKEN_TTL_MS + 200));
    expect((await get(path)).status).toBe(404);
  });

  it("seeks to the end of a 50 MB video at once", async () => {
    const url = await mediaUrl({ projectId, path: "seyrek.mp4" });
    expect(url.size).toBe(SPARSE_BYTES);
    const r = await get(url.path, `bytes=${SPARSE_BYTES - TAIL.length}-`);
    expect(r.status).toBe(206);
    expect(r.headers["content-length"]).toBe(String(TAIL.length));
    expect(r.headers["content-range"]).toBe(`bytes ${SPARSE_BYTES - TAIL.length}-${SPARSE_BYTES - 1}/${SPARSE_BYTES}`);
    expect(r.body.toString()).toBe(TAIL);
  });

  it(`sends at most ${MAX_STREAMS} bodies at once`, async () => {
    const { path } = await mediaUrl({ projectId, path: "seyrek.mp4" });
    const open = [await hang(path), await hang(path)];
    try {
      expect(open.map((o) => o.status)).toEqual([200, 200]);
      const third = await get(path, "bytes=0-9");
      expect(third.status).toBe(503);
      expect(third.headers["retry-after"]).toBeDefined();
    } finally {
      for (const o of open) o.close();
    }
    await expect.poll(async () => (await get(path, "bytes=0-9")).status).toBe(206);
  });

  it("never writes a token to the engine log", async () => {
    const { path } = await mediaUrl({ projectId, path: "logo.png" });
    const token = path.slice("/files/media/".length);
    await get(path);
    await get(`${path}x`);
    await c.req("files.mediaRevoke", { path });
    await get(path);
    await expect.poll(() => engine!.logs()).toContain("media url rejected");
    expect(engine!.logs()).not.toContain(token);
    expect(engine!.logs()).not.toContain(token.slice(0, 16));
  });
});
