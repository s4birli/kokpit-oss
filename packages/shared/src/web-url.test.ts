// Security tests of the "plain http only for private IP literals" rule (web-site tabs).
import { BlockList, isIP } from "node:net";
import { describe, expect, it } from "vitest";
import { ipInCidrs, ipLiteralBytes, isPrivateHttpUrl, isWebSiteUrl, normalizedUrl, parseCidr } from "./web-url.ts";

/** The app's default allowance (web.defaults.json): Tailscale v4/v6 and loopback. */
const CIDRS = ["100.64.0.0/10", "127.0.0.0/8", "::1/128", "fd7a:115c:a1e0::/48"];
const ok = (url: string): boolean => isPrivateHttpUrl(url, CIDRS);

describe("isPrivateHttpUrl", () => {
  it.each([
    "http://100.64.113.61:9119",
    "http://100.64.113.61:8787/login?next=%2F#x",
    "http://100.64.0.0/",
    "http://100.64.255.255:1/",
    "http://127.0.0.1:8080/",
    "http://127.255.255.254",
    "http://[::1]:3000/",
    "http://[fd7a:115c:a1e0::1]:8787/",
    "http://[fd7a:115c:a1e0:ab12:4843:cd96:6258:b240]/",
    "http://[FD7A:115C:A1E0::1]/",
    "HTTP://100.64.113.61:9119",
  ])("allows a private IP literal: %s", (url) => expect(ok(url)).toBe(true));

  it.each([
    ["just below the Tailscale range", "http://100.63.255.255/"],
    ["just above the Tailscale range", "http://100.128.0.0/"],
    ["a public address", "http://8.8.8.8/"],
    ["a public address with a port", "http://93.184.216.34:9119/"],
    ["a LAN address that is not configured", "http://192.168.1.10/"],
    ["0.0.0.0", "http://0.0.0.0:9119/"],
    ["a public IPv6", "http://[2606:4700:4700::1111]/"],
    ["an IPv6 next to loopback", "http://[::2]/"],
    ["an IPv6 next to the Tailscale prefix", "http://[fd7a:115c:a1e1::1]/"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped Tailscale", "http://[::ffff:100.64.113.61]/"],
    ["IPv4-compatible loopback", "http://[::127.0.0.1]/"],
  ])("refuses %s", (_n, url) => expect(ok(url)).toBe(false));

  it.each([
    ["a DNS name", "http://example.com/"],
    ["localhost", "http://localhost:3000/"],
    ["a MagicDNS name", "http://homeserver.tail1234.ts.net:9119/"],
    ["a bare MagicDNS host", "http://homeserver:9119/"],
    ["a name that embeds the address", "http://100.64.113.61.nip.io/"],
    ["a name that starts with the address", "http://100.64.113.61.evil.example/"],
    ["a name that starts with loopback", "http://127.0.0.1.evil.example/"],
    ["a name that looks numeric", "http://100-64-113-61.evil.example/"],
  ])("refuses %s over http (a name can resolve anywhere)", (_n, url) => expect(ok(url)).toBe(false));

  it.each([
    ["user and password", "http://user:pw@100.64.113.61:9119/"],
    ["user only", "http://user@100.64.113.61:9119/"],
    ["empty user, password", "http://:pw@100.64.113.61/"],
    ["an allowed address as the user name of a public host", "http://100.64.113.61@evil.example/"],
    ["an allowed address and port as credentials", "http://127.0.0.1:80@evil.example/"],
    ["an allowed address as credentials of a public IP", "http://127.0.0.1@8.8.8.8/"],
  ])("refuses userinfo: %s", (_n, url) => expect(ok(url)).toBe(false));

  it.each([
    ["https (not this rule)", "https://100.64.113.61/"],
    ["ws", "ws://100.64.113.61/"],
    ["ftp", "ftp://127.0.0.1/"],
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<p>x"],
    ["blob", "blob:http://127.0.0.1/x"],
    ["view-source", "view-source:http://127.0.0.1/"],
    ["no host", "http://"],
    ["no host, path", "http:///x"],
    ["a relative address", "//127.0.0.1/"],
    ["a bare address", "127.0.0.1:9119"],
    ["empty", ""],
    ["a space inside", "http://127.0.0.1/ x"],
    ["a leading space", " http://127.0.0.1/"],
    ["a newline", "http://127.0.0.1/\nx"],
    ["a NUL", "http://127.0.0.1/\0"],
    ["an IPv6 zone", "http://[fe80::1%25en0]/"],
    ["a port out of range", "http://127.0.0.1:99999/"],
    ["too long", `http://127.0.0.1/${"a".repeat(3000)}`],
  ])("refuses %s", (_n, url) => expect(ok(url)).toBe(false));

  it("odd spellings are judged by the address they really name, never by their text", () => {
    // Spellings of PUBLIC addresses: refused however they are written.
    for (const url of [
      "http://1681223485/", // decimal → 100.53.113.61 (outside 100.64/10)
      "http://134744072/", // 8.8.8.8
      "http://0x08080808/",
      "http://010.010.010.010/", // octal 8.8.8.8
      "http://8.8.2056/",
      "http://0144.064.0.1/", // octal 100.52.0.1
      "http://100.0x35.113.61/",
    ]) {
      expect(ok(url), url).toBe(false);
    }
    // Spellings of ALLOWED addresses name the same private host; the stored form is the normalized one.
    for (const [url, normal] of [
      ["http://1681944893:9119/", "http://100.64.113.61:9119/"],
      ["http://0144.0100.0161.075:9119/", "http://100.64.113.61:9119/"],
      ["http://0x64.0x40.0x71.0x3d:9119/", "http://100.64.113.61:9119/"],
      ["http://100.64.113.61.:9119/", "http://100.64.113.61:9119/"],
      ["http://0x7f.1/", "http://127.0.0.1/"],
      ["http://2130706433/", "http://127.0.0.1/"],
      ["http://127.1/", "http://127.0.0.1/"],
      ["HTTP://127.0.0.1:80/A", "http://127.0.0.1/A"],
      ["http://１２７.０.０.１/", "http://127.0.0.1/"],
      ["http://%31%32%37.0.0.1/", "http://127.0.0.1/"],
      ["http://127.0.0.1\\x", "http://127.0.0.1/x"],
      ["http://[0:0:0:0:0:0:0:1]/", "http://[::1]/"],
    ] as const) {
      expect(ok(url), url).toBe(true);
      expect(normalizedUrl(url), url).toBe(normal);
      expect(ok(normal), normal).toBe(true);
    }
  });

  it("monkey: for any spelling the answer equals an independent range check of the parsed host", () => {
    const oracle = new BlockList();
    oracle.addSubnet("100.64.0.0", 10, "ipv4");
    oracle.addSubnet("127.0.0.0", 8, "ipv4");
    oracle.addAddress("::1", "ipv6");
    oracle.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");
    const expected = (raw: string): boolean => {
      if (/[\s\0-\x1f\x7f]/.test(raw)) return false;
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return false;
      }
      if (u.protocol !== "http:" || u.username !== "" || u.password !== "") return false;
      const host = u.hostname.replace(/^\[|\]$/g, "");
      const family = isIP(host);
      if (family === 0) return false;
      // Mapped/compatible IPv6 forms are refused on purpose (BlockList would match their IPv4 part).
      if (family === 6 && /^::(ffff:)?[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(host) && host !== "::1") return false;
      return oracle.check(host, family === 4 ? "ipv4" : "ipv6");
    };

    let seed = 20261117;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const int = (max: number): number => Math.floor(rnd() * max);
    const octet = (n: number): string => pick([String(n), `0${n.toString(8)}`, `0x${n.toString(16)}`, `0X${n.toString(16).toUpperCase()}`, `00${n}`]);
    const v4 = (): string => {
      const o = pick([
        [100, 64 + int(64), int(256), int(256)],
        [100, int(64), int(256), int(256)],
        [100, 128 + int(128), int(256), int(256)],
        [127, int(256), int(256), int(256)],
        [int(256), int(256), int(256), int(256)],
      ]);
      const whole = ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
      return pick([
        o.join("."),
        o.map(octet).join("."),
        String(whole),
        `0x${whole.toString(16)}`,
        `0${whole.toString(8)}`,
        `${octet(o[0]!)}.${(o[1]! << 16) + (o[2]! << 8) + o[3]!}`,
        `${o.join(".")}.`,
        `${o.join(".")}..`,
        `${o.join(".")}.example.com`,
        `${o.join("-")}.ts.net`,
        `x${o.join(".")}`,
      ]);
    };
    const v6 = (): string =>
      `[${pick(["::1", "::2", "0:0:0:0:0:0:0:1", "fd7a:115c:a1e0::1", `fd7a:115c:a1e0:${int(65536).toString(16)}::${int(65536).toString(16)}`, "fd7a:115c:a1e1::1", "FD7A:115C:A1E0::9", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "2001:db8::1", "fe80::1%25lo0", "::1]:80[", ":::1"])}]`;
    const host = (): string => pick([v4, v4, v4, v6, () => pick(["localhost", "example.com", "LOCALHOST", "nas", "a.ts.net", "", "%31%32%37.0.0.1", "１２７.0.0.1", "127。0。0。1", "127.0.0.1%2f", "[127.0.0.1]"])])();
    const url = (): string =>
      `${pick(["http", "http", "http", "HTTP", "hTtP", "https", "ws", "ftp", "httpx", ""])}${pick(["://", "://", "://", ":", ":/", ":\\\\", ":///"])}${pick(["", "", "", "u@", "u:p@", ":@", "127.0.0.1@", "100.100.100.100:80@"])}${host()}${pick(["", "", ":9119", ":0", ":65535", ":65536", ":", ":x"])}${pick(["", "/", "/a?b#c", "#@127.0.0.1", "/@100.64.1.1", "\\@127.0.0.1", "?http://127.0.0.1"])}`;

    let allowed = 0;
    for (let i = 0; i < 20_000; i++) {
      const raw = url();
      const got = ok(raw);
      expect(got, JSON.stringify(raw)).toBe(expected(raw));
      if (got) allowed++;
    }
    expect(allowed).toBeGreaterThan(100); // the generator does reach the allowed side
  });
});

describe("isWebSiteUrl", () => {
  it("https anywhere, http only for private IP literals, nothing else", () => {
    expect(isWebSiteUrl("https://example.com/", CIDRS)).toBe(true);
    // The recommended setup: `tailscale serve` publishes the page under an https MagicDNS name.
    expect(isWebSiteUrl("https://homeserver.tail1234.ts.net/", CIDRS)).toBe(true);
    expect(isWebSiteUrl("https://homeserver.tail1234.ts.net:8443/login", CIDRS)).toBe(true);
    expect(isWebSiteUrl("http://homeserver.tail1234.ts.net/", CIDRS)).toBe(false);
    expect(isWebSiteUrl("https://100.64.113.61/", CIDRS)).toBe(true);
    expect(isWebSiteUrl("http://100.64.113.61:9119/", CIDRS)).toBe(true);
    expect(isWebSiteUrl("http://example.com/", CIDRS)).toBe(false);
    expect(isWebSiteUrl("https://u:p@example.com/", CIDRS)).toBe(false);
    expect(isWebSiteUrl("javascript:alert(1)", CIDRS)).toBe(false);
  });

  it("without configured ranges it is https only", () => {
    expect(isWebSiteUrl("http://127.0.0.1/", [])).toBe(false);
    expect(isWebSiteUrl("https://127.0.0.1/", [])).toBe(true);
  });
});

describe("CIDR matching", () => {
  it("parses v4 and v6 ranges; junk is not a range", () => {
    expect(parseCidr("100.64.0.0/10")).toEqual({ bytes: new Uint8Array([100, 64, 0, 0]), prefix: 10 });
    expect(parseCidr("::1/128")?.prefix).toBe(128);
    for (const bad of ["", "100.64.0.0", "100.64.0.0/33", "::1/129", "100.64.0/10", "256.0.0.0/8", "a/8", "100.64.0.0/-1", "100.64.0.0/1e1", "*"]) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });

  it("a junk entry in the config never widens the allowance; families do not mix", () => {
    const ip = ipLiteralBytes("8.8.8.8")!;
    expect(ipInCidrs(ip, ["*", "", "0.0.0.0", "8.8.8.8", "::/0"])).toBe(false);
    expect(ipInCidrs(ipLiteralBytes("[::1]")!, ["0.0.0.0/0"])).toBe(false);
    expect(ipInCidrs(ip, ["8.8.8.8/32"])).toBe(true);
    expect(ipInCidrs(ipLiteralBytes("100.64.255.255")!, ["100.64.0.0/10"])).toBe(true);
    expect(ipInCidrs(ipLiteralBytes("100.128.0.0")!, ["100.64.0.0/10"])).toBe(false);
  });

  it("only the parser's normal forms are IP literals", () => {
    expect(ipLiteralBytes("127.0.0.1")).toEqual(new Uint8Array([127, 0, 0, 1]));
    for (const notIp of ["127.1", "0x7f.0.0.1", "0177.0.0.1", "127.0.0.1.", "127.0.0.256", "localhost", "", "::1", "[::1", "[::ffff:127.0.0.1]", "[1::2::3]", "[12345::]", "[1:2:3:4:5:6:7:8:9]", "[g::1]"]) {
      expect(ipLiteralBytes(notIp), notIp).toBeNull();
    }
  });
});
