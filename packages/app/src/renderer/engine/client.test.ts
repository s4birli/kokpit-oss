import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_CODES, MAX_MESSAGE_BYTES, splitOutputData } from "@kokpit/shared";
import { createEngineClient } from "./client.ts";
import { FakeWebSocket } from "./fake-socket.ts";
import { EngineRequestError, type ConnectionState, type EngineClient } from "./types.ts";
import type { ClientOptions } from "./options.ts";

const settings = { url: "ws://engine.test:1", key: "test-key" };
const opts: Partial<ClientOptions> = {
  backoff: { initialMs: 100, maxMs: 1000, multiplier: 2, jitter: 0 },
  handshakeTimeoutMs: 5_000,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 3_000,
  requestTimeoutMs: 2_000,
  inputChunkSize: 8,
};

let client: EngineClient;
let states: ConnectionState[];

function make(extra: Partial<ClientOptions> = {}): EngineClient {
  client = createEngineClient(settings, {
    ...opts,
    ...extra,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  states = [];
  client.onState((s) => states.push(s));
  return client;
}

/** Opens the current fake socket and completes the mutual handshake (the fake plays the engine with the key). */
async function authenticate(ws = FakeWebSocket.last): Promise<FakeWebSocket> {
  ws.serverOpen();
  await ws.serverAuthenticate(settings.key, { until: () => client.state === "open" });
  return ws;
}

/** The last `req` frame the client sent on `ws`. */
function lastReq(ws: FakeWebSocket) {
  const reqs = ws.sentJson.filter((m) => m.type === "req");
  const r = reqs.at(-1);
  if (!r) throw new Error("no req sent");
  return r as { id: number; method: string; params: unknown };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => {
  client?.close();
  vi.useRealTimers();
});

describe("transport gate (before any key handshake)", () => {
  function gated(verdicts: ({ ok: true } | { ok: false; message: string })[]) {
    const asked: string[] = [];
    client = createEngineClient(settings, {
      ...opts,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      checkTransport: async (url) => {
        asked.push(url);
        return verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!;
      },
    });
    states = [];
    client.onState((s) => states.push(s));
    return asked;
  }

  it("refused: no socket is ever opened (nothing is sent anywhere), the state says why, the reason is readable", async () => {
    gated([{ ok: false, message: "güvenli değil" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(client.state).toBe("insecure-transport");
    expect(client.transportMessage).toBe("güvenli değil");
  });

  it("asks again on every reconnection (Tailscale may come up — or go down)", async () => {
    const asked = gated([{ ok: false, message: "kapalı" }, { ok: false, message: "kapalı" }, { ok: true }]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWebSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(asked).toEqual([settings.url, settings.url, settings.url]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await authenticate();
    expect(client.state).toBe("open");
    expect(client.transportMessage).toBeUndefined();
    // The socket drops: the next attempt is gated again.
    FakeWebSocket.last.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked.length).toBe(4);
  });

  it("a gate that throws counts as a refusal", async () => {
    client = createEngineClient(settings, {
      ...opts,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      checkTransport: async () => {
        throw new Error("ipc down");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(client.state).toBe("insecure-transport");
  });

  it("closed while the gate is asked: nothing is opened afterwards", async () => {
    let release!: (v: { ok: true }) => void;
    client = createEngineClient(settings, {
      ...opts,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      checkTransport: () => new Promise((r) => (release = r)),
    });
    client.close();
    release({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("handshake", () => {
  it("starts connecting to the configured url; its first frame is auth.hello — never the key", () => {
    make();
    expect(client.state).toBe("connecting");
    const ws = FakeWebSocket.last;
    expect(ws.url).toBe(settings.url);
    ws.serverOpen();
    expect(ws.sentJson).toEqual([{ type: "auth.hello", nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }]);
    expect(ws.sent.join("\n")).not.toContain(settings.key);
    expect(client.state).toBe("connecting");
  });

  it("becomes open only after the engine proved itself; the key is in no frame", async () => {
    make();
    const ws = await authenticate();
    expect(client.state).toBe("open");
    expect(states).toEqual(["open"]);
    expect(ws.sentJson.map((m) => m.type)).toEqual(["auth.hello", "auth.proof"]);
    expect(ws.sent.join("\n")).not.toContain(settings.key);
  });

  it("an impostor (a hello.ok without a valid proof): never open, nothing else sent, the key not sent, retried", async () => {
    make();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    const req = client.request("projects.list", {}).catch((e: unknown) => e);
    await ws.serverAuthenticate(settings.key, { engineProof: "bogus", until: () => client.state === "engine-unverified" });
    expect(client.state).toBe("engine-unverified");
    expect(ws.sentJson.map((m) => m.type)).toEqual(["auth.hello", "auth.proof"]);
    expect(ws.sent.join("\n")).not.toContain(settings.key);
    expect(ws.closedByClient).not.toBeNull();
    expect(await req).toBeInstanceOf(EngineRequestError);
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("an impostor that skips the challenge and answers hello.ok at once is refused the same way", async () => {
    make();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverSend({ type: "hello.ok", engineVersion: "0", engineBuild: { buildId: "0.0.0+20260101000000.x", version: "0.0.0", commit: "x", builtAt: "t" }, protocol: 2, proof: "A".repeat(43) });
    await ws.settleUntil(() => client.state === "engine-unverified");
    expect(client.state).toBe("engine-unverified");
    expect(ws.sentJson.map((m) => m.type)).toEqual(["auth.hello"]);
  });

  it("4401 after the proof → unauthorized and never retries", async () => {
    make();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    // The fake engine holds another key: it refuses the proof with 4401.
    await ws.serverAuthenticate("another-key");
    await ws.settleUntil(() => client.state === "unauthorized");
    expect(client.state).toBe("unauthorized");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("4401 before any challenge = an engine from before the handshake: says so, keeps retrying, never sends the key", async () => {
    make();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverClose(CLOSE_CODES.UNAUTHORIZED);
    expect(client.state).toBe("outdated-engine");
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last.serverOpen();
    expect(FakeWebSocket.last.sentJson.map((m) => m.type)).toEqual(["auth.hello"]);
    for (const w of FakeWebSocket.instances) expect(w.sent.join("\n")).not.toContain(settings.key);
  });

  it("handshake timeout abandons the attempt and retries", () => {
    make();
    FakeWebSocket.last.serverOpen(); // hello sent, hello.ok never arrives
    vi.advanceTimersByTime(5_000);
    expect(client.state).toBe("reconnecting");
    expect(FakeWebSocket.instances[0]!.closedByClient).not.toBeNull();
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("a constructor that throws is treated as a failed attempt", () => {
    let calls = 0;
    class Throwing extends FakeWebSocket {
      constructor(url: string) {
        calls++;
        if (calls === 1) throw new SyntaxError("bad url");
        super(url);
      }
    }
    client = createEngineClient(settings, { ...opts, WebSocketImpl: Throwing as unknown as typeof WebSocket });
    expect(client.state).toBe("reconnecting");
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("reconnect", () => {
  it("normal close → reconnecting, exponential backoff, re-hello", async () => {
    make();
    (await authenticate()).serverClose(1006);
    expect(client.state).toBe("reconnecting");

    vi.advanceTimersByTime(99);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // second consecutive failure waits 200ms
    FakeWebSocket.last.serverClose(1006);
    vi.advanceTimersByTime(199);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    const ws = await authenticate();
    expect(ws.sentJson[0]).toMatchObject({ type: "auth.hello" });
    expect(client.state).toBe("open");
    expect(states).toEqual(["open", "reconnecting", "open"]);
  });

  it("backoff resets after a successful auth", async () => {
    make();
    (await authenticate()).serverClose(1006);
    vi.advanceTimersByTime(100);
    FakeWebSocket.last.serverClose(1006);
    vi.advanceTimersByTime(200);
    (await authenticate()).serverClose(1006);
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("socket error → reconnecting", async () => {
    make();
    (await authenticate()).serverError();
    expect(client.state).toBe("reconnecting");
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("onReconnected fires on the 2nd auth, not the 1st", async () => {
    make();
    const reconnected = vi.fn();
    client.onReconnected(reconnected);
    await authenticate();
    expect(reconnected).not.toHaveBeenCalled();
    FakeWebSocket.last.serverClose(1006);
    vi.advanceTimersByTime(100);
    await authenticate();
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it("4401 after a successful session: reconnects, and a refused proof then stops retrying", async () => {
    make();
    (await authenticate()).serverClose(CLOSE_CODES.UNAUTHORIZED);
    expect(client.state).toBe("reconnecting");
    vi.advanceTimersByTime(100);
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    await ws.serverAuthenticate("the-key-was-changed-on-the-engine");
    await ws.settleUntil(() => client.state === "unauthorized");
    expect(client.state).toBe("unauthorized");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("request", () => {
  it("uses incremental ids and resolves with the result", async () => {
    make();
    const ws = await authenticate();
    const p1 = client.request("projects.list", {});
    const p2 = client.request("cards.list", { projectId: "p1" });
    const r1 = lastReq(ws);
    expect(ws.sentJson.filter((m) => m.type === "req").map((m) => m.id)).toEqual([r1.id - 1, r1.id]);
    ws.serverSend({ type: "res", id: r1.id, ok: true, result: { cards: [] } });
    ws.serverSend({ type: "res", id: r1.id - 1, ok: true, result: { projects: [] } });
    await expect(p2).resolves.toEqual({ cards: [] });
    await expect(p1).resolves.toEqual({ projects: [] });
  });

  it("rejects with the engine's error code", async () => {
    make();
    const ws = await authenticate();
    const p = client.request("cards.delete", { cardId: "c1" });
    ws.serverSend({ type: "res", id: lastReq(ws).id, ok: false, error: { code: "DIRTY_WORKTREE", message: "dirty" } });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRequestError);
    expect(err).toMatchObject({ code: "DIRTY_WORKTREE", message: "dirty" });
  });

  it("i18n: an error with a key this app knows shows the app's text; an unknown key keeps the engine's message", async () => {
    make();
    const ws = await authenticate();
    const known = client.request("cards.delete", { cardId: "c1" });
    ws.serverSend({ type: "res", id: lastReq(ws).id, ok: false, error: { code: "INVALID", message: "engine text", key: "settings.tabs.language" } });
    await expect(known).rejects.toMatchObject({ code: "INVALID", message: "Dil" });
    const unknown = client.request("cards.delete", { cardId: "c1" });
    ws.serverSend({ type: "res", id: lastReq(ws).id, ok: false, error: { code: "INVALID", message: "motor metni", key: "engine.newer.than.this.app" } });
    await expect(unknown).rejects.toMatchObject({ code: "INVALID", message: "motor metni" });
  });

  it("times out with TIMEOUT", async () => {
    make();
    await authenticate();
    const p = client.request("projects.list", {});
    const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    vi.advanceTimersByTime(2_000);
    await assertion;
  });

  it("slow methods use their own timeout", async () => {
    make({ methodTimeoutsMs: { "projects.create": 10_000 } });
    const ws = await authenticate();
    const p = client.request("projects.create", { name: "x", location: { kind: "github", url: "https://h/x" } });
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    ws.serverSend({ type: "res", id: lastReq(ws).id, ok: true, result: { project: { id: "p" } } });
    await expect(p).resolves.toMatchObject({ project: { id: "p" } });
  });

  it("a late response after timeout is ignored", async () => {
    make();
    const ws = await authenticate();
    const p = client.request("projects.list", {});
    const id = lastReq(ws).id;
    const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    vi.advanceTimersByTime(2_000);
    await assertion;
    expect(() => ws.serverSend({ type: "res", id, ok: true, result: {} })).not.toThrow();
  });

  it("rejects immediately with DISCONNECTED when not open", async () => {
    make();
    await expect(client.request("projects.list", {})).rejects.toMatchObject({ code: "DISCONNECTED" });
    FakeWebSocket.last.serverOpen(); // hello sent but not acknowledged
    await expect(client.request("projects.list", {})).rejects.toMatchObject({ code: "DISCONNECTED" });
  });

  it("rejects pending requests with DISCONNECTED on close", async () => {
    make();
    const ws = await authenticate();
    const p1 = client.request("projects.list", {});
    const p2 = client.request("terminals.list", { cardId: "c" });
    ws.serverClose(1006);
    await expect(p1).rejects.toMatchObject({ code: "DISCONNECTED" });
    await expect(p2).rejects.toMatchObject({ code: "DISCONNECTED" });
  });

  it("rejects invalid params locally with INVALID instead of sending a frame the engine would close on", async () => {
    make();
    const ws = await authenticate();
    const before = ws.sent.length;
    await expect(
      client.request("terminal.open", { cardId: "c", cols: 0, rows: 24 } as never),
    ).rejects.toMatchObject({ code: "INVALID" });
    expect(ws.sent.length).toBe(before);
  });
});

describe("streams", () => {
  it("routes output per terminalId with the replay flag", async () => {
    make();
    const ws = await authenticate();
    const a = vi.fn();
    const b = vi.fn();
    client.onOutput("t1", a);
    client.onOutput("t2", b);
    ws.serverSend({ type: "output", terminalId: "t1", data: "history", replay: true });
    ws.serverSend({ type: "output", terminalId: "t1", data: "live" });
    ws.serverSend({ type: "output", terminalId: "t2", data: "other" });
    expect(a.mock.calls).toEqual([
      ["history", true, false],
      ["live", false, false],
    ]);
    expect(b.mock.calls).toEqual([["other", false, false]]);
  });

  it("a replay in parts: the first part starts it, the rest continue it, in order", async () => {
    make();
    const ws = await authenticate();
    const a = vi.fn();
    const lost = vi.fn();
    client.onOutput("t1", a);
    client.onOutputLost("t1", lost);
    const part = (index: number, data: string) => ({ type: "output", terminalId: "t1", data, replay: true, part: { index, total: 3 } });
    ws.serverSend(part(0, "bir "));
    ws.serverSend(part(1, "iki "));
    ws.serverSend(part(2, "üç"));
    ws.serverSend({ type: "output", terminalId: "t1", data: " canlı" });
    expect(a.mock.calls).toEqual([
      ["bir ", true, false],
      ["iki ", true, true],
      ["üç", true, true],
      [" canlı", false, false],
    ]);
    expect(lost).not.toHaveBeenCalled();
  });

  it("a full history buffer split by the shared splitter arrives whole", async () => {
    make();
    const ws = await authenticate();
    let screen = "";
    client.onOutput("t1", (data, replay, continued) => {
      if (replay && !continued) screen = "";
      screen += data;
    });
    const history = "\x1b[38;5;196mçğış€😀\x1b[0m\r\n".repeat(60_000);
    expect(JSON.stringify(history).length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    const pieces = splitOutputData(history);
    expect(pieces.length).toBeGreaterThan(1);
    ws.serverSend({ type: "output", terminalId: "t1", data: "eski ekran" });
    for (const [index, data] of pieces.entries()) ws.serverSend({ type: "output", terminalId: "t1", data, replay: true, part: { index, total: pieces.length } });
    expect(screen === history).toBe(true);
  });

  it("routes exit and events; unsubscribe stops delivery", async () => {
    make();
    const ws = await authenticate();
    const exit = vi.fn();
    const ev = vi.fn();
    const offExit = client.onExit("t1", exit);
    client.onEvent(ev);
    ws.serverSend({ type: "exit", terminalId: "t1", exitCode: 0 });
    ws.serverSend({ type: "exit", terminalId: "t2", exitCode: 1 });
    ws.serverSend({ type: "event", name: "cards.changed", projectId: "p" });
    expect(exit.mock.calls).toEqual([[0]]);
    expect(ev).toHaveBeenCalledWith({ type: "event", name: "cards.changed", projectId: "p" });
    offExit();
    ws.serverSend({ type: "exit", terminalId: "t1", exitCode: null });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener does not break the others", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    make();
    const ws = await authenticate();
    const good = vi.fn();
    client.onOutput("t1", () => {
      throw new Error("boom");
    });
    client.onOutput("t1", good);
    client.onState(() => {
      throw new Error("boom");
    });
    ws.serverSend({ type: "output", terminalId: "t1", data: "x" });
    expect(good).toHaveBeenCalledWith("x", false, false);
    ws.serverClose(1006);
    expect(client.state).toBe("reconnecting");
    spy.mockRestore();
  });

  it("unsubscribing inside a callback is safe", async () => {
    make();
    const ws = await authenticate();
    const second = vi.fn();
    const off = client.onOutput("t1", () => off());
    client.onOutput("t1", second);
    ws.serverSend({ type: "output", terminalId: "t1", data: "x" });
    ws.serverSend({ type: "output", terminalId: "t1", data: "y" });
    expect(second).toHaveBeenCalledTimes(2);
  });
});

describe("output that cannot be delivered", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const oversized = (terminalId: string): string => JSON.stringify({ type: "output", terminalId, data: "x".repeat(MAX_MESSAGE_BYTES), replay: true });

  it("an oversized output frame is not silent: the terminal's listeners are told, and it is logged once", async () => {
    make();
    const ws = await authenticate();
    const out = vi.fn();
    const lost = vi.fn();
    const otherLost = vi.fn();
    client.onOutput("t1", out);
    client.onOutputLost("t1", lost);
    client.onOutputLost("t2", otherLost);
    ws.serverSend(oversized("t1"));
    ws.serverSend(oversized("t1"));
    expect(out).not.toHaveBeenCalled();
    expect(lost).toHaveBeenCalledTimes(2);
    expect(otherLost).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("frame too large");
    // The connection and later output are unaffected.
    ws.serverSend({ type: "output", terminalId: "t1", data: "canlı" });
    expect(out.mock.calls).toEqual([["canlı", false, false]]);
    expect(client.state).toBe("open");
  });

  it("a missing replay part: the rest of that replay is dropped and the loss reported", async () => {
    make();
    const ws = await authenticate();
    const out = vi.fn();
    const lost = vi.fn();
    client.onOutput("t1", out);
    client.onOutputLost("t1", lost);
    const part = (index: number, data: string) => ({ type: "output", terminalId: "t1", data, replay: true, part: { index, total: 4 } });
    ws.serverSend(part(0, "a"));
    ws.serverSend(part(2, "c")); // 1 never came
    ws.serverSend(part(3, "d"));
    ws.serverSend({ type: "output", terminalId: "t1", data: "canlı" });
    expect(out.mock.calls).toEqual([
      ["a", true, false],
      ["canlı", false, false],
    ]);
    expect(lost).toHaveBeenCalledTimes(1);
    // A new replay starts clean.
    ws.serverSend(part(0, "A"));
    ws.serverSend(part(1, "B"));
    expect(out.mock.calls.slice(2)).toEqual([
      ["A", true, false],
      ["B", true, true],
    ]);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("a replay whose first part was dropped as oversized: later parts are not shown as if they were the whole history", async () => {
    make();
    const ws = await authenticate();
    const out = vi.fn();
    const lost = vi.fn();
    client.onOutput("t1", out);
    client.onOutputLost("t1", lost);
    ws.serverSend(oversized("t1"));
    ws.serverSend({ type: "output", terminalId: "t1", data: "son", replay: true, part: { index: 1, total: 2 } });
    expect(out).not.toHaveBeenCalled();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("a replay cut by a reconnect does not continue on the new connection", async () => {
    make();
    const ws = await authenticate();
    const out = vi.fn();
    const lost = vi.fn();
    client.onOutput("t1", out);
    client.onOutputLost("t1", lost);
    ws.serverSend({ type: "output", terminalId: "t1", data: "a", replay: true, part: { index: 0, total: 3 } });
    ws.serverClose();
    vi.advanceTimersByTime(opts.backoff!.initialMs!);
    const ws2 = await authenticate();
    ws2.serverSend({ type: "output", terminalId: "t1", data: "b", replay: true, part: { index: 1, total: 3 } });
    expect(out.mock.calls).toEqual([["a", true, false]]);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("undecodable frames that are not terminal output are logged once per reason and change nothing", async () => {
    make();
    const ws = await authenticate();
    const lost = vi.fn();
    client.onOutputLost("t1", lost);
    ws.serverSend("{not json");
    ws.serverSend("{still not json");
    ws.serverSend(JSON.stringify({ type: "res", id: 1, ok: true, result: "x".repeat(MAX_MESSAGE_BYTES) }));
    expect(lost).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(client.state).toBe("open");
  });

  it("monkey: random frames and random part orders never throw, and never show a replay out of order", async () => {
    make();
    const ws = await authenticate();
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const shown: number[] = [];
    client.onOutput("t1", (data, replay, continued) => {
      if (!replay) return;
      if (!continued) shown.length = 0;
      shown.push(Number(data));
      // What is on screen is always parts 0…n of one replay.
      expect(shown).toEqual(shown.map((_v, i) => i));
    });
    client.onOutputLost("t1", () => {});
    for (let i = 0; i < 2000; i++) {
      const total = 1 + Math.floor(next() * 5);
      const index = Math.floor(next() * total);
      const roll = next();
      if (roll < 0.7) ws.serverSend({ type: "output", terminalId: "t1", data: String(index), replay: true, part: { index, total } });
      else if (roll < 0.8) ws.serverSend({ type: "output", terminalId: "t1", data: "canlı" });
      else if (roll < 0.9) ws.serverSend(`{"type":"output","terminalId":"t1","data":${"[".repeat(Math.floor(next() * 5))}`);
      else ws.serverSend(String.fromCharCode(...Array.from({ length: Math.floor(next() * 40) }, () => Math.floor(next() * 0x800))));
    }
    expect(client.state).toBe("open");
  });
});

describe("input and resize", () => {
  it("are sent only while open, else dropped", async () => {
    make();
    client.sendInput("t1", "lost");
    client.sendResize("t1", 80, 24);
    const ws = await authenticate();
    client.sendInput("t1", "ls\r");
    client.sendResize("t1", 100, 30);
    expect(ws.sentJson.slice(2)).toEqual([
      { type: "input", terminalId: "t1", data: "ls\r" },
      { type: "resize", terminalId: "t1", cols: 100, rows: 30 },
    ]);
    ws.serverClose(1006);
    expect(() => client.sendInput("t1", "x")).not.toThrow();
  });

  it("drops resizes the engine would reject", async () => {
    make();
    const ws = await authenticate();
    client.sendResize("t1", 0, 24);
    client.sendResize("t1", 80.5, 24);
    client.sendResize("", 80, 24);
    expect(ws.sent).toHaveLength(2); // auth.hello, auth.proof — and none of the resizes
  });

  it("splits large input into chunks without breaking surrogate pairs", async () => {
    make();
    const ws = await authenticate();
    const data = "abcdefg😀hijklmnop";
    client.sendInput("t1", data);
    const chunks = ws.sentJson.slice(2).map((m) => m.data as string);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(data);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(8);
      expect(/[\uD800-\uDBFF]$/.test(c)).toBe(false);
    }
  });
});

describe("heartbeat", () => {
  it("probes with projects.list while open", async () => {
    make();
    const ws = await authenticate();
    vi.advanceTimersByTime(10_000);
    expect(lastReq(ws).method).toBe("projects.list");
  });

  it("answered probes keep the connection", async () => {
    make();
    const ws = await authenticate();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(10_000);
      ws.serverSend({ type: "res", id: lastReq(ws).id, ok: true, result: { projects: [] } });
    }
    expect(client.state).toBe("open");
    expect(ws.closedByClient).toBeNull();
  });

  it("an unanswered probe forces close and reconnect", async () => {
    make();
    const ws = await authenticate();
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(3_000);
    await Promise.resolve();
    expect(ws.closedByClient).not.toBeNull();
    expect(client.state).toBe("reconnecting");
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("monkey", () => {
  it("garbage before the handshake never authenticates and is never delivered", async () => {
    make();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    const out = vi.fn();
    client.onOutput("t1", out);
    const garbage: unknown[] = [
      "",
      "not json",
      "null",
      "[]",
      "42",
      '{"type":"hello.ok"}',
      '{"__proto__":{"polluted":true},"type":"hello.ok","engineVersion":"x"}',
      { type: "output", terminalId: "", data: "x" },
      { type: "output", terminalId: "t1", data: 42 },
      { type: "res", id: -1, ok: true, result: {} },
      { type: "unknown" },
      "x".repeat(2 * 1024 * 1024),
    ];
    for (const g of garbage) expect(() => ws.serverSend(g)).not.toThrow();
    expect(() => ws.serverSendRaw(new ArrayBuffer(8))).not.toThrow();
    expect(() => ws.serverSendRaw(undefined)).not.toThrow();
    await ws.settle();
    expect(client.state).toBe("connecting");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out).not.toHaveBeenCalled();
  });

  it("garbage after the handshake is ignored", async () => {
    make();
    const ws = await authenticate();
    const out = vi.fn();
    client.onOutput("t1", out);
    for (let i = 0; i < 200; i++) {
      const bytes = Array.from({ length: Math.floor(Math.random() * 40) }, () =>
        String.fromCharCode(Math.floor(Math.random() * 0xffff)),
      ).join("");
      expect(() => ws.serverSend(bytes)).not.toThrow();
    }
    expect(client.state).toBe("open");
    expect(out).not.toHaveBeenCalled();
  });

  it("a valid frame out of order before the handshake (a server that skips it) ends the attempt", async () => {
    make();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverSend({ type: "res", id: 99999, ok: true, result: {} });
    await ws.settleUntil(() => client.state === "reconnecting");
    expect(client.state).toBe("reconnecting");
    expect(ws.sentJson.map((m) => m.type)).toEqual(["auth.hello"]);
  });

  it("ignores stream frames before hello.ok", () => {
    make();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    const out = vi.fn();
    client.onOutput("t1", out);
    ws.serverSend({ type: "output", terminalId: "t1", data: "early" });
    expect(out).not.toHaveBeenCalled();
  });
});

describe("close()", () => {
  it("stops retries, timers and closes the socket", async () => {
    make();
    const ws = await authenticate();
    const p = client.request("projects.list", {});
    client.close();
    await expect(p).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(ws.closedByClient).not.toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.sent.filter((s) => s.includes('"req"'))).toHaveLength(1);
  });

  it("during backoff cancels the pending reconnect", async () => {
    make();
    (await authenticate()).serverClose(1006);
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("is idempotent and later sends are no-ops", async () => {
    make();
    await authenticate();
    client.close();
    client.close();
    expect(() => client.sendInput("t1", "x")).not.toThrow();
    await expect(client.request("projects.list", {})).rejects.toMatchObject({ code: "DISCONNECTED" });
  });
});
