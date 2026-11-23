// Girişler: logins.* over the engine's WebSocket. Only the app's connection (access key) may use them; a scoped
// connection (Claude's screen MCP, `hello.screen`) is refused every one. No password is ever sent to a client, and
// none reaches the log — whatever the outcome.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AuthCredential } from "@kokpit/shared";
import { authenticate } from "../ws-auth-client.ts";
import type { LoginFillField, LoginPolicy, SavedLogin, ServerMessage } from "@kokpit/shared";
import { EngineError } from "../contracts.ts";
import type { LoginService } from "../logins.ts";
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

const WAIT_MS = 2000;
const SECRET = "gizli-parola-Zx9!";
const PROJECT = "p1";
const ORIGIN = "https://ornek.example";
const AT = "2026-01-01T00:00:00.000Z";

type Res = Extract<ServerMessage, { type: "res" }>;
const servers: ReturnType<typeof createEngineServer>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of servers.splice(0)) await s.stop();
});

class FakeLogins implements LoginService {
  calls: unknown[][] = [];
  items: SavedLogin[] = [];
  failWith: EngineError | undefined;
  list(projectId: string): SavedLogin[] {
    this.calls.push(["list", projectId]);
    return this.items.filter((l) => l.projectId === projectId);
  }
  async save(input: { projectId: string; origin: string; username: string; password: string; label?: string | undefined }): Promise<SavedLogin> {
    this.calls.push(["save", input]);
    if (this.failWith) throw this.failWith;
    const login: SavedLogin = { id: `id-${this.items.length + 1}`, projectId: input.projectId, origin: input.origin, username: input.username, createdAt: AT, updatedAt: AT };
    this.items.push(login);
    return login;
  }
  async delete(id: string): Promise<void> {
    this.calls.push(["delete", id]);
    if (!this.items.some((l) => l.id === id)) throw new EngineError("NOT_FOUND", "Giriş bulunamadı");
    this.items = this.items.filter((l) => l.id !== id);
  }
  accepted = new Set<string>();
  async policy(projectId: string): Promise<LoginPolicy> {
    return { keychainAccess: "confirm", agentRiskAccepted: this.accepted.has(projectId), agentsPresent: false };
  }
  async setRisk(projectId: string, accepted: boolean): Promise<LoginPolicy> {
    this.calls.push(["setRisk", projectId, accepted]);
    if (accepted) this.accepted.add(projectId);
    else this.accepted.delete(projectId);
    return this.policy(projectId);
  }
  async fill(projectId: string, id: string, opts?: { confirmAgentRisk?: boolean | undefined }): Promise<LoginFillField[]> {
    this.calls.push(["fill", projectId, id, opts?.confirmAgentRisk]);
    if (this.failWith) throw this.failWith;
    if (!this.accepted.has(projectId)) throw new EngineError("LOGIN_RISK_UNACCEPTED", "Bu tarayıcıyı ajanlar da sürebiliyor");
    return ["username", "password"];
  }
  forgetProject(projectId: string): void {
    this.calls.push(["forgetProject", projectId]);
  }
  async idle(): Promise<void> {}
}

async function setup(withLogins = true) {
  const store = new FakeStore();
  const projects = new FakeProjects();
  const tools = new FakeTools();
  const logger = new FakeLogger();
  const logins = new FakeLogins();
  const server = createEngineServer({
    config: makeConfig(),
    store,
    projects,
    sshHosts: new FakeSshHosts(),
    tools,
    settings: new FakeSettings(tools),
    cards: new FakeCards(store),
    ptys: new FakePtys(),
    logger,
    version: "t",
    resolveLaunch: new FakeLaunch().resolve,
    builtinProjectId: BUILTIN_PROJECT_ID,
    ...(withLogins ? { logins } : {}),
  });
  servers.push(server);
  await server.start();
  return { port: server.addresses()[0]!.port, logins, logger, projects };
}

async function connect(port: number, credential: string | AuthCredential) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const got: ServerMessage[] = [];
  const raw: string[] = [];
  ws.on("message", (d) => {
    raw.push(d.toString());
    got.push(JSON.parse(d.toString()) as ServerMessage);
  });
  await new Promise((r) => ws.once("open", r));
  const authed = authenticate(ws, credential);
  const wait = async (pred: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
    const start = Date.now();
    for (;;) {
      const hit = got.find(pred);
      if (hit) return hit;
      if (Date.now() - start > WAIT_MS) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await authed;
  let id = 0;
  const req = async (method: string, params: Record<string, unknown>): Promise<Res> => {
    const myId = ++id;
    ws.send(JSON.stringify({ type: "req", id: myId, method, params }));
    return (await wait((m) => m.type === "res" && m.id === myId)) as Res;
  };
  return { ws, req, raw };
}

const app = (port: number) => connect(port, TEST_KEY);
const SAVE = { projectId: PROJECT, origin: ORIGIN, username: "ayşe", password: SECRET };

describe("logins.* handlers", () => {
  it("the app's connection saves, lists, fills and deletes", async () => {
    const h = await setup();
    const c = await app(h.port);
    const saved = await c.req("logins.save", SAVE);
    expect(saved).toMatchObject({ ok: true, result: { login: { id: "id-1", projectId: PROJECT, origin: ORIGIN, username: "ayşe" } } });
    expect(await c.req("logins.list", { projectId: PROJECT })).toMatchObject({
      ok: true,
      result: { logins: [{ id: "id-1" }], policy: { keychainAccess: "confirm", agentRiskAccepted: false, agentsPresent: false } },
    });
    // The engine, not the app, holds the line: no acceptance, no fill.
    expect(await c.req("logins.fill", { projectId: PROJECT, id: "id-1" })).toMatchObject({ ok: false, error: { code: "LOGIN_RISK_UNACCEPTED" } });
    expect(await c.req("logins.risk.set", { projectId: PROJECT, accepted: true })).toMatchObject({ ok: true, result: { policy: { agentRiskAccepted: true } } });
    expect(await c.req("logins.fill", { projectId: PROJECT, id: "id-1", confirmAgentRisk: true })).toEqual({ type: "res", id: 5, ok: true, result: { filled: ["username", "password"] } });
    expect(await c.req("logins.risk.set", { projectId: PROJECT, accepted: false })).toMatchObject({ ok: true, result: { policy: { agentRiskAccepted: false } } });
    expect(await c.req("logins.delete", { id: "id-1" })).toMatchObject({ ok: true, result: {} });
    expect(h.logins.calls.map((x) => x[0])).toEqual(["save", "list", "fill", "setRisk", "fill", "setRisk", "delete"]);
    expect(h.logins.calls[4]).toEqual(["fill", PROJECT, "id-1", true]);
  });

  it("no frame sent to the client and no log line ever carries the password", async () => {
    const h = await setup();
    const c = await app(h.port);
    await c.req("logins.save", SAVE);
    await c.req("logins.save", { ...SAVE, extra: SECRET });
    await c.req("logins.save", { ...SAVE, password: `${SECRET}\ud800` });
    await c.req("logins.save", { ...SAVE, password: SECRET.repeat(200) });
    await c.req("logins.save", { ...SAVE, origin: "ftp://x" });
    await c.req("logins.save", { ...SAVE, projectId: "yok" });
    h.logins.failWith = new EngineError("KEYCHAIN_FAILED", "Anahtar zinciri kilitli");
    expect(await c.req("logins.save", SAVE)).toMatchObject({ ok: false, error: { code: "KEYCHAIN_FAILED", message: "Anahtar zinciri kilitli" } });
    await c.req("logins.list", { projectId: PROJECT });
    await c.req("logins.fill", { projectId: PROJECT, id: "id-1" });
    expect(c.raw.join("\n")).not.toContain("gizli");
    expect(h.logger.dump()).not.toContain("gizli");
    expect(h.logger.dump()).not.toContain("ayşe");
  });

  it("an unexpected failure inside the service is an internal error without its text", async () => {
    const h = await setup();
    const c = await app(h.port);
    h.logins.save = async () => {
      throw new Error(`boom ${SECRET}`);
    };
    const res = await c.req("logins.save", SAVE);
    expect(res).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(res)).not.toContain("gizli");
    expect(h.logger.dump()).not.toContain("gizli");
  });


  it("unknown projects, client-side browsers and bad params are refused before the service is asked", async () => {
    const h = await setup();
    const c = await app(h.port);
    expect(await c.req("logins.list", { projectId: "yok" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await c.req("logins.save", { ...SAVE, projectId: "yok" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await c.req("logins.fill", { projectId: "yok", id: "a" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await c.req("logins.fill", { projectId: PROJECT })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await c.req("logins.save", { ...SAVE, password: "" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    h.projects.items.set(PROJECT, { ...h.projects.items.get(PROJECT)!, browser: { runOn: "client" } });
    expect(await c.req("logins.save", SAVE)).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await c.req("logins.fill", { projectId: PROJECT, id: "a" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(h.logins.calls).toEqual([]);
    // The connection is still fine.
    expect(await c.req("logins.list", { projectId: PROJECT })).toMatchObject({ ok: true, result: { logins: [] } });
  });

  it("an engine without the service: an empty list, the rest INVALID", async () => {
    const h = await setup(false);
    const c = await app(h.port);
    expect(await c.req("logins.list", { projectId: PROJECT })).toMatchObject({ ok: true, result: { logins: [], policy: { agentRiskAccepted: false } } });
    for (const [method, params] of [
      ["logins.risk.set", { projectId: PROJECT, accepted: true }],
      ["logins.save", SAVE],
      ["logins.fill", { projectId: PROJECT, id: "a" }],
      ["logins.delete", { id: "a" }],
    ] as const) {
      expect(await c.req(method, params), method).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
  });
});
