// İş B: browser frames, acks and input through the real engine client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineClient } from "./client.ts";
import { FakeWebSocket } from "./fake-socket.ts";
import type { EngineClient } from "./types.ts";

let client: EngineClient;

async function connected(): Promise<FakeWebSocket> {
  client = createEngineClient({ url: "ws://engine.test:1", key: "k" }, { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket });
  const ws = FakeWebSocket.last;
  ws.serverOpen();
  await ws.serverAuthenticate("k", { until: () => client.state === "open" });
  return ws;
}

const frame = (projectId: string, frameId: number) => ({
  type: "browser.frame",
  projectId,
  frameId,
  data: "/9j/AA==",
  metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 },
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => {
  client?.close();
  vi.useRealTimers();
});

describe("engine client: browser", () => {
  it("delivers frames to the listeners of their project only, until unsubscribed", async () => {
    const ws = await connected();
    const a: number[] = [];
    const b: number[] = [];
    const offA = client.onBrowserFrame("pa", (f) => a.push(f.frameId));
    client.onBrowserFrame("pb", (f) => b.push(f.frameId));
    ws.serverSend(frame("pa", 1));
    ws.serverSend(frame("pb", 2));
    offA();
    ws.serverSend(frame("pa", 3));
    expect(a).toEqual([1]);
    expect(b).toEqual([2]);
  });

  it("sends acks and valid input as fire-and-forget frames", async () => {
    const ws = await connected();
    client.sendBrowserAck("pa", 4);
    client.sendBrowserInput("pa", { type: "mouse", action: "down", x: 1, y: 2, button: "left", clickCount: 1 });
    expect(ws.sentJson.slice(2)).toEqual([
      { type: "browser.ack", projectId: "pa", frameId: 4 },
      { type: "browser.input", projectId: "pa", event: { type: "mouse", action: "down", x: 1, y: 2, button: "left", clickCount: 1 } },
    ]);
  });

  it("drops invalid input instead of sending a frame that would get the connection closed", async () => {
    const ws = await connected();
    const before = ws.sent.length;
    client.sendBrowserInput("pa", { type: "mouse", action: "move", x: -5, y: 0 });
    client.sendBrowserInput("pa", { type: "text", text: "" });
    client.sendBrowserAck("pa", -1);
    client.sendBrowserAck("pa", 1.5);
    expect(ws.sent.length).toBe(before);
  });

  it("sends nothing while disconnected", () => {
    client = createEngineClient({ url: "ws://engine.test:1", key: "k" }, { WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket });
    expect(() => client.sendBrowserAck("pa", 1)).not.toThrow();
    expect(() => client.sendBrowserInput("pa", { type: "text", text: "x" })).not.toThrow();
    expect(FakeWebSocket.last.sent).toEqual([]);
  });
});
