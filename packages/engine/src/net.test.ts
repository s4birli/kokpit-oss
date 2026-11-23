import type os from "node:os";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_HOST, isEngineAddress, localClientAddress, selectListenAddresses, urlHost } from "./net.ts";

const CIDRS = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];

function iface(address: string, internal = false): os.NetworkInterfaceInfo {
  const v6 = address.includes(":");
  return v6
    ? { address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal, cidr: null, scopeid: 0 }
    : { address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: null };
}

const all = { listenLocalhost: true, listenTailscale: true, tailscaleCidrs: CIDRS };

describe("selectListenAddresses", () => {
  it.each([
    ["LAN 192.168.x", "192.168.1.20"],
    ["LAN 10.x", "10.0.0.5"],
    ["LAN 172.16.x", "172.16.3.4"],
    ["docker bridge", "172.17.0.1"],
    ["link-local v4", "169.254.10.1"],
    ["link-local fe80", "fe80::1"],
    ["link-local fe80 with zone", "fe80::1%en0"],
    ["100.63.x just below /10", "100.63.255.255"],
    ["100.128.x just above /10", "100.128.0.1"],
    ["public v6", "2001:db8::1"],
    ["fd7a outside /48", "fd7a:115c:a1e1::1"],
    ["::ffff mapped tailscale", "::ffff:100.64.0.1"],
    ["::ffff mapped LAN", "::ffff:192.168.1.20"],
    ["unspecified v4", "0.0.0.0"],
    ["unspecified v6", "::"],
    ["garbage", "not-an-ip"],
  ])("rejects %s (%s)", (_name, address) => {
    const r = selectListenAddresses({ x: [iface(address)] }, { ...all, listenLocalhost: false });
    expect(r).toEqual([]);
  });

  it.each([
    ["100.64.0.1", "100.64.0.1"],
    ["top of /10", "100.64.255.254"],
    ["fd7a:115c:a1e0::1", "fd7a:115c:a1e0::1"],
    ["fd7a:115c:a1e0:ab12::5", "fd7a:115c:a1e0:ab12::5"],
  ])("accepts tailscale %s", (_name, address) => {
    const r = selectListenAddresses({ utun4: [iface(address)] }, { ...all, listenLocalhost: false });
    expect(r).toEqual([address]);
  });

  it("adds loopback only when listenLocalhost", () => {
    expect(selectListenAddresses({}, all)).toEqual(["127.0.0.1", "::1"]);
    expect(selectListenAddresses({}, { ...all, listenLocalhost: false })).toEqual([]);
  });

  it("ignores interface loopback addresses unless listenLocalhost", () => {
    const ifs = { lo0: [iface("127.0.0.1", true), iface("::1", true), iface("fe80::1", true)] };
    expect(selectListenAddresses(ifs, { ...all, listenLocalhost: false })).toEqual([]);
    expect(selectListenAddresses(ifs, all)).toEqual(["127.0.0.1", "::1"]);
  });

  it("ignores tailscale addresses when listenTailscale is false", () => {
    const ifs = { utun4: [iface("100.64.1.2"), iface("fd7a:115c:a1e0::2")] };
    expect(selectListenAddresses(ifs, { ...all, listenTailscale: false })).toEqual(["127.0.0.1", "::1"]);
  });

  it("mixes interfaces, keeps only loopback + tailscale, dedupes", () => {
    const ifs = {
      en0: [iface("192.168.1.20"), iface("fe80::aa")],
      utun4: [iface("100.64.1.2"), iface("fd7a:115c:a1e0::2")],
      utun5: [iface("100.64.1.2")],
      bridge0: [iface("172.17.0.1")],
      empty: undefined,
    };
    expect(selectListenAddresses(ifs, all)).toEqual(["127.0.0.1", "::1", "100.64.1.2", "fd7a:115c:a1e0::2"]);
  });

  it("never returns wildcard addresses even if a CIDR covers everything", () => {
    const ifs = { x: [iface("0.0.0.0"), iface("::"), iface("100.64.0.1")] };
    const r = selectListenAddresses(ifs, { ...all, tailscaleCidrs: ["0.0.0.0/0", "::/0"] });
    expect(r).not.toContain("0.0.0.0");
    expect(r).not.toContain("::");
    expect(r).toContain("100.64.0.1");
  });

  it("throws on an invalid CIDR (a config bug must not silently widen or hide)", () => {
    expect(() => selectListenAddresses({}, { ...all, tailscaleCidrs: ["100.64.0.0"] })).toThrow();
    expect(() => selectListenAddresses({}, { ...all, tailscaleCidrs: ["nope/10"] })).toThrow();
    expect(() => selectListenAddresses({}, { ...all, tailscaleCidrs: ["100.64.0.0/40"] })).toThrow();
    expect(() => selectListenAddresses({}, { ...all, tailscaleCidrs: ["100.64.0.0/1x"] })).toThrow();
  });
});

// D5: a client on the engine's own machine (the screen MCP server) is told which address to use.
describe("localClientAddress", () => {
  const at = (host: string) => ({ host, port: 7420 });

  it("prefers loopback, IPv4 first, wherever it is in the list", () => {
    expect(localClientAddress([at("100.64.0.1"), at("::1"), at("127.0.0.1")])).toEqual(at("127.0.0.1"));
    expect(localClientAddress([at("100.64.0.1"), at("::1")])).toEqual(at("::1"));
    expect(DEFAULT_LOCAL_HOST).toBe("127.0.0.1");
  });

  it("without loopback (listenLocalhost off) it is the first address the engine does listen on", () => {
    expect(localClientAddress([at("100.64.0.1"), at("fd7a:115c:a1e0::1")])).toEqual(at("100.64.0.1"));
  });

  it("is undefined while the engine listens nowhere", () => {
    expect(localClientAddress([])).toBeUndefined();
  });
});

describe("isEngineAddress", () => {
  it.each(["127.0.0.1", "::1", "100.64.0.1", "100.64.255.254", "fd7a:115c:a1e0::1"])("accepts %s", (address) => {
    expect(isEngineAddress(address, CIDRS)).toBe(true);
  });

  it.each([
    "",
    "localhost",
    "example.com",
    "0.0.0.0",
    "::",
    "192.168.1.20",
    "100.128.0.1",
    "::ffff:127.0.0.1",
    "::ffff:100.64.0.1",
    "fe80::1%en0",
    "127.0.0.1:80",
    "127.0.0.1/evil",
    "127.0.0.1@evil.example",
    " 127.0.0.1",
    "127.1",
  ])("refuses %j", (address) => {
    expect(isEngineAddress(address, CIDRS)).toBe(false);
  });

  it("a Tailscale address counts only inside the configured ranges", () => {
    expect(isEngineAddress("100.64.0.1", [])).toBe(false);
    expect(isEngineAddress("127.0.0.1", [])).toBe(true);
  });
});

describe("urlHost", () => {
  it("brackets IPv6 and leaves IPv4 alone", () => {
    expect(urlHost("127.0.0.1")).toBe("127.0.0.1");
    expect(urlHost("::1")).toBe("[::1]");
    expect(new URL(`ws://${urlHost("fd7a:115c:a1e0::1")}:7420`).port).toBe("7420");
  });
});
