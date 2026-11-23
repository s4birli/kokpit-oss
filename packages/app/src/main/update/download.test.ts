// @vitest-environment node
// Kendini güncelleme — the download against a real local HTTP server: whole, cut off and resumed with Range.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { downloadArchive, DownloadError } from "./download.ts";

const BODY = randomBytes(200_000);
const dir = mkdtempSync(join(tmpdir(), "kokpit-update-download-"));
let server: http.Server;
let origin: string;
/** What the server does with the next requests. */
let behaviour: { cutAfter?: number; status?: number; ignoreRange?: boolean; extra?: number; stall?: boolean } = {};
let requests: { range: string | undefined }[] = [];
let n = 0;
const part = (): string => join(dir, `a-${n++}.zip.part`);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range });
    if (behaviour.status !== undefined) {
      res.writeHead(behaviour.status).end();
      return;
    }
    if (behaviour.stall) return; // never answers
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = m && !behaviour.ignoreRange ? Number(m[1]) : 0;
    if (start >= BODY.length) {
      res.writeHead(416, { "content-range": `bytes */${BODY.length}` }).end();
      return;
    }
    const body = Buffer.concat([BODY.subarray(start), Buffer.alloc(behaviour.extra ?? 0, 1)]);
    res.writeHead(start > 0 ? 206 : 200, { "content-length": body.length, ...(start > 0 ? { "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` } : {}) });
    if (behaviour.cutAfter !== undefined) {
      const cut = behaviour.cutAfter;
      behaviour = {};
      res.write(body.subarray(0, cut), () => res.destroy());
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  behaviour = {};
  requests = [];
});

const input = (partPath: string, over: Partial<Parameters<typeof downloadArchive>[0]> = {}) => ({
  url: async () => `${origin}/app-updates/token`,
  partPath,
  size: BODY.length,
  attempts: 3,
  idleTimeoutMs: 2000,
  ...over,
});

describe("downloadArchive", () => {
  it("fetches the whole archive and reports progress", async () => {
    const p = part();
    const seen: number[] = [];
    await downloadArchive(input(p, { onProgress: (r) => seen.push(r) }));
    expect(readFileSync(p).equals(BODY)).toBe(true);
    expect(seen.at(-1)).toBe(BODY.length);
    expect(requests).toEqual([{ range: undefined }]);
  });

  it("a connection cut in the middle is resumed with Range from what is on disk, with a fresh URL", async () => {
    const p = part();
    behaviour = { cutAfter: 70_000 };
    let urls = 0;
    await downloadArchive(input(p, { url: async () => `${origin}/app-updates/token-${urls++}` }));
    expect(readFileSync(p).equals(BODY)).toBe(true);
    expect(urls).toBe(2);
    expect(requests[1]?.range).toMatch(/^bytes=\d+-$/);
    expect(Number(/(\d+)/.exec(requests[1]!.range!)![1])).toBeGreaterThan(0);
  });

  it("a part file left by an earlier run is continued, not fetched again", async () => {
    const p = part();
    writeFileSync(p, BODY.subarray(0, 150_000));
    await downloadArchive(input(p));
    expect(requests).toEqual([{ range: "bytes=150000-" }]);
    expect(readFileSync(p).equals(BODY)).toBe(true);
  });

  it("a complete part file needs no request", async () => {
    const p = part();
    writeFileSync(p, BODY);
    await downloadArchive(input(p));
    expect(requests).toEqual([]);
  });

  it("a server that ignores Range and sends everything restarts the file instead of appending", async () => {
    const p = part();
    writeFileSync(p, BODY.subarray(0, 1000));
    behaviour = { ignoreRange: true };
    await downloadArchive(input(p));
    expect(readFileSync(p).equals(BODY)).toBe(true);
  });

  it("a part file longer than the archive (another build's leftover) is dropped", async () => {
    const p = part();
    writeFileSync(p, Buffer.alloc(BODY.length + 5));
    await downloadArchive(input(p));
    expect(readFileSync(p).equals(BODY)).toBe(true);
  });

  it("more bytes than the manifest says are never written past the size: the download is refused", async () => {
    const p = part();
    behaviour = { extra: 50_000 };
    await expect(downloadArchive(input(p))).rejects.toMatchObject({ code: "too-large" });
    expect(statSync(p).size).toBeLessThanOrEqual(BODY.length + 70_000);
    expect(requests).toHaveLength(1);
  });

  it("404 (the URL died, the build was replaced) gives up after the attempts, each with a fresh URL", async () => {
    behaviour = { status: 404 };
    let urls = 0;
    const err = await downloadArchive(input(part(), { url: async () => `${origin}/t${urls++}` })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).code).toBe("http");
    expect(urls).toBe(3);
  });

  it("a server that never answers is cut after the idle timeout", async () => {
    behaviour = { stall: true };
    const started = Date.now();
    await expect(downloadArchive(input(part(), { attempts: 1, idleTimeoutMs: 300 }))).rejects.toMatchObject({ code: "network" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops when aborted", async () => {
    behaviour = { stall: true };
    const ac = new AbortController();
    const done = downloadArchive(input(part(), { signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    await expect(done).rejects.toMatchObject({ code: "aborted" });
  });
});
