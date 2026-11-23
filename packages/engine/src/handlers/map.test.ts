// İş C — Harita: map.info / map.token over the real server, and the token's HTTP route on the same listener.
import http from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { authenticate } from "../ws-auth-client.ts";
import type { ServerMessage } from "@kokpit/shared";
import { createMapService, loadMapConfig } from "../map.ts";
import { createEngineServer } from "../server.ts";
import {
  BUILTIN_PROJECT_ID,
  FakeCards,
  FakeLaunch,
  FakeLogger,
  FakeProjects,
  FakePtys,
  FakeSettings,
  FakeSshHosts,
  FakeStore,
  FakeTools,
  TEST_KEY,
  makeConfig,
} from "../../test/fakes/server-fakes.ts";

let root: string;
let server: ReturnType<typeof createEngineServer>;
let port: number;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kokpit-maph-")));
  mkdirSync(join(root, "graphify-out"));
  writeFileSync(join(root, "graphify-out", "graph.html"), "<p>HANDLER-MAP</p>");
  const store = new FakeStore();
  const projects = new FakeProjects();
  projects.items.set("pm", { id: "pm", name: "Harita", location: { kind: "local", path: root } });
  const tools = new FakeTools();
  const logger = new FakeLogger();
  server = createEngineServer({
    config: makeConfig(),
    store,
    projects,
    sshHosts: new FakeSshHosts(),
    tools,
    settings: new FakeSettings(tools),
    cards: new FakeCards(store),
    ptys: new FakePtys(),
    logger,
    version: "test",
    resolveLaunch: new FakeLaunch().resolve,
    builtinProjectId: BUILTIN_PROJECT_ID,
    map: createMapService({ config: loadMapConfig({}), logger }),
  });
  await server.start();
  port = server.addresses()[0]!.port;
});

afterAll(async () => {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

async function request(method: string, params: Record<string, unknown>): Promise<Extract<ServerMessage, { type: "res" }>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    ws.on("error", reject);
    authenticate(ws, TEST_KEY).then(() => ws.send(JSON.stringify({ type: "req", id: 7, method, params })), reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type === "res" && msg.id === 7) {
        ws.close();
        resolve(msg);
      }
    });
  });
}

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (d: Buffer) => (body += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

describe("map handlers", () => {
  it("map.info finds the project's map", async () => {
    const res = await request("map.info", { projectId: "pm" });
    expect(res.ok && res.result).toMatchObject({ available: true, file: join("graphify-out", "graph.html") });
  });

  it("map.info for ssh projects is unavailable, unknown projects NOT_FOUND", async () => {
    const ssh = await request("map.info", { projectId: "ps" });
    expect(ssh.ok && ssh.result).toEqual({ available: false });
    const missing = await request("map.info", { projectId: "nope" });
    expect(!missing.ok && missing.error.code).toBe("NOT_FOUND");
  });

  it("map.token → one GET on the same listener serves the file", async () => {
    const res = await request("map.token", { projectId: "pm" });
    if (!res.ok) throw new Error(res.error.message);
    const { path } = res.result as { path: string };
    const first = await httpGet(path);
    expect(first).toEqual({ status: 200, body: "<p>HANDLER-MAP</p>" });
    expect((await httpGet(path)).status).toBe(404);
    expect((await httpGet("/health")).status).toBe(200);
  });

  it("map.token refuses ssh projects", async () => {
    const res = await request("map.token", { projectId: "ps" });
    expect(!res.ok && res.error.code).toBe("INVALID");
  });

});
