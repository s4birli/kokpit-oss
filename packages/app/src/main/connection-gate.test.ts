// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionRefused, createConnectionGate, type ConnectionGate } from "./connection-gate.ts";
import connectionDefaults from "./connection.defaults.json" with { type: "json" };

const CIDRS = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];
let dir: string;
let file: string;
let tailnetUp: boolean;
let verifies: number;
let invalidations: number;

function gate(): ConnectionGate {
  return createConnectionGate({
    tailnet: {
      verify: async () => {
        verifies++;
        return tailnetUp;
      },
      invalidate: () => void invalidations++,
    },
    config: { cidrs: CIDRS },
    filePath: file,
    maxAddresses: connectionDefaults.maxInsecureAddresses,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kokpit-conn-gate-"));
  file = join(dir, connectionDefaults.insecureFileName);
  tailnetUp = true;
  verifies = 0;
  invalidations = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the transport gate before any key handshake", () => {
  it.each([
    ["this Mac (loopback IP)", "ws://127.0.0.1:7420", "loopback"],
    ["this Mac (IPv6 loopback)", "ws://[::1]:7420", "loopback"],
    ["TLS", "wss://mini.example.ts.net:7420", "tls"],
    ["a Tailscale address, Tailscale up", "ws://100.64.1.2:7420", "tailnet"],
  ])("lets %s through", async (_n, url, via) => {
    expect(await gate().check(url)).toEqual({ ok: true, via });
  });

  it.each([
    ["a LAN address", "ws://192.168.1.5:7420"],
    ["a host name over plain ws", "ws://mini.local:7420"],
    ["localhost by name (resolves anywhere)", "ws://localhost:7420"],
    ["not a ws url", "http://127.0.0.1:7420"],
    ["garbage", "::::"],
  ])("refuses %s, with the reason and the way out", async (_n, url) => {
    const v = await gate().check(url);
    expect(v).toEqual({ ok: false, message: connectionRefused() });
    expect(connectionRefused()).toContain("Ayarlar › Bağlantı");
  });

  it("a Tailscale address while Tailscale is down is refused (100.64/10 is then someone else's)", async () => {
    tailnetUp = false;
    expect((await gate().check("ws://100.64.1.2:7420")).ok).toBe(false);
  });

  it("Tailscale's status is asked afresh on every (re)connection, never taken from the cache", async () => {
    const g = gate();
    await g.check("ws://100.64.1.2:7420");
    await g.check("ws://100.64.1.2:7420");
    expect(invalidations).toBe(2);
    expect(verifies).toBe(2);
  });
});

describe("'güvenli olmayan ağda yine de bağlan' — per address, persisted, off by default", () => {
  const LAN = "ws://192.168.1.5:7420";

  it("is off by default, and on only for the address it was turned on for", async () => {
    const g = gate();
    expect(await g.insecureAllowed(LAN)).toBe(false);
    await g.setInsecure(LAN, true);
    expect(await g.check(LAN)).toEqual({ ok: true, via: "insecure-optin" });
    expect(await g.check(`${LAN}/`)).toEqual({ ok: true, via: "insecure-optin" });
    expect((await g.check("ws://192.168.1.5:7421")).ok).toBe(false);
    expect((await g.check("ws://192.168.1.6:7420")).ok).toBe(false);
  });

  it("survives a restart (a new gate reads the file), and can be turned off again", async () => {
    await gate().setInsecure(LAN, true);
    expect(await gate().insecureAllowed(LAN)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await gate().setInsecure(LAN, false);
    expect((await gate().check(LAN)).ok).toBe(false);
  });

  it("a damaged or tampered file counts as no opt-in at all (fail closed)", async () => {
    for (const raw of ["not json", "[]", '{"version":1,"addresses":"ws://192.168.1.5:7420"}', '{"version":9,"addresses":["ws://192.168.1.5:7420"]}', '{"version":1,"addresses":[1]}']) {
      writeFileSync(file, raw);
      expect((await gate().check(LAN)).ok, raw).toBe(false);
    }
  });

  it("addresses that need no opt-in are not stored; the list has a cap", async () => {
    const g = gate();
    await g.setInsecure("ws://127.0.0.1:7420", true);
    expect(() => readFileSync(file, "utf8")).toThrow();
    for (let i = 0; i < connectionDefaults.maxInsecureAddresses + 5; i++) await g.setInsecure(`ws://192.168.2.${i}:7420`, true);
    const stored = JSON.parse(readFileSync(file, "utf8")) as { addresses: string[] };
    expect(stored.addresses.length).toBe(connectionDefaults.maxInsecureAddresses);
  });
});
