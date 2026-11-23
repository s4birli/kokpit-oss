// Dosyalar — medya, monkey: random Range headers and random request paths. Whatever comes in, the service answers
// one of a few statuses, never more or other bytes than the file's, and never a file outside the project.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FILES_MEDIA_HTTP_PREFIX } from "@kokpit/shared";
import { EngineError } from "./contracts.ts";
import { createFileService, loadFilesConfig } from "./files.ts";
import { createMediaService, parseRange, type MediaService } from "./files-media.ts";
import { FakeLogger } from "../test/fakes/server-fakes.ts";

const SEED = 0x6b6f6b70;
const RANGE_ROUNDS = 400;
const PATH_ROUNDS = 600;
const URL_ROUNDS = 300;
const SECRET = "KOKPIT-MONKEY-SECRET";
const HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
const BODY = Buffer.concat([HEAD, Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256))]);

/** Small seeded generator (mulberry32): a failing round can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let base: string;
let root: string;
let media: MediaService;
let server: http.Server;
let port: number;
const owner = {};

function get(path: string, range?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, agent: false, ...(range === undefined ? {} : { headers: { range } }) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-media-monkey-")));
  root = join(base, "proje");
  mkdirSync(join(root, "a", "b"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(base, "gizli.mp4"), Buffer.concat([HEAD, Buffer.from(SECRET)]));
  writeFileSync(join(root, ".git", "gizli.mp4"), Buffer.concat([HEAD, Buffer.from(SECRET)]));
  writeFileSync(join(root, "v.mp4"), BODY);
  writeFileSync(join(root, "a", "b", "v.mp4"), BODY);
  symlinkSync(base, join(root, "ust"));
  symlinkSync(join(base, "gizli.mp4"), join(root, "kacis.mp4"));
  const cfg = loadFilesConfig({});
  media = createMediaService({ config: cfg.media, resolve: createFileService({ config: cfg }).resolve, logger: new FakeLogger() });
  server = http.createServer((req, res) => {
    if (!media.handleHttp(req, res)) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  media.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(base, { recursive: true, force: true });
});

describe("monkey: Range headers", () => {
  it(`${RANGE_ROUNDS} random Range headers: 200 / 206 / 416 with exactly the bytes the header names`, async () => {
    const rand = rng(SEED);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const num = (): string => pick(["", "0", "1", "23", String(BODY.length - 1), String(BODY.length), String(BODY.length + 1), "99999999999999999999", "-1", "1e3", "0x10", " 5", "+5", String(Math.floor(rand() * BODY.length * 1.2))]);
    const unit = (): string => pick(["bytes", "bytes", "bytes", "bytes", "Bytes", "BYTES", "bits", "", "bytes ", " bytes"]);
    const { path } = media.issue(owner, root, "v.mp4");
    for (let i = 0; i < RANGE_ROUNDS; i++) {
      const parts = Array.from({ length: pick([1, 1, 1, 1, 2, 3]) }, () => `${num()}${pick(["-", "-", "-", "", "--", ":"])}${num()}`);
      const header = `${unit()}${pick(["=", "=", "=", " = ", "", ":"])}${parts.join(pick([",", ", ", ";"]))}`;
      const expected = parseRange(header, BODY.length);
      const r = await get(path, header);
      const label = `round ${i}: ${JSON.stringify(header)}`;
      expect(r.headers["x-content-type-options"], label).toBe("nosniff");
      if (expected === "full") {
        expect(r.status, label).toBe(200);
        expect(r.body.equals(BODY), label).toBe(true);
      } else if (expected === "unsatisfiable") {
        expect(r.status, label).toBe(416);
        expect(r.body.length, label).toBe(0);
        expect(r.headers["content-range"], label).toBe(`bytes */${BODY.length}`);
      } else {
        expect(expected.start, label).toBeGreaterThanOrEqual(0);
        expect(expected.end, label).toBeLessThan(BODY.length);
        expect(expected.start, label).toBeLessThanOrEqual(expected.end);
        expect(r.status, label).toBe(206);
        expect(r.headers["content-range"], label).toBe(`bytes ${expected.start}-${expected.end}/${BODY.length}`);
        expect(r.body.equals(BODY.subarray(expected.start, expected.end + 1)), label).toBe(true);
      }
      expect(r.headers["content-length"], label).toBe(String(r.body.length));
    }
    expect(media.stats().activeStreams).toBe(0);
  });
});

describe("monkey: paths", () => {
  it(`${PATH_ROUNDS} random request paths never get a URL for a file outside the project`, async () => {
    const rand = rng(SEED + 1);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const segment = (): string =>
      pick(["..", ".", "", "a", "b", "v.mp4", "ust", "kacis.mp4", ".git", ".GIT", "gizli.mp4", "%2e%2e", "..%2f", "\\", "\0", "/", "a/b", "~", "C:", " ", "proje", "..\\..", "v.mp4/", "v.MP4", "‮", "é"]);
    let issued = 0;
    for (let i = 0; i < PATH_ROUNDS; i++) {
      const path = `${pick(["", "", "/", "./", "../", "//"])}${Array.from({ length: 1 + Math.floor(rand() * 5) }, segment).join(pick(["/", "/", "/", "//", "\\"]))}`;
      const label = `round ${i}: ${JSON.stringify(path)}`;
      let url: string;
      try {
        url = media.issue(owner, root, path).path;
      } catch (err) {
        expect(err, label).toBeInstanceOf(EngineError);
        expect(["INVALID", "NOT_FOUND"], label).toContain((err as EngineError).code);
        continue;
      }
      issued++;
      const r = await get(url);
      expect(r.status, label).toBe(200);
      // Only the project's own video can come back.
      expect(r.body.equals(BODY), label).toBe(true);
      expect(r.body.toString("latin1"), label).not.toContain(SECRET);
    }
    // The generator does reach real files, so the loop above is not vacuous.
    expect(issued).toBeGreaterThan(0);
  });

  it(`${URL_ROUNDS} random URLs under the prefix answer 404 (or 405) and never a body`, async () => {
    const rand = rng(SEED + 2);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const { path } = media.issue(owner, root, "v.mp4");
    const token = path.slice(FILES_MEDIA_HTTP_PREFIX.length);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    for (let i = 0; i < URL_ROUNDS; i++) {
      const length = pick([0, 1, 31, 32, 43, 44, 200, 201]);
      const random = Array.from({ length }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
      const tail = pick([random, random, `${token}/`, `${token}?x`, `${token}%00`, `../${token}`, `${token.slice(1)}`, `${token}${token}`, "v.mp4", "..%2f..%2fgizli.mp4", `${token};a`, `%2e%2e/${token}`]);
      const r = await get(`${FILES_MEDIA_HTTP_PREFIX}${tail}`);
      const label = `round ${i}: ${JSON.stringify(tail)}`;
      expect(r.status, label).toBe(404);
      expect(r.body.length, label).toBe(0);
    }
    expect((await get(path)).status).toBe(200);
  });
});
