// İş C — Harita: finding the newest graphify map, one-time tokens and the HTTP route.
import http from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAP_HTTP_PREFIX, type Project } from "@kokpit/shared";
import { EngineError } from "./contracts.ts";
import { createMapService, findNewestMap, loadMapConfig, MapConfigOverrideSchema, type MapConfig } from "./map.ts";
import { FakeLogger } from "../test/fakes/server-fakes.ts";

let root: string;
let proj: string;
let outside: string;

const CONFIG: MapConfig = { ...loadMapConfig({}), maxDepth: 2, maxEntries: 1000, maxBytes: 1024 * 1024, tokenTtlMs: 1000, maxTokens: 3 };
const local = (path: string, id = "p1"): Project => ({ id, name: id, location: { kind: "local", path } });

function writeAt(path: string, content: string, mtimeSec: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeSec, mtimeSec);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-map-")));
  proj = join(root, "proje");
  outside = join(root, "dışarı");
  mkdirSync(proj);
  mkdirSync(outside);
  writeFileSync(join(outside, "graph.html"), "<p>SECRET-OUTSIDE</p>");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadMapConfig", () => {
  it("ships sane defaults (graphify-out/graph.html, claude /graphify)", () => {
    const c = loadMapConfig({});
    expect(c.dirName).toBe("graphify-out");
    expect(c.fileGlob).toBe("graph.html");
    expect(c.updateCommand).toBe('claude "/graphify ."');
    expect(c.contentSecurityPolicy).toMatch(/sandbox allow-scripts/);
  });

  it("applies overrides on top of the defaults", () => {
    expect(loadMapConfig({ updateCommand: "echo hi", maxDepth: 1 })).toMatchObject({ updateCommand: "echo hi", maxDepth: 1, dirName: "graphify-out" });
  });

  it.each([
    ["dir with slash", { dirName: "a/b" }],
    ["dir dot-dot", { dirName: ".." }],
    ["glob with slash", { fileGlob: "../*.html" }],
    ["negative depth", { maxDepth: -1 }],
    ["unknown key", { foo: 1 }],
  ])("rejects bad overrides: %s", (_n, o) => {
    expect(MapConfigOverrideSchema.safeParse(o).success).toBe(false);
  });

  it("requires the CSP to keep the sandbox directive", () => {
    expect(() => loadMapConfig({ contentSecurityPolicy: "default-src *" })).toThrow(/sandbox/);
  });
});

describe("findNewestMap", () => {
  it("returns null without a graphify-out folder", () => {
    expect(findNewestMap(proj, CONFIG)).toBeNull();
  });

  it("picks the newest matching file at any allowed depth", () => {
    writeAt(join(proj, "graphify-out", "graph.html"), "old", 1000);
    writeAt(join(proj, "graphify-out", "2026-11-12", "graph.html"), "new", 3000);
    writeAt(join(proj, "graphify-out", "2026-11-11", "graph.html"), "mid", 2000);
    writeAt(join(proj, "graphify-out", "2026-11-13", "other.html"), "not a match", 9000);
    const found = findNewestMap(proj, CONFIG);
    expect(found?.relative).toBe(join("graphify-out", "2026-11-12", "graph.html"));
    expect(found?.mtimeMs).toBe(3000 * 1000);
  });

  it("honours the glob and the depth limit", () => {
    writeAt(join(proj, "graphify-out", "a", "b", "c", "graph.html"), "too deep", 5000);
    writeAt(join(proj, "graphify-out", "a", "b", "graph.html"), "ok", 4000);
    expect(findNewestMap(proj, CONFIG)?.relative).toBe(join("graphify-out", "a", "b", "graph.html"));
    writeAt(join(proj, "graphify-out", "x.html"), "glob", 6000);
    expect(findNewestMap(proj, { ...CONFIG, fileGlob: "*.html" })?.relative).toBe(join("graphify-out", "x.html"));
  });

  it("never follows symlinks (files, folders or graphify-out itself)", () => {
    mkdirSync(join(proj, "graphify-out"));
    symlinkSync(join(outside, "graph.html"), join(proj, "graphify-out", "graph.html"));
    symlinkSync(outside, join(proj, "graphify-out", "link-dir"));
    expect(findNewestMap(proj, CONFIG)).toBeNull();
    rmSync(join(proj, "graphify-out"), { recursive: true });
    symlinkSync(outside, join(proj, "graphify-out"));
    expect(findNewestMap(proj, CONFIG)).toBeNull();
  });

  it("stops after maxEntries", () => {
    for (let i = 0; i < 20; i++) writeAt(join(proj, "graphify-out", `f${String(i).padStart(2, "0")}.txt`), "x", 1000);
    writeAt(join(proj, "graphify-out", "zz", "graph.html"), "late", 2000);
    expect(findNewestMap(proj, { ...CONFIG, maxEntries: 5 })).toBeNull();
  });
});

describe("map service", () => {
  let server: http.Server;
  let port: number;
  let now = 1_000_000;
  const svc = () =>
    createMapService({ config: CONFIG, logger: new FakeLogger(), now: () => now });
  let map: ReturnType<typeof svc>;

  beforeEach(async () => {
    now = 1_000_000;
    map = svc();
    server = http.createServer((req, res) => {
      if (!map.handleHttp(req, res)) {
        res.writeHead(418);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Raw request: the path is sent verbatim (fetch would normalise `..`). */
  const get = (path: string, method = "GET") =>
    new Promise<{ status: number; headers: Headers; body: string }>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (body += d));
        res.on("end", () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
          resolve({ status: res.statusCode ?? 0, headers, body });
        });
      });
      r.on("error", reject);
      r.end();
    });

  it("info: unavailable without a map, available with the newest", () => {
    expect(map.info(local(proj))).toEqual({ available: false, updateCommand: CONFIG.updateCommand });
    writeAt(join(proj, "graphify-out", "graph.html"), "<p>MAP</p>", 2000);
    expect(map.info(local(proj))).toEqual({
      available: true,
      file: join("graphify-out", "graph.html"),
      generatedAt: new Date(2000 * 1000).toISOString(),
      updateCommand: CONFIG.updateCommand,
    });
  });

  it("info: ssh projects never have a map", () => {
    expect(map.info({ id: "s", name: "s", location: { kind: "ssh", hostId: "h", path: proj } })).toEqual({ available: false });
  });

  it("token: refused without a map, for ssh and for oversized files", () => {
    expect(() => map.issueToken(local(proj))).toThrow(EngineError);
    expect(() => map.issueToken({ id: "s", name: "s", location: { kind: "ssh", hostId: "h" } })).toThrow(EngineError);
    writeAt(join(proj, "graphify-out", "graph.html"), "x".repeat(CONFIG.maxBytes + 1), 2000);
    expect(() => map.issueToken(local(proj))).toThrow(/büyük/);
  });

  it("serves the file once with locked-down headers", async () => {
    writeAt(join(proj, "graphify-out", "graph.html"), "<p>KOKPIT-MAP</p>", 2000);
    const { path, expiresAt } = map.issueToken(local(proj));
    expect(path.startsWith(MAP_HTTP_PREFIX)).toBe(true);
    expect(Date.parse(expiresAt)).toBe(now + CONFIG.tokenTtlMs);
    const first = await get(path);
    expect(first.status).toBe(200);
    expect(first.body).toBe("<p>KOKPIT-MAP</p>");
    expect(first.headers.get("content-type")).toMatch(/^text\/html/);
    expect(first.headers.get("content-security-policy")).toBe(CONFIG.contentSecurityPolicy);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await get(path)).status).toBe(404);
  });

  it("refuses expired, unknown and malformed tokens", async () => {
    writeAt(join(proj, "graphify-out", "graph.html"), "<p>x</p>", 2000);
    const { path } = map.issueToken(local(proj));
    now += CONFIG.tokenTtlMs + 1;
    expect((await get(path)).status).toBe(404);
    expect((await get(`${MAP_HTTP_PREFIX}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(404);
    for (const p of ["../../etc/passwd", "..%2f..%2fetc%2fpasswd", "%2e%2e/graph.html", "abc/def", ""]) {
      const r = await get(`${MAP_HTTP_PREFIX}${p}`);
      expect(r.status).toBe(404);
      expect(r.body).not.toContain("SECRET");
    }
  });

  it("only GET is served (a HEAD/POST does not burn or use the token)", async () => {
    writeAt(join(proj, "graphify-out", "graph.html"), "<p>x</p>", 2000);
    const { path } = map.issueToken(local(proj));
    expect((await get(path, "POST")).status).toBe(404);
    expect((await get(path)).status).toBe(200);
  });

  it("leaves other paths to the caller", async () => {
    expect((await get("/health")).status).toBe(418);
  });

  it("keeps at most maxTokens outstanding (oldest dropped)", async () => {
    writeAt(join(proj, "graphify-out", "graph.html"), "<p>x</p>", 2000);
    const paths = Array.from({ length: CONFIG.maxTokens + 1 }, () => map.issueToken(local(proj)).path);
    expect((await get(paths[0]!)).status).toBe(404);
    expect((await get(paths[paths.length - 1]!)).status).toBe(200);
  });

  it("refuses a file swapped for a symlink escaping graphify-out after the token was issued", async () => {
    const file = join(proj, "graphify-out", "graph.html");
    writeAt(file, "<p>x</p>", 2000);
    const { path } = map.issueToken(local(proj));
    rmSync(file);
    symlinkSync(join(outside, "graph.html"), file);
    const r = await get(path);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("SECRET");
  });

  it("refuses when graphify-out itself became a symlink after the token was issued", async () => {
    writeAt(join(proj, "graphify-out", "graph.html"), "<p>x</p>", 2000);
    const { path } = map.issueToken(local(proj));
    rmSync(join(proj, "graphify-out"), { recursive: true });
    symlinkSync(outside, join(proj, "graphify-out"));
    const r = await get(path);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("SECRET");
  });
});
