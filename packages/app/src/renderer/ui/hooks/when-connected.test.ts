import { describe, expect, it, vi } from "vitest";
import { FakeEngineClient } from "../test-utils/fake-client.ts";
import { whenConnected } from "./when-connected.ts";

describe("whenConnected", () => {
  it("runs once per reconnect when the client fires open before onReconnected", () => {
    const client = new FakeEngineClient();
    const run = vi.fn(() => Promise.resolve());
    whenConnected(client, run);
    client.setState("reconnecting");
    client.emitReconnected(); // setState("open") then reconnected
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs once per reconnect when onReconnected fires before open", () => {
    const client = new FakeEngineClient();
    const run = vi.fn(() => Promise.resolve());
    whenConnected(client, run);
    client.setState("reconnecting");
    client.state = "open";
    (client as unknown as { reconnectL: { emit(): void } }).reconnectL.emit();
    client.setState("open");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("waits for the first open when started while connecting", () => {
    const client = new FakeEngineClient();
    client.state = "connecting";
    const run = vi.fn(() => Promise.resolve());
    whenConnected(client, run);
    client.setState("open");
    client.setState("open");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops after cleanup and swallows rejections", async () => {
    const client = new FakeEngineClient();
    const run = vi.fn(() => Promise.reject(new Error("x")));
    const off = whenConnected(client, run);
    off();
    client.setState("reconnecting");
    client.emitReconnected();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(client.listenerCounts()).toMatchObject({ state: 0, reconnect: 0 });
  });
});
