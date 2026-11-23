// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkUpdateTransport as check } from "./transport.ts";

const CIDRS = { cidrs: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"] };
const checkUpdateTransport = (url: string, t: Parameters<typeof check>[1]) => check(url, t, CIDRS);

/** A tailnet that knows exactly these addresses (as Tailscale's status would say). */
const tailnet = (...known: string[]) => ({
  verify: async (ip: Uint8Array) => known.includes(ip.length === 4 ? ip.join(".") : Buffer.from(ip).toString("hex")),
});
const DOWN = { verify: async () => false };
const BROKEN = {
  verify: async (): Promise<boolean> => {
    throw new Error("cli crashed");
  },
};

describe("update transport", () => {
  it("this Mac (loopback IP literal) is allowed", async () => {
    expect(await checkUpdateTransport("ws://127.0.0.1:7420", DOWN)).toEqual({ ok: true, via: "loopback" });
    expect(await checkUpdateTransport("ws://127.1.2.3:7420", DOWN)).toEqual({ ok: true, via: "loopback" });
    expect(await checkUpdateTransport("ws://[::1]:7420", DOWN)).toEqual({ ok: true, via: "loopback" });
    // The URL parser normalises other spellings of 127.0.0.1: it really is this Mac.
    expect(await checkUpdateTransport("ws://0x7f000001:7420", DOWN)).toEqual({ ok: true, via: "loopback" });
  });

  it("a Tailscale address only while Tailscale says it is in the tailnet right now", async () => {
    expect(await checkUpdateTransport("ws://100.64.1.2:7420", tailnet("100.64.1.2"))).toEqual({ ok: true, via: "tailnet" });
    // Tailscale down: 100.64/10 is carrier-grade NAT space — some unknown host.
    expect((await checkUpdateTransport("ws://100.64.1.2:7420", DOWN)).ok).toBe(false);
    expect((await checkUpdateTransport("ws://100.64.1.2:7420", tailnet("100.64.9.9"))).ok).toBe(false);
    expect((await checkUpdateTransport("ws://100.64.1.2:7420", BROKEN)).ok).toBe(false);
  });

  it("TLS is allowed", async () => {
    expect(await checkUpdateTransport("wss://mini.tail1234.ts.net", DOWN)).toEqual({ ok: true, via: "tls" });
  });

  it.each([
    ["a LAN address — even if something claimed it is in the tailnet", "ws://192.168.1.20:7420"],
    ["a host name over plain ws (it could resolve anywhere)", "ws://mini.local:7420"],
    ["a MagicDNS name over plain ws", "ws://mini.tail1234.ts.net:7420"],
    ["localhost as a name", "ws://localhost:7420"],
    ["not a URL", "nonsense"],
    ["another scheme", "http://127.0.0.1:7420"],
  ])("refuses %s, with the reason for the user", async (_n, url) => {
    const r = await checkUpdateTransport(url, tailnet("192.168.1.20"));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain("Tailscale ya da bu Mac");
  });
});
