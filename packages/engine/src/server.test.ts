import http from "node:http";
import net from "node:net";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createHash, createHmac } from "node:crypto";
import { AUTH_LABELS, CLOSE_CODES, createFeatureSet, PROTOCOL_VERSION, MAX_MESSAGE_BYTES, OUTPUT_LIMITS, authProof, keySecret, newNonce, type ServerMessage } from "@kokpit/shared";
import { authenticate, HandshakeError } from "./ws-auth-client.ts";
import { EngineError, type EngineConfig } from "./contracts.ts";
import { createEngineServer, type EngineServerDeps } from "./server.ts";
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
  makeCard,
  makeConfig,
} from "../test/fakes/server-fakes.ts";

const VERSION = "9.9.9-test";
const WAIT_MS = 2000;

type Server = ReturnType<typeof createEngineServer>;
const servers: Server[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const s of servers.splice(0)) await s.stop();
});

interface Harness {
  server: Server;
  store: FakeStore;
  cards: FakeCards;
  ptys: FakePtys;
  projects: FakeProjects;
  sshHosts: FakeSshHosts;
  tools: FakeTools;
  settings: FakeSettings;
  launch: FakeLaunch;
  logger: FakeLogger;
  config: EngineConfig;
  port: number;
}

async function setup(
  overrides: Partial<EngineConfig> = {},
  getInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  extra: Partial<EngineServerDeps> = {},
): Promise<Harness> {
  const config = makeConfig(overrides);
  const store = new FakeStore();
  const cards = new FakeCards(store);
  const ptys = new FakePtys();
  const projects = new FakeProjects();
  const sshHosts = new FakeSshHosts();
  const tools = new FakeTools();
  const settings = new FakeSettings(tools);
  const launch = new FakeLaunch();
  const logger = new FakeLogger();
  const server = createEngineServer({
    config,
    store,
    projects,
    sshHosts,
    tools,
    settings,
    cards,
    ptys,
    logger,
    version: VERSION,
    resolveLaunch: launch.resolve,
    builtinProjectId: BUILTIN_PROJECT_ID,
    ...(getInterfaces ? { getInterfaces } : {}),
    ...extra,
  });
  servers.push(server);
  await server.start();
  const port = server.addresses()[0]?.port ?? 0;
  return { server, store, cards, ptys, projects, sshHosts, tools, settings, launch, logger, config, port };
}

class Client {
  readonly ws: WebSocket;
  readonly received: ServerMessage[] = [];
  /** Length of every frame as it came off the wire. */
  readonly rawSizes: number[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;
  private nextId = 1;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.closed = new Promise((resolve) => {
      this.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    this.ws.on("error", () => {});
    this.ws.on("message", (raw) => {
      const text = raw.toString();
      this.rawSizes.push(text.length);
      const msg = JSON.parse(text) as ServerMessage;
      this.received.push(msg);
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w?.resolve(msg);
      }
    });
    clients.push(this);
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }
  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** Next message (from now or already received but not yet consumed by wait) matching pred. */
  wait(pred: (m: ServerMessage) => boolean, label = "message"): Promise<ServerMessage> {
    const seen = this.received.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), WAIT_MS);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  async req(method: string, params: Record<string, unknown> = {}): Promise<Extract<ServerMessage, { type: "res" }>> {
    const id = this.nextId++;
    this.send({ type: "req", id, method, params });
    const m = await this.wait((x) => x.type === "res" && x.id === id, `res ${method}`);
    return m as Extract<ServerMessage, { type: "res" }>;
  }

  indexOf(pred: (m: ServerMessage) => boolean): number {
    return this.received.findIndex(pred);
  }
}

async function connect(port: number, host = "127.0.0.1"): Promise<Client> {
  const url = host.includes(":") ? `ws://[${host}]:${port}/` : `ws://${host}:${port}/`;
  const c = new Client(url);
  await c.opened;
  return c;
}

async function authed(port: number): Promise<Client> {
  const c = await connect(port);
  await authenticate(c.ws, TEST_KEY);
  return c;
}

/** Sends auth.hello and waits for the engine's challenge; returns both nonces. */
async function challenged(c: Client, grant?: string): Promise<{ clientNonce: string; serverNonce: string }> {
  const clientNonce = newNonce();
  c.send({ type: "auth.hello", nonce: clientNonce, ...(grant !== undefined ? { grant } : {}) });
  const ch = (await c.wait((m) => m.type === "auth.challenge", "auth.challenge")) as { nonce: string };
  return { clientNonce, serverNonce: ch.nonce };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
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

// ---------------------------------------------------------------------------

describe("http", () => {
  it("GET /health → 200 {ok:true}, everything else 404", async () => {
    const h = await setup();
    const ok = await httpGet(h.port, "/health");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });
    expect((await httpGet(h.port, "/")).status).toBe(404);
    expect((await httpGet(h.port, "/healthz")).status).toBe(404);
    expect((await httpGet(h.port, "/projects")).status).toBe(404);
  });

  it("binds loopback addresses on one shared port", async () => {
    const h = await setup();
    const addrs = h.server.addresses();
    expect(addrs.map((a) => a.host)).toContain("127.0.0.1");
    expect(new Set(addrs.map((a) => a.port)).size).toBe(1);
    expect(h.port).toBeGreaterThan(0);
  });
});

describe("auth: mutual handshake, the key never on the wire", () => {
  it("wrong key → close 4401 after the proof, warns with remote address; no hello.ok", async () => {
    const h = await setup();
    const c = await connect(h.port);
    const err = await authenticate(c.ws, "wrong-key-wrong-key-wrong-key-xx").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandshakeError);
    expect((err as HandshakeError).reason).toBe("unauthorized");
    expect((err as HandshakeError).closeCode).toBe(CLOSE_CODES.UNAUTHORIZED);
    expect(c.received.some((m) => m.type === "hello.ok")).toBe(false);
    const dump = h.logger.dump();
    expect(dump).toContain("127.0.0.1");
    expect(dump).not.toContain(TEST_KEY);
    expect(h.logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("right key → challenge, then hello.ok carrying the ENGINE's proof over both nonces", async () => {
    const h = await setup();
    const c = await connect(h.port);
    const { clientNonce, serverNonce } = await challenged(c);
    c.send({ type: "auth.proof", proof: await authProof(keySecret(TEST_KEY), AUTH_LABELS.client, serverNonce, clientNonce) });
    const ok = (await c.wait((m) => m.type === "hello.ok", "hello.ok")) as unknown as { proof: string };
    // Checked with node:crypto, independently of the shared implementation.
    const expected = createHmac("sha256", TEST_KEY)
      .update(Buffer.concat([Buffer.from("kokpit-engine"), Buffer.from(clientNonce, "base64url"), Buffer.from(serverNonce, "base64url")]))
      .digest("base64url");
    expect(ok.proof).toBe(expected);
  });

  it("an old client (`hello` with the key in clear) is closed 4426 without the key being checked or logged", async () => {
    const h = await setup();
    for (const frame of [{ type: "hello", key: TEST_KEY }, { type: "hello", key: "wrong" }, { type: "hello.screen", grant: "a".repeat(64) }]) {
      const c = await connect(h.port);
      c.send(frame);
      expect((await c.closed).code).toBe(CLOSE_CODES.OUTDATED_CLIENT);
      expect(c.received).toEqual([]);
    }
    expect(h.logger.dump()).toContain("outdated client");
    expect(h.logger.dump()).not.toContain(TEST_KEY);
  });

  it("a proof for another challenge (replayed from an earlier connection) is refused", async () => {
    const h = await setup();
    const first = await connect(h.port);
    const a = await challenged(first);
    const proof = await authProof(keySecret(TEST_KEY), AUTH_LABELS.client, a.serverNonce, a.clientNonce);
    first.send({ type: "auth.proof", proof });
    await first.wait((m) => m.type === "hello.ok", "hello.ok");
    // The same proof on a new connection: the engine's nonce is fresh, so it is worthless.
    const second = await connect(h.port);
    second.send({ type: "auth.hello", nonce: newNonce() });
    await second.wait((m) => m.type === "auth.challenge", "auth.challenge");
    second.send({ type: "auth.proof", proof });
    expect((await second.closed).code).toBe(CLOSE_CODES.UNAUTHORIZED);
  });

  it("a client nonce seen before is refused at once (replayed handshake)", async () => {
    const h = await setup({ authNonceMemory: 16 });
    const nonce = newNonce();
    const a = await connect(h.port);
    a.send({ type: "auth.hello", nonce });
    await a.wait((m) => m.type === "auth.challenge", "auth.challenge");
    const b = await connect(h.port);
    b.send({ type: "auth.hello", nonce });
    expect((await b.closed).code).toBe(CLOSE_CODES.UNAUTHORIZED);
    expect(b.received).toEqual([]);
  });

  it.each([
    ["a request before the handshake", { type: "req", id: 1, method: "projects.list", params: {} }],
    ["a proof before auth.hello", { type: "auth.proof", proof: "p".repeat(43) }],
    ["terminal input before the handshake", { type: "input", terminalId: "t", data: "x" }],
  ])("%s → 4401, nothing answered", async (_n, frame) => {
    const h = await setup();
    const c = await connect(h.port);
    c.send(frame);
    expect((await c.closed).code).toBe(CLOSE_CODES.UNAUTHORIZED);
    expect(c.received).toEqual([]);
  });

  it("a second auth.hello, or a request between challenge and proof → 4401", async () => {
    const h = await setup();
    const c = await connect(h.port);
    await challenged(c);
    c.send({ type: "auth.hello", nonce: newNonce() });
    expect((await c.closed).code).toBe(CLOSE_CODES.UNAUTHORIZED);
    const d = await connect(h.port);
    await challenged(d);
    d.send({ type: "req", id: 1, method: "projects.list", params: {} });
    expect((await d.closed).code).toBe(CLOSE_CODES.UNAUTHORIZED);
    expect(d.received.some((m) => m.type === "res")).toBe(false);
  });

  it("each connection gets its own fresh challenge", async () => {
    const h = await setup();
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) nonces.add((await challenged(await connect(h.port))).serverNonce);
    expect(nonces.size).toBe(5);
  });

  it("an unknown grant id still gets a challenge (existence is not told), then 4401", async () => {
    const h = await setup();
    const c = await connect(h.port);
    const { clientNonce, serverNonce } = await challenged(c, "3b1f0c2e-1d2a-4c5b-9e8f-0123456789ab");
    c.send({ type: "auth.proof", proof: await authProof(createHash("sha256").update("guess").digest(), AUTH_LABELS.client, serverNonce, clientNonce) });
    expect((await c.closed).code).toBe(CLOSE_CODES.UNAUTHORIZED);
  });

  it("first frame not auth.hello → 4401 (even a valid request)", async () => {
    const h = await setup();
    const c = await connect(h.port);
    c.send({ type: "req", id: 1, method: "projects.list", params: {} });
    expect((await c.closed).code).toBe(CLOSE_CODES.UNAUTHORIZED);
    expect(c.received.find((m) => m.type === "res")).toBeUndefined();
  });

  it("garbage first frame → 4401", async () => {
    const h = await setup();
    const c = await connect(h.port);
    c.sendRaw("{not json");
    expect((await c.closed).code).toBe(CLOSE_CODES.UNAUTHORIZED);
  });

  it("silence → 4401 after authTimeoutMs", async () => {
    const h = await setup({ authTimeoutMs: 100 });
    const c = await connect(h.port);
    const started = Date.now();
    expect((await c.closed).code).toBe(CLOSE_CODES.UNAUTHORIZED);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it("right key → hello.ok with version, and the auth timer no longer fires", async () => {
    const h = await setup({ authTimeoutMs: 300 });
    const c = await authed(h.port);
    expect(c.received.map((m) => m.type)).toEqual(["auth.challenge", "hello.ok"]);
    expect(c.received[1]).toMatchObject({ type: "hello.ok", engineVersion: VERSION, protocol: PROTOCOL_VERSION, engineBuild: { version: VERSION } });
    await tick(400);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect(h.logger.dump()).not.toContain(TEST_KEY);
  });
});

describe("after auth: frame validation", () => {
  it.each([
    ["invalid JSON", "{oops"],
    ["array", "[]"],
    ["unknown type", JSON.stringify({ type: "nope" })],
    ["no id", JSON.stringify({ type: "req", method: "cards.list", params: { projectId: 5 } })],
    ["missing params", JSON.stringify({ type: "req", id: 1, method: "cards.list" })],
    ["oversize", JSON.stringify({ type: "req", id: 1, method: "cards.list", params: { projectId: "x".repeat(1024 * 1024) } })],
    ["__proto__", '{"type":"req","id":1,"method":"projects.list","params":{},"__proto__":{}}'],
    ["second hello", JSON.stringify({ type: "auth.hello", nonce: "n".repeat(43) })],
  ])("%s → close 4400", async (_name, raw) => {
    const h = await setup();
    const c = await authed(h.port);
    c.sendRaw(raw);
    expect((await c.closed).code).toBe(CLOSE_CODES.BAD_MESSAGE);
  });

  it("unknown method (a newer app) → res UNKNOWN_METHOD naming it, connection stays usable", async () => {
    const h = await setup();
    const c = await authed(h.port);
    c.sendRaw(JSON.stringify({ type: "req", id: 41, method: "future.method", params: { a: 1 } }));
    const res = await c.wait((f) => f.type === "res" && f.id === 41, "res future.method");
    expect(res).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
    expect((res as unknown as { error: { message: string } }).error.message).toContain("future.method");
    expect((await c.req("projects.list")).ok).toBe(true);
    expect(h.logger.entries.some((e) => e.level === "warn" && e.msg === "unknown method")).toBe(true);
  });

  describe("optional feature modules", () => {
    // `todos.` stands in for a feature's prefix: the gate is generic, whatever the module.
    const todosOff = createFeatureSet({ features: { demo: { enabled: false, methodPrefixes: ["todos."] } } });

    it("a method owned by a feature that is off → UNKNOWN_METHOD (valid params), core methods unaffected", async () => {
      const h = await setup({}, undefined, { features: todosOff });
      const c = await authed(h.port);
      const res = await c.req("todos.list", {});
      expect(res).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
      expect((await c.req("projects.list")).ok).toBe(true);
    });

    it("…and with invalid params it is still UNKNOWN_METHOD, never INVALID (an off module is indistinguishable from an absent one)", async () => {
      const h = await setup({}, undefined, { features: todosOff });
      const c = await authed(h.port);
      const res = await c.req("todos.list", { date: 5 });
      expect(res).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
    });

    it("the same method answers normally when its feature is on", async () => {
      const on = createFeatureSet({ features: { demo: { enabled: true, methodPrefixes: ["todos."] } } });
      const h = await setup({}, undefined, { features: on });
      const c = await authed(h.port);
      const res = await c.req("todos.list", { date: 5 });
      expect(res).toMatchObject({ ok: false, error: { code: "INVALID" } });
    });
  });

  it.each([
    ["wrong param type", "cards.list", { projectId: 5 }, "projectId: geçersiz tür"],
    ["ssh hostname option", "sshHosts.create", { name: "x", hostname: "-oProxyCommand=x" }, "hostname: geçersiz karakter"],
    ["port 0", "sshHosts.create", { name: "x", hostname: "h", port: 0 }, "port: en az 1 olmalı"],
    ["port 65536", "sshHosts.create", { name: "x", hostname: "h", port: 65536 }, "port: en çok 65535 olmalı"],
    ["relative ssh path", "projects.create", { name: "x", location: { kind: "ssh", hostId: "h", path: "rel/x" } }, "location.path: mutlak yol olmalı"],
    ["file:// github url", "projects.create", { name: "x", location: { kind: "github", url: "file:///etc" } }, "location.url: https:// ya da git@ adresi olmalı"],
    ["terminal.open both", "terminal.open", { cardId: "c", projectId: "p", cols: 80, rows: 24 }, "cardId ya da projectId'den tam olarak biri gerekli"],
    ["terminal.open neither", "terminal.open", { cols: 80, rows: 24 }, "cardId ya da projectId'den tam olarak biri gerekli"],
  ])("valid envelope, invalid params (%s) → res INVALID, connection stays open", async (_name, method, params, message) => {
    const h = await setup();
    const c = await authed(h.port);
    expect(await c.req(method, params)).toEqual({ type: "res", id: 1, ok: false, error: { code: "INVALID", message } });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect((await c.req("projects.list")).ok).toBe(true);
    expect(h.sshHosts.calls.filter((x) => x.method === "create")).toEqual([]);
    expect(h.projects.calls.filter((x) => x.method === "create")).toEqual([]);
  });

  it("binary frame → close 4400", async () => {
    const h = await setup();
    const c = await authed(h.port);
    c.sendRaw(Buffer.from([1, 2, 3]));
    expect((await c.closed).code).toBe(CLOSE_CODES.BAD_MESSAGE);
  });
});

describe("methods", () => {
  it("projects.list → ProjectService.list (not config.projects)", async () => {
    const h = await setup({
      projects: [{ id: "cfg", name: "Config", location: { kind: "local", path: "/cfg" } }],
    });
    const c = await authed(h.port);
    const r = await c.req("projects.list");
    expect(r).toEqual({ type: "res", id: r.id, ok: true, result: { projects: [...h.projects.items.values()] } });
  });

  it("cards.list → CardService.list; unknown project → NOT_FOUND", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a", "p1"));
    h.store.addCard(makeCard("b", "p2"));
    const c = await authed(h.port);
    const r = await c.req("cards.list", { projectId: "p1" });
    expect(r).toMatchObject({ ok: true, result: { cards: [makeCard("a", "p1")] } });
    const nf = await c.req("cards.list", { projectId: "ghost" });
    expect(nf).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("cards.create → card + cards.changed broadcast to all authed connections only", async () => {
    const h = await setup();
    const a = await authed(h.port);
    const b = await authed(h.port);
    const unauth = await connect(h.port);
    const r = await a.req("cards.create", { projectId: "p1", name: "Yeni kart" });
    expect(r).toMatchObject({ ok: true, result: { card: { projectId: "p1", name: "Yeni kart" } } });
    expect(h.cards.calls).toContainEqual({ method: "create", args: ["p1", "Yeni kart"] });
    const ev = { type: "event", name: "cards.changed", projectId: "p1" };
    expect(await a.wait((m) => m.type === "event")).toEqual(ev);
    expect(await b.wait((m) => m.type === "event")).toEqual(ev);
    await tick();
    expect(unauth.received).toEqual([]);
  });

  it("cards.create unknown project → NOT_FOUND, no broadcast", async () => {
    const h = await setup();
    const c = await authed(h.port);
    const r = await c.req("cards.create", { projectId: "ghost", name: "x" });
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await tick();
    expect(c.received.some((m) => m.type === "event")).toBe(false);
  });

  it("cards.delete → ok + broadcast; unknown → NOT_FOUND", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a", "p2"));
    const c = await authed(h.port);
    const r = await c.req("cards.delete", { cardId: "a" });
    expect(r).toMatchObject({ ok: true, result: {} });
    expect(await c.wait((m) => m.type === "event")).toEqual({ type: "event", name: "cards.changed", projectId: "p2" });
    const nf = await c.req("cards.delete", { cardId: "a" });
    expect(nf).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("DIRTY_WORKTREE passes through with its message, no broadcast", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    h.cards.nextError = new EngineError("DIRTY_WORKTREE", "uncommitted: src/x.ts, notes.txt");
    const c = await authed(h.port);
    const r = await c.req("cards.delete", { cardId: "a" });
    expect(r).toEqual({
      type: "res",
      id: expect.any(Number),
      ok: false,
      error: { code: "DIRTY_WORKTREE", message: "uncommitted: src/x.ts, notes.txt" },
    });
    await tick();
    expect(c.received.some((m) => m.type === "event")).toBe(false);
  });

  it("i18n: an EngineError's catalog key and params go out next to its message", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    h.cards.nextError = new EngineError("INVALID", "mesaj", { key: "engine.test.key", params: { n: 2, name: "x" } });
    const c = await authed(h.port);
    const r = await c.req("cards.delete", { cardId: "a" });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID", message: "mesaj", key: "engine.test.key", params: { n: 2, name: "x" } } });
  });

  it("non-EngineError throw → INTERNAL with generic message, details logged only", async () => {
    const h = await setup();
    h.cards.nextError = new Error("secret internal path /Users/x/.ssh");
    const c = await authed(h.port);
    const r = await c.req("cards.create", { projectId: "p1", name: "x" });
    expect(r).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(r)).not.toContain(".ssh");
    expect(h.logger.dump()).toContain(".ssh");
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("terminals.list → ptys.list; unknown card → NOT_FOUND", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    const c = await authed(h.port);
    expect(await c.req("terminals.list", { cardId: "a" })).toMatchObject({ ok: true, result: { terminals: [info] } });
    expect(await c.req("terminals.list", { cardId: "zz" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("terminal.open → res, implicit attach (live output), terminals.changed broadcast", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const c = await authed(h.port);
    const other = await authed(h.port);
    const r = await c.req("terminal.open", { cardId: "a", cols: 100, rows: 30, command: "claude" });
    expect(r.ok).toBe(true);
    const terminal = (r as { result: { terminal: { id: string } } }).result.terminal;
    expect(h.ptys.called("open")).toEqual([
      [{ projectId: "p1", cardId: "a" }, expect.objectContaining({ cwd: "/wt/a" }), { cols: 100, rows: 30 }],
    ]);
    const ev = { type: "event", name: "terminals.changed", projectId: "p1", cardId: "a" };
    expect(await c.wait((m) => m.type === "event")).toEqual(ev);
    expect(await other.wait((m) => m.type === "event")).toEqual(ev);
    h.ptys.emit(terminal.id, "hello\r\n");
    expect(await c.wait((m) => m.type === "output")).toEqual({ type: "output", terminalId: terminal.id, data: "hello\r\n" });
    await tick();
    expect(other.received.some((m) => m.type === "output")).toBe(false);
  });

  it("terminal.open unknown card → NOT_FOUND and no pty spawned", async () => {
    const h = await setup();
    const c = await authed(h.port);
    expect(await c.req("terminal.open", { cardId: "zz", cols: 80, rows: 24 })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(h.ptys.called("open")).toEqual([]);
  });

  it("terminal.attach: res, then the replay (one frame when it fits), then live output — in that order", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    h.ptys.emit(info.id, "line1\r\n");
    h.ptys.emit(info.id, "line2\r\n");
    const c = await authed(h.port);
    const r = await c.req("terminal.attach", { terminalId: info.id, cols: 80, rows: 24 });
    expect(r).toMatchObject({ ok: true, result: { terminal: { id: info.id } } });
    h.ptys.emit(info.id, "live");
    await c.wait((m) => m.type === "output" && !m.replay, "live output");
    const outputs = c.received.filter((m) => m.type === "output");
    expect(outputs).toEqual([
      { type: "output", terminalId: info.id, data: "line1\r\nline2\r\n", replay: true, part: { index: 0, total: 1 } },
      { type: "output", terminalId: info.id, data: "live" },
    ]);
    const resIdx = c.indexOf((m) => m.type === "res" && m.id === r.id);
    const replayIdx = c.indexOf((m) => m.type === "output" && m.replay === true);
    expect(resIdx).toBeLessThan(replayIdx);
  });

  // A full history buffer (config.bufferBytes) does not fit one frame: control characters are six characters in JSON.
  it("terminal.attach with a history larger than a frame: ordered replay parts, each inside the limit, then live", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    const line = (n: number): string => `\x1b[38;5;${n % 256}mS${n} çğış€😀\x1b[0m\r\n`;
    const lines: string[] = [];
    for (let n = 0, bytes = 0; bytes < h.config.bufferBytes; n++) {
      lines.push(line(n));
      bytes += Buffer.byteLength(line(n), "utf8");
    }
    const history = lines.join("");
    h.ptys.emit(info.id, history);
    expect(JSON.stringify(history).length).toBeGreaterThan(MAX_MESSAGE_BYTES);

    const c = await authed(h.port);
    const r = await c.req("terminal.attach", { terminalId: info.id, cols: 80, rows: 24 });
    h.ptys.emit(info.id, "live");
    await c.wait((m) => m.type === "output" && !m.replay, "live output");

    expect(Math.max(...c.rawSizes)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const outputs = c.received.filter((m) => m.type === "output");
    const replay = outputs.slice(0, -1);
    expect(replay.length).toBeGreaterThan(1);
    expect(replay.map((m) => m.part)).toEqual(replay.map((_m, index) => ({ index, total: replay.length })));
    expect(replay.every((m) => m.replay === true && m.terminalId === info.id)).toBe(true);
    expect(replay.map((m) => m.data).join("") === history).toBe(true);
    expect(outputs.at(-1)).toEqual({ type: "output", terminalId: info.id, data: "live" });
    // Still after the res, and in one piece: nothing else between the parts.
    const first = c.indexOf((m) => m.type === "output");
    expect(c.indexOf((m) => m.type === "res" && m.id === r.id)).toBeLessThan(first);
    expect(c.received.slice(first, first + replay.length)).toEqual(replay);
  });

  it("a replay larger than a frame for an exited terminal: all parts, then exit", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const history = "\x1b[K".repeat(Math.ceil(MAX_MESSAGE_BYTES / 4));
    h.ptys.seed({ id: "old", projectId: "p1", cardId: "a", title: "shell", status: "exited", exitCode: 0, createdAt: "2026-01-01T00:00:00.000Z" }, history);
    const c = await authed(h.port);
    await c.req("terminal.attach", { terminalId: "old", cols: 80, rows: 24 });
    await c.wait((m) => m.type === "exit");
    // After the handshake (challenge, hello.ok) and the attach's res.
    const kinds = c.received.slice(3).map((m) => m.type);
    expect(kinds.at(-1)).toBe("exit");
    expect(kinds.slice(0, -1).every((k) => k === "output")).toBe(true);
    const outputs = c.received.filter((m) => m.type === "output");
    expect(outputs.length).toBeGreaterThan(1);
    expect(outputs.map((m) => m.data).join("") === history).toBe(true);
    expect(Math.max(...c.rawSizes)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it("a burst of live output larger than a frame is split, in order, without a replay mark", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    const c = await authed(h.port);
    await c.req("terminal.attach", { terminalId: info.id, cols: 80, rows: 24 });
    const burst = "\x1b[1m😀".repeat(Math.ceil(OUTPUT_LIMITS.maxDataJsonChars / 8)) + "SON";
    h.ptys.emit(info.id, burst);
    await c.wait((m) => m.type === "output" && m.data.endsWith("SON"), "end of the burst");
    const outputs = c.received.filter((m) => m.type === "output");
    expect(outputs.length).toBeGreaterThan(1);
    expect(outputs.every((m) => m.replay === undefined && m.part === undefined)).toBe(true);
    expect(outputs.map((m) => m.data).join("") === burst).toBe(true);
    expect(Math.max(...c.rawSizes)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it("a result that does not fit a frame is answered with an error, never sent oversized nor left hanging", async () => {
    const h = await setup();
    const big = makeCard("big");
    h.store.addCard({ ...big, name: "x".repeat(MAX_MESSAGE_BYTES) });
    const c = await authed(h.port);
    const r = await c.req("cards.list", { projectId: "p1" });
    expect(r).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(Math.max(...c.rawSizes)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const logged = h.logger.entries.filter((e) => e.level === "error" && e.msg === "frame too large, not sent");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.extra).toMatchObject({ type: "res", method: "cards.list", limit: MAX_MESSAGE_BYTES });
    // The connection is still good.
    expect(await c.req("projects.list")).toMatchObject({ ok: true });
  });

  it("terminal.attach with empty history sends no replay frame", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    const c = await authed(h.port);
    await c.req("terminal.attach", { terminalId: info.id, cols: 80, rows: 24 });
    await tick();
    expect(c.received.some((m) => m.type === "output")).toBe(false);
  });

  it("terminal.attach applies the client's size", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    const c = await authed(h.port);
    await c.req("terminal.attach", { terminalId: info.id, cols: 120, rows: 40 });
    expect(h.ptys.called("resize")).toEqual([[info.id, 120, 40]]);
  });

  it("terminal.attach unknown → NOT_FOUND", async () => {
    const h = await setup();
    const c = await authed(h.port);
    expect(await c.req("terminal.attach", { terminalId: "nope", cols: 80, rows: 24 })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("re-attach on the same connection drops the old subscription (no duplicate output)", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    const c = await authed(h.port);
    await c.req("terminal.attach", { terminalId: info.id, cols: 80, rows: 24 });
    await c.req("terminal.attach", { terminalId: info.id, cols: 80, rows: 24 });
    // one per-connection listener + at most one server-level exit watcher
    expect(h.ptys.listenerCount(info.id)).toBeLessThanOrEqual(2);
    h.ptys.emit(info.id, "once");
    await c.wait((m) => m.type === "output" && m.data === "once");
    await tick();
    expect(c.received.filter((m) => m.type === "output" && m.data === "once")).toHaveLength(1);
  });

  it("attach to an already-exited terminal: replay then exit", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    h.ptys.seed(
      { id: "old", projectId: "p1", cardId: "a", title: "shell", status: "exited", exitCode: 3, createdAt: "2026-01-01T00:00:00.000Z" },
      "bye\r\n",
    );
    const c = await authed(h.port);
    await c.req("terminal.attach", { terminalId: "old", cols: 80, rows: 24 });
    await c.wait((m) => m.type === "exit");
    const kinds = c.received.slice(2).map((m) => m.type);
    expect(kinds).toEqual(["res", "output", "exit"]);
    expect(c.received.at(-1)).toEqual({ type: "exit", terminalId: "old", exitCode: 3 });
  });

  it("terminal.detach stops output; unknown → NOT_FOUND", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    const c = await authed(h.port);
    await c.req("terminal.attach", { terminalId: info.id, cols: 80, rows: 24 });
    expect(await c.req("terminal.detach", { terminalId: info.id })).toMatchObject({ ok: true, result: {} });
    h.ptys.emit(info.id, "after-detach");
    await tick();
    expect(c.received.some((m) => m.type === "output")).toBe(false);
    expect(await c.req("terminal.detach", { terminalId: "nope" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("terminal.close → ptys.close + terminals.changed; unknown → NOT_FOUND", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    const c = await authed(h.port);
    await c.req("terminal.attach", { terminalId: info.id, cols: 80, rows: 24 });
    expect(await c.req("terminal.close", { terminalId: info.id })).toMatchObject({ ok: true, result: {} });
    expect(h.ptys.called("close")).toEqual([[info.id]]);
    expect(await c.wait((m) => m.type === "event")).toEqual({ type: "event", name: "terminals.changed", projectId: "p1", cardId: "a" });
    expect(await c.req("terminal.close", { terminalId: info.id })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });
});

type Res = Extract<ServerMessage, { type: "res" }>;
const resultOf = <T>(r: Res) => (r as unknown as { result: T }).result;
const evCount = (c: Client, name: string) => c.received.filter((m) => m.type === "event" && m.name === name).length;

describe("registry methods (projects / sshHosts / sshKeys / tools)", () => {
  const cases: {
    method: string;
    params: Record<string, unknown>;
    event: "projects.changed" | "sshHosts.changed" | "tools.changed";
    svc: "projects" | "sshHosts" | "tools";
    call: string;
    result: (h: Harness) => unknown;
  }[] = [
    {
      method: "projects.create",
      params: { name: "Yeni", location: { kind: "local", path: "/repos/new" }, defaultToolId: "codex" },
      event: "projects.changed",
      svc: "projects",
      call: "create",
      result: (h) => ({ project: h.projects.items.get("np1") }),
    },
    {
      method: "projects.update",
      params: { projectId: "p1", name: "Ad", defaultToolId: null },
      event: "projects.changed",
      svc: "projects",
      call: "update",
      result: (h) => ({ project: h.projects.items.get("p1") }),
    },
    {
      method: "projects.delete",
      params: { projectId: "p2" },
      event: "projects.changed",
      svc: "projects",
      call: "delete",
      result: () => ({}),
    },
    {
      method: "sshHosts.create",
      params: { name: "Yeni", hostname: "1.2.3.4", user: "root", port: 22, identityFile: "id_ed25519" },
      event: "sshHosts.changed",
      svc: "sshHosts",
      call: "create",
      result: (h) => ({ host: h.sshHosts.items.get("nh1") }),
    },
    {
      method: "sshHosts.update",
      params: { hostId: "h1", name: "Kutu 2", port: null },
      event: "sshHosts.changed",
      svc: "sshHosts",
      call: "update",
      result: (h) => ({ host: h.sshHosts.items.get("h1") }),
    },
    {
      method: "sshHosts.delete",
      params: { hostId: "h1" },
      event: "sshHosts.changed",
      svc: "sshHosts",
      call: "delete",
      result: () => ({}),
    },
    {
      method: "tools.create",
      params: { name: "Gemini", command: "command gemini", installCommand: "npm i -g gemini" },
      event: "tools.changed",
      svc: "tools",
      call: "create",
      result: (h) => ({ tool: h.tools.items.get("nt1") }),
    },
    {
      method: "tools.update",
      params: { toolId: "codex", name: "Codex CLI", checkCommand: null },
      event: "tools.changed",
      svc: "tools",
      call: "update",
      result: (h) => ({ tool: h.tools.items.get("codex") }),
    },
    {
      method: "tools.delete",
      params: { toolId: "codex" },
      event: "tools.changed",
      svc: "tools",
      call: "delete",
      result: () => ({}),
    },
  ];

  it.each(cases)("$method → service, result, ONE $event to every authed connection", async (tc) => {
    const h = await setup();
    const a = await authed(h.port);
    const b = await authed(h.port);
    const unauth = await connect(h.port);
    const r = await a.req(tc.method, tc.params);
    expect(r).toEqual({ type: "res", id: r.id, ok: true, result: tc.result(h) });
    const svc = h[tc.svc];
    const arg = tc.call === "delete" ? Object.values(tc.params)[0] : tc.params;
    expect(svc.called(tc.call)).toEqual([[arg]]);
    const ev = { type: "event", name: tc.event };
    expect(await a.wait((m) => m.type === "event")).toEqual(ev);
    expect(await b.wait((m) => m.type === "event")).toEqual(ev);
    await tick();
    expect([evCount(a, tc.event), evCount(b, tc.event)]).toEqual([1, 1]);
    expect(a.received.filter((m) => m.type === "event")).toHaveLength(1);
    expect(unauth.received).toEqual([]);
  });

  it.each(cases)("$method: service EngineError passes through, no broadcast", async (tc) => {
    const h = await setup();
    h[tc.svc].nextError = new EngineError("INVALID", "Türkçe hata mesajı");
    const c = await authed(h.port);
    const r = await c.req(tc.method, tc.params);
    expect(r).toEqual({ type: "res", id: r.id, ok: false, error: { code: "INVALID", message: "Türkçe hata mesajı" } });
    await tick();
    expect(c.received.some((m) => m.type === "event")).toBe(false);
  });

  it("NOT_FOUND from the service passes through", async () => {
    const h = await setup();
    const c = await authed(h.port);
    for (const [m, p] of [
      ["projects.update", { projectId: "ghost", name: "x" }],
      ["projects.delete", { projectId: "ghost" }],
      ["sshHosts.update", { hostId: "ghost", name: "x" }],
      ["sshHosts.delete", { hostId: "ghost" }],
      ["tools.update", { toolId: "ghost", name: "x" }],
      ["tools.delete", { toolId: "ghost" }],
    ] as const) {
      expect(await c.req(m, p)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
    await tick();
    expect(c.received.some((m) => m.type === "event")).toBe(false);
  });

  it("projects.create github: async service result is returned", async () => {
    const h = await setup();
    const c = await authed(h.port);
    const r = await c.req("projects.create", { name: "Repo", location: { kind: "github", url: "https://github.com/a/b" } });
    expect(resultOf<{ project: unknown }>(r).project).toMatchObject({
      location: { kind: "github", url: "https://github.com/a/b", path: "/data/repos/np1" },
    });
  });

  it("projects.delete drops server-side subscriptions of the project's terminals", async () => {
    const h = await setup();
    const t = h.ptys.add({ projectId: "p2" });
    const c = await authed(h.port);
    await c.req("terminal.attach", { terminalId: t.id, cols: 80, rows: 24 });
    expect(h.ptys.listenerCount(t.id)).toBeGreaterThan(0);
    const listeners = h.ptys.terminals.get(t.id)?.listeners;
    h.projects.onBeforeDelete = (id) => h.ptys.closeAllForProject(id);
    expect(await c.req("projects.delete", { projectId: "p2" })).toMatchObject({ ok: true });
    expect(h.ptys.called("closeAllForProject")).toEqual([["p2"]]);
    expect(listeners?.size).toBe(0);
  });

  it("projects.delete builtin → INVALID from the service", async () => {
    const h = await setup();
    const c = await authed(h.port);
    expect(await c.req("projects.delete", { projectId: BUILTIN_PROJECT_ID })).toMatchObject({
      ok: false,
      error: { code: "INVALID" },
    });
  });

  it("sshHosts.list / sshKeys.list / tools.list / tools.check → service results, no events", async () => {
    const h = await setup();
    const c = await authed(h.port);
    expect(resultOf(await c.req("sshHosts.list"))).toEqual({ hosts: [...h.sshHosts.items.values()] });
    expect(resultOf(await c.req("sshKeys.list"))).toEqual({ keys: ["id_ed25519", "work_rsa"] });
    expect(resultOf(await c.req("tools.list"))).toEqual({ tools: [...h.tools.items.values()] });
    expect(resultOf(await c.req("tools.check"))).toEqual({
      statuses: [
        { toolId: "claude", installed: true },
        { toolId: "codex", installed: null },
      ],
    });
    await tick();
    expect(c.received.some((m) => m.type === "event")).toBe(false);
  });

  it("cards.* use ProjectService for the project check", async () => {
    const h = await setup();
    const c = await authed(h.port);
    h.projects.items.delete("p1");
    expect(await c.req("cards.list", { projectId: "p1" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await c.req("cards.create", { projectId: "p1", name: "x" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(h.cards.called("create")).toEqual([]);
    expect((await c.req("cards.list", { projectId: "p2" })).ok).toBe(true);
  });
});

describe("terminal.open v2", () => {
  async function open(h: Harness, params: Record<string, unknown>) {
    const c = await authed(h.port);
    const r = await c.req("terminal.open", { cols: 90, rows: 20, ...params });
    return { c, r };
  }

  it("project terminal: project-level target, resolveLaunch gets the project, default tool when nothing given", async () => {
    const h = await setup();
    const other = await authed(h.port);
    const { c, r } = await open(h, { projectId: "p1" });
    expect(r.ok).toBe(true);
    expect(h.launch.inputs).toEqual([{ project: h.projects.items.get("p1"), tool: h.tools.items.get("claude") }]);
    expect(h.ptys.called("open")).toEqual([
      [{ projectId: "p1", toolId: "claude" }, expect.objectContaining({ initialInput: "claude\r" }), { cols: 90, rows: 20 }],
    ]);
    const terminal = resultOf<{ terminal: { id: string; projectId: string; cardId?: string } }>(r).terminal;
    expect(terminal).toMatchObject({ projectId: "p1" });
    expect(terminal.cardId).toBeUndefined();
    const ev = { type: "event", name: "terminals.changed", projectId: "p1" };
    expect(await c.wait((m) => m.type === "event")).toEqual(ev);
    expect(await other.wait((m) => m.type === "event")).toEqual(ev);
    h.ptys.emit(terminal.id, "x");
    expect(await c.wait((m) => m.type === "output")).toEqual({ type: "output", terminalId: terminal.id, data: "x" });
  });

  it("card terminal: project comes from the card, card passed to resolveLaunch", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a", "p2"));
    const { r } = await open(h, { cardId: "a", toolId: "codex" });
    expect(r.ok).toBe(true);
    expect(h.launch.inputs).toEqual([
      { project: h.projects.items.get("p2"), card: makeCard("a", "p2"), tool: h.tools.items.get("codex") },
    ]);
    expect(h.ptys.called("open")[0]?.[0]).toEqual({ projectId: "p2", cardId: "a", toolId: "codex" });
  });

  it("no default tool and nothing given → plain shell (no tool, no command)", async () => {
    const h = await setup();
    await open(h, { projectId: "p2" });
    expect(h.launch.inputs).toEqual([{ project: h.projects.items.get("p2") }]);
    expect(h.ptys.called("open")[0]?.[0]).toEqual({ projectId: "p2" });
  });

  it("explicit command wins over toolId and the default tool", async () => {
    const h = await setup();
    await open(h, { projectId: "p1", toolId: "codex", command: "htop" });
    expect(h.launch.inputs).toEqual([{ project: h.projects.items.get("p1"), command: "htop" }]);
    expect(h.ptys.called("open")[0]?.[0]).toEqual({ projectId: "p1" });
    expect(h.ptys.called("open")[0]?.[1]).toMatchObject({ initialInput: "htop\r" });
  });

  it("ssh project: host resolved via SshHostService", async () => {
    const h = await setup();
    await open(h, { projectId: "ps" });
    expect(h.launch.inputs).toEqual([{ project: h.projects.items.get("ps"), host: h.sshHosts.items.get("oracle") }]);
  });

  it.each([
    ["unknown project", { projectId: "ghost" }],
    ["unknown card", { cardId: "ghost" }],
    ["unknown toolId", { projectId: "p1", toolId: "ghost" }],
  ])("%s → NOT_FOUND, nothing spawned, no broadcast", async (_n, params) => {
    const h = await setup();
    const { c, r } = await open(h, params);
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(h.ptys.called("open")).toEqual([]);
    await tick();
    expect(c.received.some((m) => m.type === "event")).toBe(false);
  });

  it("card whose project vanished → NOT_FOUND", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a", "gone"));
    const { r } = await open(h, { cardId: "a" });
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("ssh project whose host vanished → NOT_FOUND", async () => {
    const h = await setup();
    h.sshHosts.items.delete("oracle");
    const { r } = await open(h, { projectId: "ps" });
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(h.ptys.called("open")).toEqual([]);
  });

  it("dangling defaultToolId → opens a plain shell and warns", async () => {
    const h = await setup();
    h.tools.items.delete("claude");
    const { r } = await open(h, { projectId: "p1" });
    expect(r.ok).toBe(true);
    expect(h.launch.inputs).toEqual([{ project: h.projects.items.get("p1") }]);
    expect(h.logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("resolveLaunch EngineError passes through", async () => {
    const h = await setup();
    h.launch.nextError = new EngineError("INVALID", "geçersiz konum");
    const { r } = await open(h, { projectId: "p2" });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID", message: "geçersiz konum" } });
    expect(h.ptys.called("open")).toEqual([]);
  });

  it("project terminal exit → terminals.changed {projectId} exactly once per connection", async () => {
    const h = await setup();
    const watcher = await authed(h.port);
    const { c, r } = await open(h, { projectId: "p2" });
    const tid = resultOf<{ terminal: { id: string } }>(r).terminal.id;
    await tick();
    const base = [evCount(c, "terminals.changed"), evCount(watcher, "terminals.changed")];
    h.ptys.exit(tid, 1);
    await c.wait((m) => m.type === "exit");
    await tick(80);
    expect([evCount(c, "terminals.changed"), evCount(watcher, "terminals.changed")]).toEqual(base.map((n) => n + 1));
    expect(watcher.received.at(-1)).toEqual({ type: "event", name: "terminals.changed", projectId: "p2" });
  });

  it("terminal.close of a project terminal broadcasts {projectId} without cardId", async () => {
    const h = await setup();
    const t = h.ptys.add({ projectId: "p2" });
    const c = await authed(h.port);
    expect(await c.req("terminal.close", { terminalId: t.id })).toMatchObject({ ok: true });
    expect(await c.wait((m) => m.type === "event")).toEqual({ type: "event", name: "terminals.changed", projectId: "p2" });
  });
});

describe("settings + global default tool", () => {
  async function open(h: Harness, params: Record<string, unknown>) {
    const c = await authed(h.port);
    const r = await c.req("terminal.open", { cols: 90, rows: 20, ...params });
    return { c, r };
  }

  it("settings.get → service result, no event", async () => {
    const h = await setup();
    h.settings.value = { defaultToolId: "codex" };
    const c = await authed(h.port);
    expect(resultOf(await c.req("settings.get"))).toEqual({ settings: { defaultToolId: "codex" } });
    await tick();
    expect(c.received.some((m) => m.type === "event")).toBe(false);
  });

  it("settings.update → result + settings.changed to every authed connection", async () => {
    const h = await setup();
    const a = await authed(h.port);
    const b = await authed(h.port);
    expect(resultOf(await a.req("settings.update", { defaultToolId: "codex" }))).toEqual({
      settings: { defaultToolId: "codex" },
    });
    const ev = { type: "event", name: "settings.changed" };
    expect(await a.wait((m) => m.type === "event")).toEqual(ev);
    expect(await b.wait((m) => m.type === "event")).toEqual(ev);
    expect(resultOf(await a.req("settings.update", { defaultToolId: null }))).toEqual({ settings: {} });
    expect(h.settings.called("update")).toEqual([[{ defaultToolId: "codex" }], [{ defaultToolId: null }]]);
  });

  it("settings.update unknown tool → NOT_FOUND, no broadcast", async () => {
    const h = await setup();
    const c = await authed(h.port);
    expect(await c.req("settings.update", { defaultToolId: "ghost" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    await tick();
    expect(c.received.some((m) => m.type === "event")).toBe(false);
  });

  it("project without a default → the global default tool", async () => {
    const h = await setup();
    h.settings.value = { defaultToolId: "codex" };
    await open(h, { projectId: "p2" });
    expect(h.launch.inputs).toEqual([{ project: h.projects.items.get("p2"), tool: h.tools.items.get("codex") }]);
    expect(h.ptys.called("open")[0]?.[0]).toEqual({ projectId: "p2", toolId: "codex" });
  });

  it("the project's default wins over the global default", async () => {
    const h = await setup();
    h.settings.value = { defaultToolId: "codex" };
    await open(h, { projectId: "p1" });
    expect(h.launch.inputs[0]?.tool).toEqual(h.tools.items.get("claude"));
  });

  it("explicit toolId and command win over the global default", async () => {
    const h = await setup();
    h.settings.value = { defaultToolId: "codex" };
    await open(h, { projectId: "p2", toolId: "claude" });
    await open(h, { projectId: "p2", command: "htop" });
    expect(h.launch.inputs).toEqual([
      { project: h.projects.items.get("p2"), tool: h.tools.items.get("claude") },
      { project: h.projects.items.get("p2"), command: "htop" },
    ]);
  });

  it("dangling project default falls through to the global default", async () => {
    const h = await setup();
    h.tools.items.delete("claude");
    h.settings.value = { defaultToolId: "codex" };
    await open(h, { projectId: "p1" });
    expect(h.launch.inputs[0]?.tool).toEqual(h.tools.items.get("codex"));
  });

  it("no global default, or one whose tool is gone → plain shell", async () => {
    const h = await setup();
    await open(h, { projectId: "p2" });
    h.settings.value = { defaultToolId: "ghost" };
    await open(h, { projectId: "p2" });
    expect(h.launch.inputs).toEqual([{ project: h.projects.items.get("p2") }, { project: h.projects.items.get("p2") }]);
  });

  it("toolId: null → plain shell even with project and global defaults; command still wins", async () => {
    const h = await setup();
    h.settings.value = { defaultToolId: "codex" };
    await open(h, { projectId: "p1", toolId: null });
    await open(h, { projectId: "p1", toolId: null, command: "htop" });
    expect(h.launch.inputs).toEqual([
      { project: h.projects.items.get("p1") },
      { project: h.projects.items.get("p1"), command: "htop" },
    ]);
    expect(h.ptys.called("open")[0]?.[0]).toEqual({ projectId: "p1" });
  });

  it("card terminals use the global default too", async () => {
    const h = await setup();
    h.settings.value = { defaultToolId: "codex" };
    h.store.addCard(makeCard("a", "p2"));
    await open(h, { cardId: "a" });
    expect(h.ptys.called("open")[0]?.[0]).toEqual({ projectId: "p2", cardId: "a", toolId: "codex" });
  });
});

describe("terminals.list v2", () => {
  it("projectId → only that project's terminals WITHOUT a card; cardId → that card's", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a", "p1"));
    const proj = h.ptys.add({ projectId: "p1" });
    const card = h.ptys.add({ projectId: "p1", cardId: "a" });
    h.ptys.add({ projectId: "p2" });
    const c = await authed(h.port);
    expect(resultOf(await c.req("terminals.list", { projectId: "p1" }))).toEqual({ terminals: [proj] });
    expect(resultOf(await c.req("terminals.list", { cardId: "a" }))).toEqual({ terminals: [card] });
  });

  it("unknown project / card → NOT_FOUND; both or neither → INVALID, connection stays open", async () => {
    const h = await setup();
    const c = await authed(h.port);
    expect(await c.req("terminals.list", { projectId: "ghost" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await c.req("terminals.list", { cardId: "ghost" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await c.req("terminals.list", { projectId: "p1", cardId: "a" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("tools.install", () => {
  it("opens a project-level terminal on the built-in project running installCommand; attach + broadcast", async () => {
    const h = await setup();
    const other = await authed(h.port);
    const c = await authed(h.port);
    const r = await c.req("tools.install", { toolId: "claude", cols: 100, rows: 30 });
    expect(r.ok).toBe(true);
    expect(h.launch.inputs).toEqual([{ project: h.projects.items.get(BUILTIN_PROJECT_ID), command: "npm i -g claude" }]);
    expect(h.ptys.called("open")).toEqual([
      [{ projectId: BUILTIN_PROJECT_ID }, expect.objectContaining({ initialInput: "npm i -g claude\r" }), { cols: 100, rows: 30 }],
    ]);
    const terminal = resultOf<{ terminal: { id: string; projectId: string } }>(r).terminal;
    expect(terminal.projectId).toBe(BUILTIN_PROJECT_ID);
    const ev = { type: "event", name: "terminals.changed", projectId: BUILTIN_PROJECT_ID };
    expect(await c.wait((m) => m.type === "event")).toEqual(ev);
    expect(await other.wait((m) => m.type === "event")).toEqual(ev);
    h.ptys.emit(terminal.id, "installing");
    expect(await c.wait((m) => m.type === "output")).toMatchObject({ data: "installing" });
    await tick();
    expect(other.received.some((m) => m.type === "output")).toBe(false);
  });

  it("tool without installCommand → INVALID; unknown tool → NOT_FOUND; nothing spawned", async () => {
    const h = await setup();
    const c = await authed(h.port);
    expect(await c.req("tools.install", { toolId: "codex", cols: 80, rows: 24 })).toMatchObject({
      ok: false,
      error: { code: "INVALID" },
    });
    expect(await c.req("tools.install", { toolId: "ghost", cols: 80, rows: 24 })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(h.ptys.called("open")).toEqual([]);
  });
});

describe("streaming", () => {
  it("output only to attached connections; two cards never see each other's output", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    h.store.addCard(makeCard("b"));
    const ca = await authed(h.port);
    const cb = await authed(h.port);
    const bystander = await authed(h.port);
    const ra = await ca.req("terminal.open", { cardId: "a", cols: 80, rows: 24 });
    const rb = await cb.req("terminal.open", { cardId: "b", cols: 80, rows: 24 });
    const ta = (ra as { result: { terminal: { id: string } } }).result.terminal.id;
    const tb = (rb as { result: { terminal: { id: string } } }).result.terminal.id;
    h.ptys.emit(ta, "AAA");
    h.ptys.emit(tb, "BBB");
    await ca.wait((m) => m.type === "output");
    await cb.wait((m) => m.type === "output");
    await tick();
    const outs = (c: Client) => c.received.filter((m) => m.type === "output");
    expect(outs(ca)).toEqual([{ type: "output", terminalId: ta, data: "AAA" }]);
    expect(outs(cb)).toEqual([{ type: "output", terminalId: tb, data: "BBB" }]);
    expect(outs(bystander)).toEqual([]);
  });

  it("input / resize go to the pty; errors are logged and the connection stays", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const info = h.ptys.add({ projectId: "p1", cardId: "a" });
    const c = await authed(h.port);
    c.send({ type: "input", terminalId: info.id, data: "ls\r" });
    c.send({ type: "resize", terminalId: info.id, cols: 132, rows: 50 });
    await tick();
    expect(h.ptys.called("write")).toEqual([[info.id, "ls\r"]]);
    expect(h.ptys.called("resize")).toEqual([[info.id, 132, 50]]);
    c.send({ type: "input", terminalId: "ghost", data: "x" });
    h.ptys.ioError = new Error("EIO");
    c.send({ type: "resize", terminalId: info.id, cols: 10, rows: 10 });
    await tick();
    expect(h.logger.entries.filter((e) => e.level !== "info").length).toBeGreaterThanOrEqual(2);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect((await c.req("projects.list")).ok).toBe(true);
  });

  it("performans: keystrokes into a terminal that is gone are logged once, without a stack, not once per key", async () => {
    // Live log: 1684 of 2582 lines (1.8 of 2 MB) were "input failed … terminal has exited" with a full stack.
    const h = await setup();
    const c = await authed(h.port);
    for (let i = 0; i < 50; i++) c.send({ type: "input", terminalId: "ghost", data: "x" });
    await c.req("projects.list");
    const failed = () => h.logger.entries.filter((e) => e.msg === "input failed");
    expect(failed()).toHaveLength(1);
    expect(failed()[0]!.extra).toEqual({ terminalId: "ghost", code: "NOT_FOUND", message: "no terminal" });
    // Another terminal is reported again; returning to the first reports how many were left out meanwhile.
    c.send({ type: "input", terminalId: "ghost2", data: "x" });
    c.send({ type: "input", terminalId: "ghost", data: "x" });
    await c.req("projects.list");
    expect(failed().map((e) => e.extra)).toEqual([
      { terminalId: "ghost", code: "NOT_FOUND", message: "no terminal" },
      { terminalId: "ghost2", code: "NOT_FOUND", message: "no terminal", repeatsBefore: 49 },
      { terminalId: "ghost", code: "NOT_FOUND", message: "no terminal" },
    ]);
  });

  it("client disconnect unsubscribes but never closes terminals", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const c = await authed(h.port);
    const r = await c.req("terminal.open", { cardId: "a", cols: 80, rows: 24 });
    const tid = (r as { result: { terminal: { id: string } } }).result.terminal.id;
    const before = h.ptys.listenerCount(tid);
    c.ws.close();
    await c.closed;
    await tick(50);
    expect(h.ptys.called("close")).toEqual([]);
    expect(h.ptys.called("closeAllForCard")).toEqual([]);
    expect(h.ptys.listenerCount(tid)).toBe(before - 1);
    h.ptys.emit(tid, "still alive");
  });

  it("terminal exit → exit frame to attached connections + exactly ONE terminals.changed per connection", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a"));
    const c1 = await authed(h.port);
    const c2 = await authed(h.port);
    const watcher = await authed(h.port);
    const r = await c1.req("terminal.open", { cardId: "a", cols: 80, rows: 24 });
    const tid = (r as { result: { terminal: { id: string } } }).result.terminal.id;
    await c2.req("terminal.attach", { terminalId: tid, cols: 80, rows: 24 });
    await tick();
    const changed = (c: Client) =>
      c.received.filter((m) => m.type === "event" && m.name === "terminals.changed").length;
    const base = [changed(c1), changed(c2), changed(watcher)];
    h.ptys.exit(tid, 0);
    expect(await c1.wait((m) => m.type === "exit")).toEqual({ type: "exit", terminalId: tid, exitCode: 0 });
    expect(await c2.wait((m) => m.type === "exit")).toEqual({ type: "exit", terminalId: tid, exitCode: 0 });
    await tick(80);
    expect([changed(c1), changed(c2), changed(watcher)]).toEqual(base.map((n) => n + 1));
    expect(watcher.received.some((m) => m.type === "exit")).toBe(false);
  });
});

describe("robustness", () => {
  it("random garbage frames never crash the server; a fresh client still works", async () => {
    const h = await setup();
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const samples = [
      "",
      "null",
      "1",
      '"str"',
      "{}",
      '{"type":"req"}',
      '{"type":"req","id":-1,"method":"projects.list","params":{}}',
      '{"type":"req","id":1.5,"method":"projects.list","params":{}}',
      '{"type":"input","terminalId":"","data":"x"}',
      '{"type":"resize","terminalId":"t","cols":0,"rows":99999}',
      '{"constructor":{"prototype":{"x":1}}}',
      "\u0000\u0001\u0002",
      "x".repeat(10_000),
    ];
    for (let round = 0; round < 30; round++) {
      const c = await connect(h.port);
      const preAuth = rnd() < 0.3;
      if (!preAuth) await authenticate(c.ws, TEST_KEY);
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n && c.ws.readyState === WebSocket.OPEN; i++) {
        const pick = rnd();
        if (pick < 0.5) c.sendRaw(samples[Math.floor(rnd() * samples.length)] ?? "");
        else if (pick < 0.8) {
          const len = Math.floor(rnd() * 200);
          c.sendRaw(Buffer.from(Array.from({ length: len }, () => Math.floor(rnd() * 256))));
        } else {
          c.sendRaw(String.fromCharCode(...Array.from({ length: 50 }, () => Math.floor(rnd() * 0xffff))));
        }
      }
      const { code } = await c.closed;
      expect([CLOSE_CODES.UNAUTHORIZED, CLOSE_CODES.BAD_MESSAGE, CLOSE_CODES.OUTDATED_CLIENT, 1006, 1007, 1002]).toContain(code);
    }
    const fresh = await authed(h.port);
    expect((await fresh.req("projects.list")).ok).toBe(true);
    expect((await httpGet(h.port, "/health")).status).toBe(200);
  });

  it("random valid/invalid v2 method frames never crash the server or yield INTERNAL", async () => {
    const h = await setup();
    h.store.addCard(makeCard("a", "p1"));
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const ids = ["p1", "p2", "ps", BUILTIN_PROJECT_ID, "ghost", "", "a", "claude", "codex", "h1", "oracle", "x".repeat(300)];
    const junk = [null, 5, -1, 0, 1.5, 70000, "", "-oProxyCommand=x", "a b", "/abs", "rel", true, [], {}, "x".repeat(2000)];
    const any = () => (rnd() < 0.6 ? pick(ids) : pick(junk));
    const gen: Record<string, () => Record<string, unknown>> = {
      "projects.list": () => (rnd() < 0.8 ? {} : { x: 1 }),
      "projects.create": () => ({
        name: pick(["P", "", any()]),
        location: pick([
          { kind: "local", path: "/repos/x" },
          { kind: "github", url: pick(["https://github.com/a/b", "git@github.com:a/b.git", "file:///etc", "-u"]) },
          { kind: "ssh", hostId: any() },
          { kind: "nope" },
          any(),
        ]),
        ...(rnd() < 0.5 ? { defaultToolId: any() } : {}),
      }),
      "projects.update": () => ({ projectId: any(), ...(rnd() < 0.5 ? { name: any() } : { defaultToolId: pick([null, any()]) }) }),
      "projects.delete": () => ({ projectId: any() }),
      "sshHosts.list": () => ({}),
      "sshHosts.create": () => ({ name: any(), hostname: any(), ...(rnd() < 0.5 ? { port: any() } : {}) }),
      "sshHosts.update": () => ({ hostId: any(), identityFile: pick([null, "id_ed25519", "../id", any()]) }),
      "sshHosts.delete": () => ({ hostId: any() }),
      "sshKeys.list": () => ({}),
      "tools.list": () => ({}),
      "tools.create": () => ({ name: any(), command: any() }),
      "tools.update": () => ({ toolId: any(), installCommand: pick([null, "npm i -g x", any()]) }),
      "tools.delete": () => ({ toolId: any() }),
      "tools.check": () => ({}),
      "settings.get": () => (rnd() < 0.8 ? {} : { x: any() }),
      "settings.update": () => (rnd() < 0.8 ? { defaultToolId: pick([null, any()]) } : {}),
      "tools.install": () => ({ toolId: any(), cols: pick([80, any()]), rows: pick([24, any()]) }),
      "terminals.list": () => (rnd() < 0.5 ? { projectId: any() } : rnd() < 0.5 ? { cardId: any() } : {}),
      "terminal.open": () => ({
        ...(rnd() < 0.5 ? { projectId: any() } : { cardId: any() }),
        ...(rnd() < 0.3 ? { projectId: any(), cardId: any() } : {}),
        cols: pick([80, any()]),
        rows: pick([24, any()]),
        ...(rnd() < 0.4 ? { toolId: pick([null, any()]) } : {}),
        ...(rnd() < 0.3 ? { command: any() } : {}),
      }),
    };
    const methods = Object.keys(gen);
    let c = await authed(h.port);
    let id = 1;
    let answered = 0;
    for (let i = 0; i < 300; i++) {
      if (c.ws.readyState !== WebSocket.OPEN) c = await authed(h.port);
      const method = pick(methods);
      const frame = { type: "req", id: id++, method, params: gen[method]?.() };
      const before = c.received.length;
      c.send(frame);
      const outcome = await Promise.race([
        c.wait((m) => m.type === "res" && m.id === frame.id).then(() => "res"),
        c.closed.then(() => "closed"),
      ]);
      if (outcome === "res") answered++;
      const internal = c.received.slice(before).find((m) => m.type === "res" && !m.ok && m.error.code === "INTERNAL");
      expect(internal, `INTERNAL for ${JSON.stringify(frame)}`).toBeUndefined();
    }
    expect(answered).toBeGreaterThan(30);
    expect(h.logger.entries.some((e) => e.level === "error")).toBe(false);
    const fresh = await authed(h.port);
    expect((await fresh.req("projects.list")).ok).toBe(true);
  });

  it("oversized frame closes only that connection", async () => {
    const h = await setup();
    const c = await authed(h.port);
    c.sendRaw("x".repeat(5 * 1024 * 1024));
    const { code } = await c.closed;
    expect(code).not.toBe(1000);
    const fresh = await authed(h.port);
    expect((await fresh.req("projects.list")).ok).toBe(true);
  });

  it("stop() closes sockets and servers", async () => {
    const h = await setup();
    const c = await authed(h.port);
    await h.server.stop();
    await c.closed;
    await expect(httpGet(h.port, "/health")).rejects.toThrow();
  });
});

describe("tailscale rescan", () => {
  function v4(address: string): os.NetworkInterfaceInfo {
    return { address, netmask: "255.255.255.255", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: null };
  }

  it("binds an address when it appears and closes it when it vanishes", async () => {
    // 127.0.0.1 stands in for a Tailscale address: listenLocalhost off, CIDR = 127.0.0.1/32.
    let ifs: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
    const h = await setup(
      { listenLocalhost: false, listenTailscale: true, tailscaleCidrs: ["127.0.0.1/32"], tailscaleRescanMs: 40 },
      () => ifs,
    );
    expect(h.server.addresses()).toEqual([]);
    ifs = { utun9: [v4("127.0.0.1")] };
    await tick(150);
    const addrs = h.server.addresses();
    expect(addrs.map((a) => a.host)).toEqual(["127.0.0.1"]);
    const port = addrs[0]?.port ?? 0;
    expect((await httpGet(port, "/health")).status).toBe(200);
    const c = await connect(port);
    await authenticate(c.ws, TEST_KEY);
    ifs = {};
    await tick(150);
    expect(h.server.addresses()).toEqual([]);
    await c.closed;
    await expect(httpGet(port, "/health")).rejects.toThrow();
  });
});

describe("real interfaces", () => {
  it("binds only loopback / tailscale addresses; LAN IPv4 is refused", async () => {
    const h = await setup({ listenTailscale: true });
    const blocklist = new net.BlockList();
    for (const cidr of h.config.tailscaleCidrs) {
      const [addr, prefix] = cidr.split("/");
      blocklist.addSubnet(addr ?? "", Number(prefix), net.isIPv6(addr ?? "") ? "ipv6" : "ipv4");
    }
    for (const { host } of h.server.addresses()) {
      const isLoop = host === "127.0.0.1" || host === "::1";
      const isTs = blocklist.check(host, net.isIPv6(host) ? "ipv6" : "ipv4");
      expect(isLoop || isTs, `unexpected bound address ${host}`).toBe(true);
      expect(host).not.toBe("0.0.0.0");
      expect(host).not.toBe("::");
    }
    const lan = Object.values(os.networkInterfaces())
      .flatMap((x) => x ?? [])
      .find(
        (i) =>
          i.family === "IPv4" &&
          !i.internal &&
          !blocklist.check(i.address, "ipv4") &&
          !i.address.startsWith("169.254."),
      );
    if (!lan) return; // no LAN on this machine: nothing to probe
    const err = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      const s = net.connect({ host: lan.address, port: h.port });
      s.once("connect", () => {
        s.destroy();
        resolve(undefined);
      });
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e));
    });
    expect(err?.code).toBe("ECONNREFUSED");
  });
});
