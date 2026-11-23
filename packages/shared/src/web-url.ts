// Which addresses a web-site tab may load. https anywhere; plain http only for an IP LITERAL inside the configured
// private ranges (the app's `web.defaults.json` → `httpAllowedCidrs`: Tailscale's 100.64.0.0/10 and fd7a:115c:a1e0::/48,
// loopback). A host NAME is never allowed over http — not even a MagicDNS `*.ts.net` one: a name can resolve
// anywhere, and the address it resolved to cannot be pinned for the page's later requests.
//
// Every check runs on the host as the URL parser normalized it, never on the text: `http://1681223485`,
// `http://0144.0100.0161.075`, `http://0x7f.1`, a trailing dot, upper case, percent-encoding and full-width digits all
// become a dotted IPv4 (or fail to parse) before the range check.
import { isHttpsUrl, URL_LIMITS } from "./protocol.ts";

const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const IPV6_GROUPS = 8;
const BITS_PER_BYTE = 8;
const MAX_OCTET = 255;
const HEX = 16;

/** A dotted IPv4 in the parser's normal form (four decimal octets) → bytes. */
function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== IPV4_BYTES) return null;
  const out = new Uint8Array(IPV4_BYTES);
  for (let i = 0; i < IPV4_BYTES; i++) {
    const p = parts[i]!;
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > MAX_OCTET) return null;
    out[i] = n;
  }
  return out;
}

/** An IPv6 of hex groups with at most one `::` (the parser's normal form; no zone, no dotted tail) → bytes. */
function parseIpv6(text: string): Uint8Array | null {
  if (!/^[0-9a-f:]+$/i.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string): string[] | null => {
    if (s === "") return [];
    const g = s.split(":");
    return g.every((x) => /^[0-9a-f]{1,4}$/i.test(x)) ? g : null;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  const missing = IPV6_GROUPS - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  const out = new Uint8Array(IPV6_BYTES);
  all.forEach((g, i) => {
    const n = Number.parseInt(g, HEX);
    out[i * 2] = n >> BITS_PER_BYTE;
    out[i * 2 + 1] = n & MAX_OCTET;
  });
  return out;
}

/**
 * The address a URL's `hostname` names when it is an IP literal (`100.64.113.61`, `[::1]`), else null. Give it the
 * hostname of a parsed URL: the parser has already turned every IPv4 spelling into four decimal octets.
 */
export function ipLiteralBytes(hostname: string): Uint8Array | null {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return parseIpv6(hostname.slice(1, -1));
  return parseIpv4(hostname);
}

/** `100.64.0.0/10`, `::1/128` → network bytes + prefix length; null for anything else. */
export function parseCidr(raw: string): { bytes: Uint8Array; prefix: number } | null {
  const m = /^([0-9a-f:.]+)\/(\d{1,3})$/i.exec(raw.trim());
  if (!m) return null;
  const bytes = m[1]!.includes(":") ? parseIpv6(m[1]!) : parseIpv4(m[1]!);
  const prefix = Number(m[2]);
  if (!bytes || prefix > bytes.length * BITS_PER_BYTE) return null;
  return { bytes, prefix };
}

/** Same family and the first `prefix` bits equal. An entry that is not a CIDR matches nothing. */
export function ipInCidrs(ip: Uint8Array, cidrs: readonly string[]): boolean {
  return cidrs.some((raw) => {
    const cidr = parseCidr(raw);
    if (!cidr || cidr.bytes.length !== ip.length) return false;
    for (let bit = 0; bit < cidr.prefix; bit += BITS_PER_BYTE) {
      const i = bit / BITS_PER_BYTE;
      const bits = Math.min(BITS_PER_BYTE, cidr.prefix - bit);
      const mask = (MAX_OCTET << (BITS_PER_BYTE - bits)) & MAX_OCTET;
      if ((ip[i]! & mask) !== (cidr.bytes[i]! & mask)) return false;
    }
    return true;
  });
}

function parseHttp(raw: string): URL | null {
  if (raw.length > URL_LIMITS.maxUrl || /[\s\0-\x1f\x7f]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && u.hostname !== "" && u.username === "" && u.password === "" ? u : null;
  } catch {
    return null;
  }
}

/**
 * An absolute plain-http URL without credentials whose host is an IP literal inside `cidrs`. Never true for a host
 * name, for a public address or for any other scheme.
 */
export function isPrivateHttpUrl(raw: string, cidrs: readonly string[]): boolean {
  const u = parseHttp(raw);
  if (!u) return false;
  const ip = ipLiteralBytes(u.hostname);
  return ip !== null && ipInCidrs(ip, cidrs);
}

/** What a web-site tab may be pointed at: https anywhere, or plain http to a private IP literal. */
export function isWebSiteUrl(raw: string, httpAllowedCidrs: readonly string[]): boolean {
  return isHttpsUrl(raw) || isPrivateHttpUrl(raw, httpAllowedCidrs);
}

/**
 * The URL as the parser normalized it (`http://0144.0100.0161.075:9119` → `http://100.64.113.61:9119/`), or null
 * when it does not parse. Stored for http sites, so the list shows the address that is really loaded.
 */
export function normalizedUrl(raw: string): string | null {
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
}
