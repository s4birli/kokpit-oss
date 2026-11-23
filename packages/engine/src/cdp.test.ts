// İş B: the minimal CDP client, against a fake DevTools WebSocket server.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { connectCdp } from "./cdp.ts";

let wss: WebSocketServer | undefined;

afterEach(async () => {
  for (const c of wss?.clients ?? []) c.terminate();
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  wss = undefined;
});

/** A fake browser endpoint; `onMessage` answers each command. */
async function fakeDevTools(onMessage: (ws: WebSocket, msg: { id: number; method: string; params: unknown; sessionId?: string }) => void) {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss!.once("listening", () => r()));
  wss.on("connection", (ws) => ws.on("message", (d) => onMessage(ws, JSON.parse(d.toString()))));
  const { port } = wss.address() as { port: number };
  return `ws://127.0.0.1:${port}/devtools/browser/x`;
}

describe("connectCdp", () => {
  it("sends commands with ids (and sessionId) and resolves their results", async () => {
    const seen: unknown[] = [];
    const url = await fakeDevTools((ws, m) => {
      seen.push(m);
      ws.send(JSON.stringify({ id: m.id, result: { echo: m.method } }));
    });
    const cdp = await connectCdp(url, { timeoutMs: 2000 });
    await expect(cdp.send("Target.getTargets")).resolves.toEqual({ echo: "Target.getTargets" });
    await expect(cdp.send("Page.enable", {}, "S1")).resolves.toEqual({ echo: "Page.enable" });
    expect(seen).toEqual([
      { id: 1, method: "Target.getTargets", params: {} },
      { id: 2, method: "Page.enable", params: {}, sessionId: "S1" },
    ]);
    cdp.close();
  });

  it("rejects CDP errors and timeouts", async () => {
    const url = await fakeDevTools((ws, m) => {
      if (m.method === "Bad.method") ws.send(JSON.stringify({ id: m.id, error: { message: "nope" } }));
    });
    const cdp = await connectCdp(url, { timeoutMs: 100 });
    await expect(cdp.send("Bad.method")).rejects.toThrow("nope");
    await expect(cdp.send("Silent.method")).rejects.toThrow(/timed out/);
    cdp.close();
  });

  it("delivers events with their session and ignores junk frames", async () => {
    const url = await fakeDevTools((ws, m) => {
      ws.send("not json");
      ws.send(JSON.stringify({ method: "Page.screencastFrame", params: { sessionId: 7 }, sessionId: "S" }));
      ws.send(JSON.stringify({ id: m.id, result: {} }));
    });
    const cdp = await connectCdp(url, { timeoutMs: 2000 });
    const events: unknown[] = [];
    cdp.on((method, params, sessionId) => events.push([method, params, sessionId]));
    await cdp.send("Go");
    expect(events).toEqual([["Page.screencastFrame", { sessionId: 7 }, "S"]]);
    cdp.close();
  });

  it("rejects pending commands and calls onClose when the socket closes", async () => {
    const url = await fakeDevTools((ws) => ws.close());
    const cdp = await connectCdp(url, { timeoutMs: 2000 });
    let closed = false;
    cdp.onClose(() => (closed = true));
    await expect(cdp.send("X")).rejects.toThrow(/closed/);
    expect(closed).toBe(true);
    expect(cdp.closed).toBe(true);
    await expect(cdp.send("Y")).rejects.toThrow(/closed/);
  });

  it("only connects to ws://127.0.0.1", async () => {
    await expect(connectCdp("ws://10.0.0.5:9222/devtools/browser/x", { timeoutMs: 100 })).rejects.toThrow(/127\.0\.0\.1/);
    await expect(connectCdp("wss://127.0.0.1:9222/x", { timeoutMs: 100 })).rejects.toThrow();
    await expect(connectCdp("not a url", { timeoutMs: 100 })).rejects.toThrow();
  });
});
