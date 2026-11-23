// @vitest-environment node
// Kendini güncelleme — the updater's own connection to the engine: mutual handshake, nothing before the engine
// proved itself, and the key never on the wire.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_CODES, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from "@kokpit/shared";
import { FAKE_ENGINE_BUILD, FakeWebSocket } from "../../renderer/engine/fake-socket.ts";
import { httpOriginOf, openSession, SessionError } from "./session.ts";

const SETTINGS = { url: "ws://100.64.0.1:7420", key: "the-shared-key-0123456789" };
const OPTS = { handshakeTimeoutMs: 1000, requestTimeoutMs: 1000, WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket };

beforeEach(() => FakeWebSocket.reset());
afterEach(() => vi.useRealTimers());

async function opened() {
  const p = openSession(SETTINGS, OPTS);
  const ws = FakeWebSocket.last;
  ws.serverOpen();
  await ws.serverAuthenticate(SETTINGS.key);
  return { session: await p, ws };
}
const reqIds = (ws: FakeWebSocket) => ws.sentJson.filter((m) => m.type === "req").map((m) => m.id as number);

describe("openSession", () => {
  it("authenticates without ever sending the key, and reads the engine's identity from its proven hello.ok", async () => {
    const { session, ws } = await opened();
    expect(ws.sentJson.map((m) => m.type)).toEqual(["auth.hello", "auth.proof"]);
    expect(ws.sent.join("\n")).not.toContain(SETTINGS.key);
    expect(session.engine).toEqual({ version: "0.0.0", build: FAKE_ENGINE_BUILD, protocol: PROTOCOL_VERSION });
    expect(session.httpOrigin).toBe("http://100.64.0.1:7420");
  });

  it("an impostor (no valid engine proof): the session is refused as unverified, and no request was ever sent", async () => {
    const p = openSession(SETTINGS, OPTS).then(() => undefined as never, (e: unknown) => e as SessionError);
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    await ws.serverAuthenticate(SETTINGS.key, { engineProof: "bogus" });
    const err = await p;
    expect(err).toBeInstanceOf(SessionError);
    expect(err.code).toBe("unverified");
    expect(ws.sentJson.map((m) => m.type)).toEqual(["auth.hello", "auth.proof"]);
    expect(ws.sent.join("\n")).not.toContain(SETTINGS.key);
  });

  it("an impostor that skips the challenge is refused the same way", async () => {
    const p = openSession(SETTINGS, OPTS).then(() => undefined as never, (e: unknown) => e as SessionError);
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverSend({ type: "hello.ok", engineVersion: "x", engineBuild: FAKE_ENGINE_BUILD, protocol: PROTOCOL_VERSION, proof: "A".repeat(43) });
    await ws.settle();
    expect((await p).code).toBe("unverified");
    expect(ws.sentJson.map((m) => m.type)).toEqual(["auth.hello"]);
  });

  it("4401 before a challenge = an engine from before the handshake (outdated); after the proof = the key was refused", async () => {
    const old = openSession(SETTINGS, OPTS).then(() => undefined as never, (e: unknown) => e as SessionError);
    FakeWebSocket.last.serverOpen();
    FakeWebSocket.last.serverClose(CLOSE_CODES.UNAUTHORIZED);
    expect((await old).code).toBe("outdated");

    const wrong = openSession(SETTINGS, OPTS).then(() => undefined as never, (e: unknown) => e as SessionError);
    FakeWebSocket.last.serverOpen();
    await FakeWebSocket.last.serverAuthenticate("another-key");
    expect((await wrong).code).toBe("unauthorized");
  });

  it("requests are answered by id; an engine error carries its code", async () => {
    const { session, ws } = await opened();
    const check = session.request("app.update.clients", {});
    const bad = session.request("app.update.download", { buildId: "0.1.0+20261118100000.abc" });
    const [a, b] = reqIds(ws);
    ws.serverSend({ type: "res", id: b!, ok: false, error: { code: "NOT_FOUND", message: "yok" } });
    ws.serverSend({ type: "res", id: a!, ok: true, result: { current: null, clients: [] } });
    expect(await check).toEqual({ current: null, clients: [] });
    await expect(bad).rejects.toMatchObject({ code: "engine", engineCode: "NOT_FOUND", message: "yok" });
  });

  it("an engine's error text is flattened to one bounded line before it reaches the window or the log", async () => {
    const { session, ws } = await opened();
    const req = session.request("app.update.clients", {}).then(() => undefined as never, (e: unknown) => e as SessionError);
    ws.serverSend({ type: "res", id: reqIds(ws)[0]!, ok: false, error: { code: "INTERNAL", message: `satır1\nsahte satır\u0000${"x".repeat(1000)}` } });
    const err = (await req) as SessionError;
    expect(err.message).not.toMatch(/[\n\u0000]/);
    expect(err.message.length).toBeLessThanOrEqual(300);
  });

  it("frames the updater does not know (a newer engine's events) are ignored, not fatal", async () => {
    const { session, ws } = await opened();
    const req = session.request("app.update.clients", {});
    ws.serverSend({ type: "event", name: "some.future.event", extra: 1 });
    ws.serverSend("not json at all");
    ws.serverSend({ type: "res", id: reqIds(ws)[0]!, ok: true, result: { current: null, clients: [] } });
    await expect(req).resolves.toBeDefined();
  });

  it("a frame larger than the protocol allows is not parsed: the connection is dropped", async () => {
    const { session, ws } = await opened();
    const req = session.request("app.update.clients", {}).then(() => undefined as never, (e: unknown) => e as SessionError);
    ws.serverSend("x".repeat(MAX_MESSAGE_BYTES + 1));
    expect(ws.closedByClient).not.toBeNull();
    expect((await req).code).toBe("closed");
  });

  it("an unreachable engine; no hello in time → timeout; an unanswered request → timeout", async () => {
    const down = openSession(SETTINGS, OPTS).then(() => undefined as never, (e: unknown) => e as SessionError);
    FakeWebSocket.last.serverError();
    expect((await down).code).toBe("unreachable");

    vi.useFakeTimers();
    const silent = openSession(SETTINGS, OPTS).then(() => undefined as never, (e: unknown) => e as SessionError);
    FakeWebSocket.last.serverOpen();
    await vi.advanceTimersByTimeAsync(1001);
    expect((await silent).code).toBe("timeout");
    vi.useRealTimers();

    const { session } = await opened();
    vi.useFakeTimers();
    const slow = session.request("app.update.clients", {}).then(() => undefined as never, (e: unknown) => e as SessionError);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await slow).code).toBe("timeout");
  });

  it("a dropped connection fails what is pending; close ends the socket", async () => {
    const { session, ws } = await opened();
    const cut = session.request("app.update.clients", {}).then(() => undefined as never, (e: unknown) => e as SessionError);
    ws.serverClose(1006);
    expect((await cut).code).toBe("closed");
    const again = await opened();
    again.session.close();
    expect(again.ws.closedByClient).not.toBeNull();
  });
});

describe("httpOriginOf", () => {
  it("maps the WebSocket address to the same listener's HTTP origin", () => {
    expect(httpOriginOf("ws://127.0.0.1:7420")).toBe("http://127.0.0.1:7420");
    expect(httpOriginOf("wss://mini.tail1234.ts.net")).toBe("https://mini.tail1234.ts.net");
    expect(httpOriginOf("ws://[fd7a:115c:a1e0::1]:7420/")).toBe("http://[fd7a:115c:a1e0::1]:7420");
  });
});
