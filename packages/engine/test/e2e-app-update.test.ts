// Kendini güncelleme end-to-end against the real engine: a bundle is published with the publish script, announced
// over the authenticated WebSocket (manifest + entry list), and its blob fetched over HTTP for a token — whole, by
// range, and resumed.
// Also: a request with a method the engine does not know gets an answer and the connection stays.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOSE_CODES, PROTOCOL_VERSION, makeBuildId, type AppUpdateManifest, type BuildInfo, type ServerMessage } from "@kokpit/shared";
import { ensureSigningKey, verifyManifest, type SigningKey } from "@kokpit/shared/update-signing";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const PUBLISH = fileURLToPath(new URL("../scripts/publish-app.ts", import.meta.url));
const KEEP = 2;
const TOKEN_TTL_MS = 1500;
const ARCHIVE_BYTES = 300_000;
const CLIENT_ID = "e2e-client-0001";

let root: string;
let config: string;
let updatesDir: string;
let engine: EngineProc | undefined;
let c: Client;
/** The publisher key, created in a temp folder the way `publish-app.ts keygen` does. */
let signingKey: SigningKey;

const buildId = (minute: number) => makeBuildId("0.1.0", "e2e0000", new Date(Date.UTC(2026, 10, 18, 9, minute, 0)));
const APP: BuildInfo = { buildId: buildId(0), version: "0.1.0", commit: "e2e0000", builtAt: "2026-11-18T09:00:00.000Z" };

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

/** A bundle folder whose Info.plist carries the build id, padded with random (incompressible) bytes. */
function makeArchive(id: string): { path: string; pad: Buffer } {
  const work = mkdtempSync(join(root, "bundle-"));
  const contents = join(work, "Kokpit.app", "Contents");
  mkdirSync(join(contents, "Resources"), { recursive: true });
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>KokpitBuildId</key><string>${id}</string><key>KokpitUpdateKeyId</key><string>${signingKey.keyId}</string><key>CFBundleShortVersionString</key><string>0.1.0</string></dict></plist>`,
  );
  const pad = randomBytes(ARCHIVE_BYTES);
  writeFileSync(join(contents, "Resources", "pad.bin"), pad);
  return { path: join(work, "Kokpit.app"), pad };
}
/** The blob of a published build, as it lies in the engine's data folder. */
const blobOf = (id: string): Buffer => readFileSync(join(updatesDir, id, "bundle.bin.gz"));

function publish(zip: string): string {
  return execFileSync(process.execPath, [PUBLISH, "--config", config, "--app", zip], { encoding: "utf8" });
}

type Check = { engine: { build: BuildInfo; protocol: number }; update: AppUpdateManifest | null };
const check = (client: Client = c) => client.req<Check>("app.update.check", { clientId: CLIENT_ID, app: APP, protocol: PROTOCOL_VERSION });
type Download = { path: string; size: number; sha256: string; expiresAt: string; entries: { path: string; type: string; size?: number; sha256?: string }[] };

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-app-update-")));
  mkdirSync(join(root, "home"));
  signingKey = ensureSigningKey(join(root, "signing"));
  config = join(root, "engine.json");
  updatesDir = join(root, "data", "app-updates");
  writeFileSync(
    config,
    JSON.stringify({
      dataDir: join(root, "data"),
      port: 0,
      shell: "/bin/sh",
      shellArgs: [],
      listenTailscale: false,
      browser: { testMode: true, headless: true },
      appUpdates: { keep: KEEP, tokenTtlMs: TOKEN_TTL_MS, signingKeyDir: join(root, "signing") },
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: config, KOKPIT_KEY: KEY, HOME: join(root, "home") });
  c = await Client.connect(engine.port, KEY);
});

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("identity", () => {
  it("hello.ok carries the engine's build id and the protocol number; the listening log names the build", () => {
    const hello = c.frames.find((f) => f.type === "hello.ok") as Extract<ServerMessage, { type: "hello.ok" }>;
    expect(hello.protocol).toBe(PROTOCOL_VERSION);
    expect(hello.engineBuild?.buildId).toMatch(/^\d+\.\d+\.\d+\+\d{14}\./);
    expect(engine!.logs()).toContain(hello.engineBuild!.buildId);
  });

  it("nothing published → the check answers with the engine's identity and no update", async () => {
    const r = await check();
    expect(r.update).toBeNull();
    expect(r.engine.protocol).toBe(PROTOCOL_VERSION);
    expect(r.engine.build.version).toBe("0.1.0");
  });
});

describe("unknown method (an app newer than the engine)", () => {
  it("is answered with UNKNOWN_METHOD and the connection stays usable", async () => {
    const old = await Client.connect(engine!.port, KEY);
    const err = await old.req("future.feature.do", { anything: 1 }).then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(err?.code).toBe("UNKNOWN_METHOD");
    expect(err?.message).toContain("future.feature.do");
    expect((await old.req<{ projects: unknown[] }>("projects.list", {})).projects.length).toBeGreaterThan(0);
    expect(old.ws.readyState).toBe(WebSocket.OPEN);
    expect(engine!.logs()).toContain('"unknown method"');
    await old.close();
  });

  it("a malformed frame still closes the connection (4400)", async () => {
    const bad = await Client.connect(engine!.port, KEY);
    const closed = new Promise<number>((resolve) => bad.ws.once("close", (code) => resolve(code)));
    bad.ws.send(JSON.stringify({ type: "req", method: "future.feature.do", params: {} }));
    expect(await closed).toBe(CLOSE_CODES.BAD_MESSAGE);
  });
});

describe("publish → manifest → download", () => {
  let archive: { path: string; pad: Buffer };
  let manifest: AppUpdateManifest;

  it("a published build is announced without restarting the engine", async () => {
    archive = makeArchive(buildId(1));
    expect(publish(archive.path)).toContain(`published ${buildId(1)}`);
    const r = await check();
    const blob = blobOf(buildId(1));
    expect(r.update).toMatchObject({ buildId: buildId(1), version: "0.1.0", format: 1, bundleName: "Kokpit.app", size: blob.length, sha256: createHash("sha256").update(blob).digest("hex"), entryCount: 4 });
    expect(r.update!.unpackedSize).toBe(gunzipSync(blob).length);
    manifest = r.update!;
    // Signed by the publisher key over what the app acts on.
    const { signature, signingKeyId, ...fields } = manifest;
    expect(signingKeyId).toBe(signingKey.keyId);
    expect(verifyManifest(signingKey.publicKey, fields, signature)).toBe(true);
  });

  it("the archive downloads for a token: whole, by range, and resumed from where a download stopped", async () => {
    const d = await c.req<Download>("app.update.download", { buildId: manifest.buildId });
    expect(d).toMatchObject({ size: manifest.size, sha256: manifest.sha256 });
    // The entry list comes with it, over the authenticated socket: every file with its size and hash.
    expect(d.entries.map((e) => `${e.type} ${e.path}`)).toEqual(["dir Contents", "file Contents/Info.plist", "dir Contents/Resources", "file Contents/Resources/pad.bin"]);
    expect(d.entries[3]).toMatchObject({ size: ARCHIVE_BYTES, sha256: createHash("sha256").update(archive.pad).digest("hex") });
    const whole = await get(d.path);
    expect(whole.status).toBe(200);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.headers["content-type"]).toBe("application/octet-stream");
    // The blob is the files' bytes in list order.
    expect(gunzipSync(whole.body).subarray(-ARCHIVE_BYTES).equals(archive.pad)).toBe(true);
    expect(createHash("sha256").update(whole.body).digest("hex")).toBe(manifest.sha256);

    const cut = 100_000;
    const first = await get(d.path, `bytes=0-${cut - 1}`);
    expect(first.status).toBe(206);
    expect(first.headers["content-range"]).toBe(`bytes 0-${cut - 1}/${manifest.size}`);
    const rest = await get(d.path, `bytes=${cut}-`);
    expect(rest.status).toBe(206);
    expect(rest.headers["content-range"]).toBe(`bytes ${cut}-${manifest.size - 1}/${manifest.size}`);
    expect(createHash("sha256").update(Buffer.concat([first.body, rest.body])).digest("hex")).toBe(manifest.sha256);

    expect((await get(d.path, `bytes=${manifest.size}-`)).status).toBe(416);
    expect((await request("POST", d.path)).status).toBe(405);
    const head = await request("HEAD", d.path);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(manifest.size));
    expect(head.body.length).toBe(0);
  });

  it("no token, a wrong token, a token with a suffix → 404; the build folder is not reachable by name", async () => {
    for (const path of ["/app-updates/", `/app-updates/${"x".repeat(43)}`, `/app-updates/${manifest.buildId}/bundle.bin.gz`, `/app-updates/${manifest.buildId}/entries.json`, "/app-updates/../engine.key", "/app-updates/current.json"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    const d = await c.req<Download>("app.update.download", { buildId: manifest.buildId });
    expect((await get(`${d.path}/x`)).status).toBe(404);
    expect((await get(`${d.path}?a=1`)).status).toBe(404);
  });

  it("the URL belongs to its connection and dies with it; an idle URL expires", async () => {
    const other = await Client.connect(engine!.port, KEY);
    const d = await other.req<Download>("app.update.download", { buildId: manifest.buildId });
    expect((await request("HEAD", d.path)).status).toBe(200);
    await other.close();
    await expect.poll(async () => (await request("HEAD", d.path)).status).toBe(404);

    const idle = await c.req<Download>("app.update.download", { buildId: manifest.buildId });
    await new Promise((r) => setTimeout(r, TOKEN_TTL_MS + 300));
    expect((await request("HEAD", idle.path)).status).toBe(404);
  });

  it("a build that is not the current one gets no URL", async () => {
    const err = await c.req("app.update.download", { buildId: buildId(55) }).then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(err?.code).toBe("NOT_FOUND");
  });

  it("without the key nothing is announced: a wrong key is closed 4401, a request before hello too", async () => {
    const ws = new WebSocket(`ws://${engine!.host}:${engine!.port}`);
    await new Promise<void>((res, rej) => (ws.once("open", () => res()), ws.once("error", rej)));
    const frames: string[] = [];
    ws.on("message", (d) => frames.push(d.toString()));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ type: "req", id: 1, method: "app.update.check", params: { clientId: CLIENT_ID, app: APP, protocol: PROTOCOL_VERSION } }));
    expect(await closed).toBe(CLOSE_CODES.UNAUTHORIZED);
    expect(frames).toEqual([]);
  });

  it("newer publishes replace the current build; only the last `keep` stay on disk; an old URL stops", async () => {
    const d1 = await c.req<Download>("app.update.download", { buildId: manifest.buildId });
    const a2 = makeArchive(buildId(2));
    publish(a2.path);
    const a3 = makeArchive(buildId(3));
    const out = publish(a3.path);
    expect(out).toContain(`pruned:  ${buildId(1)}`);
    expect((await check()).update?.buildId).toBe(buildId(3));
    expect(existsSync(join(updatesDir, buildId(1)))).toBe(false);
    expect(existsSync(join(updatesDir, buildId(2)))).toBe(true);
    // The archive the old URL named is gone: the URL answers 404 instead of other bytes.
    expect((await get(d1.path)).status).toBe(404);
    const d3 = await c.req<Download>("app.update.download", { buildId: buildId(3) });
    expect(createHash("sha256").update((await get(d3.path)).body).digest("hex")).toBe(createHash("sha256").update(blobOf(buildId(3))).digest("hex"));
    expect(d3.entries[3]?.sha256).toBe(createHash("sha256").update(a3.pad).digest("hex"));
  });

  it("the engine remembers which build each app reported, for the deploy helper", async () => {
    await c.req("app.update.report", { clientId: CLIENT_ID, buildId: buildId(3), outcome: "rolledBack", detail: "açılmadı" });
    const r = await c.req<{ current: AppUpdateManifest | null; clients: { clientId: string; buildId: string; outcome?: string }[] }>("app.update.clients", {});
    expect(r.current?.buildId).toBe(buildId(3));
    expect(r.clients).toEqual([expect.objectContaining({ clientId: CLIENT_ID, buildId: APP.buildId, outcome: "rolledBack", outcomeBuildId: buildId(3) })]);
    expect(engine!.logs()).toContain('"app update report"');
  });
});
