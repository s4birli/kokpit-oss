// İş C — Harita end-to-end against the real engine: a temp project with a fake graphify-out, the newest
// map found and served once over the engine's own HTTP listener, traversal and symlink escapes refused.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startEngine, stopEngine, type EngineProc } from "./harness.ts";

const KEY = randomBytes(32).toString("base64url");
const NEW_MARKER = "KOKPIT-MAP-NEWEST-8c1e";
const OLD_MARKER = "KOKPIT-MAP-OLD-2b7d";
const SECRET = "KOKPIT-SECRET-OUTSIDE-5f0a";
const UPDATE_COMMAND = "echo MAP_UPDATE_$((6*7))";
const DIMS = { cols: 100, rows: 30 };

let root: string;
let projDir: string;
let emptyDir: string;
let engine: EngineProc | undefined;
let c: Client;
let projectId: string;
let emptyId: string;

function writeAt(path: string, content: string, mtimeSec: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeSec, mtimeSec);
}

function rawGet(path: string): Promise<{ status: number; body: string; csp?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: engine!.port, path }, (res) => {
        let body = "";
        res.on("data", (d: Buffer) => (body += d.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, csp: res.headers["content-security-policy"] as string | undefined }),
        );
      })
      .on("error", reject);
  });
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-e2e-map-")));
  projDir = join(root, "harita projesi");
  emptyDir = join(root, "boş proje");
  mkdirSync(projDir);
  mkdirSync(emptyDir);
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "secret.html"), `<p>${SECRET}</p>`);
  writeFileSync(join(projDir, "notes.txt"), SECRET);
  writeAt(join(projDir, "graphify-out", "graph.html"), `<p>${OLD_MARKER}</p>`, 1_700_000_000);
  writeAt(join(projDir, "graphify-out", "2026-11-12", "graph.html"), `<html><body><p>${NEW_MARKER}</p></body></html>`, 1_800_000_000);
  // Newer, but escapes graphify-out through symlinks: must never be picked or served.
  mkdirSync(join(projDir, "graphify-out", "2026-11-13"));
  symlinkSync(join(root, "secret.html"), join(projDir, "graphify-out", "2026-11-13", "graph.html"));
  symlinkSync(root, join(projDir, "graphify-out", "escape"));

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
      map: { updateCommand: UPDATE_COMMAND, tokenTtlMs: 2000 },
    }),
  );
  engine = await startEngine({ KOKPIT_CONFIG: configPath, KOKPIT_KEY: KEY, HOME: join(root, "home") });
  c = await Client.connect(engine.port, KEY);
  await c.req("settings.update", { defaultToolId: null });
  projectId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Harita", location: { kind: "local", path: projDir } })).project.id;
  emptyId = (await c.req<{ project: { id: string } }>("projects.create", { name: "Boş", location: { kind: "local", path: emptyDir } })).project.id;
}, 30000);

afterAll(async () => {
  await c?.close();
  await stopEngine(engine);
  rmSync(root, { recursive: true, force: true });
});

describe("Harita end-to-end", () => {
  it("map.info finds the newest real map and reports the configured update command", async () => {
    const info = await c.req("map.info", { projectId });
    expect(info).toEqual({
      available: true,
      file: join("graphify-out", "2026-11-12", "graph.html"),
      generatedAt: new Date(1_800_000_000 * 1000).toISOString(),
      updateCommand: UPDATE_COMMAND,
    });
  });

  it("a project without graphify-out is not available, but can still be updated", async () => {
    expect(await c.req("map.info", { projectId: emptyId })).toEqual({ available: false, updateCommand: UPDATE_COMMAND });
    await expect(c.req("map.token", { projectId: emptyId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serves the newest map once over HTTP with a sandboxing CSP", async () => {
    const { path } = await c.req<{ path: string }>("map.token", { projectId });
    const first = await rawGet(path);
    expect(first.status).toBe(200);
    expect(first.body).toContain(NEW_MARKER);
    expect(first.body).not.toContain(SECRET);
    expect(first.csp).toMatch(/sandbox allow-scripts/);
    expect((await rawGet(path)).status).toBe(404);
  });

  it("refuses traversal attempts and guessed tokens", async () => {
    const probes = [
      "/map/../../secret.html",
      "/map/..%2f..%2fsecret.html",
      "/map/%2e%2e%2fnotes.txt",
      "/map/graph.html",
      "/map/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      `/map/${"A".repeat(43)}/../../notes.txt`,
      "/graphify-out/graph.html",
      "/map/",
    ];
    for (const p of probes) {
      const r = await rawGet(p);
      expect(r.status, p).toBe(404);
      expect(r.body).not.toContain(SECRET);
      expect(r.body).not.toContain(NEW_MARKER);
    }
  });

  it("tokens expire", async () => {
    const { path } = await c.req<{ path: string }>("map.token", { projectId });
    await new Promise((r) => setTimeout(r, 2200));
    expect((await rawGet(path)).status).toBe(404);
  });

  it("the update command opens a project terminal that runs it", async () => {
    const info = await c.req<{ updateCommand: string }>("map.info", { projectId });
    const { terminal } = await c.req<{ terminal: { id: string } }>("terminal.open", { projectId, command: info.updateCommand, ...DIMS });
    await c.waitForOutput(terminal.id, /MAP_UPDATE_42/);
    await c.req("terminal.close", { terminalId: terminal.id });
  });

  it("ssh projects have no map", async () => {
    // A ssh-config alias host exists only with ~/.ssh/config; create a Kokpit host instead.
    const { host } = await c.req<{ host: { id: string } }>("sshHosts.create", { name: "Uzak", hostname: "uzak.example" });
    const { project } = await c.req<{ project: { id: string } }>("projects.create", {
      name: "Uzak",
      location: { kind: "ssh", hostId: host.id, path: projDir },
    });
    expect(await c.req("map.info", { projectId: project.id })).toEqual({ available: false });
    await expect(c.req("map.token", { projectId: project.id })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("the engine log never contains the token", async () => {
    const { path } = await c.req<{ path: string }>("map.token", { projectId });
    await rawGet(path);
    expect(engine!.logs()).not.toContain(path.slice("/map/".length));
  });
});
