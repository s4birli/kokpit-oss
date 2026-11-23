// Which addresses the engine binds to. Security-critical: the engine must be
// reachable only via loopback and the Tailscale interface, never from the LAN.
// So we never bind a wildcard; we enumerate exact addresses instead.
import net from "node:net";
import type os from "node:os";
import { networkInterfaces } from "node:os";

export interface ListenOptions {
  listenLocalhost: boolean;
  listenTailscale: boolean;
  tailscaleCidrs: string[];
}

const LOOPBACK = ["127.0.0.1", "::1"] as const;

function parseCidr(cidr: string): { address: string; prefix: number; type: "ipv4" | "ipv6" } {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
  if (!m) throw new Error(`invalid CIDR: ${cidr}`);
  const address = m[1] as string;
  const prefix = Number(m[2]);
  const family = net.isIP(address);
  if (family === 0) throw new Error(`invalid CIDR address: ${cidr}`);
  const max = family === 4 ? 32 : 128;
  if (prefix > max) throw new Error(`invalid CIDR prefix: ${cidr}`);
  return { address, prefix, type: family === 4 ? "ipv4" : "ipv6" };
}

function buildBlockList(cidrs: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const { address, prefix, type } = parseCidr(cidr);
    list.addSubnet(address, prefix, type);
  }
  return list;
}

function isWildcard(address: string): boolean {
  if (address === "0.0.0.0") return true;
  if (net.isIPv6(address)) {
    // Normalise "::", "0:0::0", etc. through a SocketAddress parse.
    try {
      return new net.SocketAddress({ address, family: "ipv6" }).address === "::";
    } catch {
      return false;
    }
  }
  return false;
}

function isTailscale(address: string, list: net.BlockList): boolean {
  // Zone ids (fe80::1%en0) are link-local by definition; never Tailscale.
  if (address.includes("%")) return false;
  const family = net.isIP(address);
  if (family === 0) return false;
  if (isWildcard(address)) return false;
  // IPv4-mapped IPv6 addresses are never bound: BlockList would match them
  // against IPv4 rules, and no real interface address should look like this.
  if (family === 6 && /^::ffff:/i.test(address)) return false;
  try {
    return list.check(address, family === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
}

/** Pure: the exact addresses to bind, loopback first, deduplicated. Never a wildcard. */
export function selectListenAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  opts: ListenOptions,
): string[] {
  const list = buildBlockList(opts.tailscaleCidrs);
  const out = new Set<string>();
  if (opts.listenLocalhost) for (const a of LOOPBACK) out.add(a);
  if (opts.listenTailscale) {
    for (const infos of Object.values(interfaces)) {
      for (const info of infos ?? []) {
        if (isTailscale(info.address, list)) out.add(info.address);
      }
    }
  }
  return [...out];
}

export function isLoopbackAddress(address: string): boolean {
  return (LOOPBACK as readonly string[]).includes(address);
}

/** The address local clients use when nothing tells them another one. */
export const DEFAULT_LOCAL_HOST: string = LOOPBACK[0];

/**
 * Which of the engine's listeners a client on the engine's own machine should use (the screen MCP server):
 * loopback when the engine listens on it (IPv4 first), else the first address it does listen on — with
 * `listenLocalhost` off that is a Tailscale address. Undefined while the engine listens nowhere.
 */
export function localClientAddress<T extends { host: string }>(addresses: readonly T[]): T | undefined {
  for (const loopback of LOOPBACK) {
    const found = addresses.find((a) => a.host === loopback);
    if (found) return found;
  }
  return addresses[0];
}

/**
 * True only for an address the engine itself may be listening on: a loopback address, or an IP literal inside the
 * Tailscale ranges. Never a name, a wildcard, a LAN address or anything with a port, path or user part — a local
 * client checks this before it sends its credential anywhere.
 */
export function isEngineAddress(address: string, tailscaleCidrs: string[]): boolean {
  if (isLoopbackAddress(address)) return true;
  return isTailscale(address, buildBlockList(tailscaleCidrs));
}

/** An IP literal as the host part of a URL (IPv6 in brackets). */
export function urlHost(address: string): string {
  return net.isIPv6(address) ? `[${address}]` : address;
}

/** Every address of this machine's own network interfaces (traffic to one of them never leaves the machine). */
export function localInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address));
}
