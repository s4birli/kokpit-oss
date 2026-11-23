import { describe, expect, it } from "vitest";
import { checkSites, newSiteId, parseSites, SITE_TRANSPORT_BADGES, siteTransport, siteUrlError, webConfig, type WebSite } from "./web-ipc.ts";

const site = (id: string, url = `https://${id}.example.com/`, title = id.toUpperCase()): WebSite => ({ id, title, url });

describe("web sites (İş M)", () => {
  it("defaults: every default site is valid", () => {
    expect(webConfig.httpAllowedCidrs).toEqual(["100.64.0.0/10", "127.0.0.0/8", "::1/128", "fd7a:115c:a1e0::/48"]);
    expect(checkSites(webConfig.sites).ok).toBe(true);
  });

  it("accepts a valid list and trims titles/urls", () => {
    const r = checkSites([{ id: "a", title: "  Alfa ", url: " https://a.example.com/x " }]);
    expect(r).toEqual({ ok: true, sites: [{ id: "a", title: "Alfa", url: "https://a.example.com/x" }] });
  });

  it.each([
    ["http url", [site("a", "http://a.example.com/")], "https://"],
    ["http to a host name", [site("a", "http://nas.tail1234.ts.net:9119/")], "IP adresi"],
    ["http to localhost by name", [site("a", "http://localhost:9119/")], "IP adresi"],
    ["http to a public address", [site("a", "http://8.8.8.8:9119/")], "Tailscale"],
    ["http to a public address in decimal", [site("a", "http://1681223485/")], "Tailscale"],
    ["http to a LAN address", [site("a", "http://192.168.1.5/")], "Tailscale"],
    ["http with credentials", [site("a", "http://u:p@100.64.113.61:9119/")], "parola"],
    ["an address as credentials", [site("a", "http://100.64.113.61@evil.example/")], "parola"],
    ["ws url", [site("a", "ws://100.64.113.61:9119/")], "https://"],
    ["javascript url", [site("a", "javascript:alert(1)")], "https://"],
    ["file url", [site("a", "file:///etc/passwd")], "https://"],
    ["credentials in url", [site("a", "https://u:p@a.example.com/")], "parola"],
    ["empty title", [site("a", undefined, "  ")], "Ad"],
    ["long title", [site("a", undefined, "x".repeat(61))], "60"],
    ["bad id", [site("../x")], "kimlik"],
    ["uppercase id", [site("Abc")], "kimlik"],
    ["duplicate id", [site("a"), site("a", "https://b.example.com/")], "aynı"],
  ])("rejects %s", (_n, list, msg) => {
    const r = checkSites(list);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(msg);
  });

  it("accepts plain http only for Tailscale/loopback IP literals and stores the normalized address", () => {
    const list = [
      site("a", "http://100.64.113.61:9119"),
      site("b", "http://100.64.113.61:8787/x?y=1"),
      site("c", "http://127.0.0.1:3000/"),
      site("d", "http://[fd7a:115c:a1e0::1]:8080/"),
      site("e", "http://0144.0100.0161.075:9119/"),
      site("f", "HTTP://[0:0:0:0:0:0:0:1]/"),
    ];
    const r = checkSites(list);
    expect(r.ok && r.sites.map((s) => s.url)).toEqual([
      "http://100.64.113.61:9119/",
      "http://100.64.113.61:8787/x?y=1",
      "http://127.0.0.1:3000/",
      "http://[fd7a:115c:a1e0::1]:8080/",
      "http://100.64.113.61:9119/",
      "http://[::1]/",
    ]);
    // Idempotent: what was stored is accepted unchanged.
    expect(r.ok && checkSites(r.sites)).toEqual(r);
    // https addresses are kept exactly as typed.
    const https = checkSites([site("g", "https://Example.com")]);
    expect(https.ok && https.sites[0]!.url).toBe("https://Example.com");
  });

  it("an https *.ts.net address (tailscale serve) is a normal https site with a readable id", () => {
    const url = "https://homeserver.tail1234.ts.net/";
    expect(checkSites([site("nas", url)])).toEqual({ ok: true, sites: [site("nas", url)] });
    expect(newSiteId(url, [])).toBe("homeserver");
    expect(siteTransport(url)).toBe("https");
  });

  it("siteTransport: https, plain http protected by Tailscale, plain http on this machine", () => {
    expect(siteTransport("https://home.example.com/")).toBe("https");
    expect(siteTransport("https://100.64.113.61/")).toBe("https");
    expect(siteTransport("http://100.64.113.61:9119/")).toBe("http-tailnet");
    expect(siteTransport("http://[fd7a:115c:a1e0::1]/")).toBe("http-tailnet");
    expect(siteTransport("http://127.0.0.1:3000/")).toBe("http-local");
    expect(siteTransport("http://[::1]/")).toBe("http-local");
    expect(siteTransport("nonsense")).toBe("https"); // no badge for what is not an http site
    expect(SITE_TRANSPORT_BADGES["http-tailnet"].label).toBe("http · Tailscale");
    // The Tailscale ranges are a subset of the http allowance, and loopback is not among them.
    expect(webConfig.httpTailnet.cidrs).toEqual(["100.64.0.0/10", "fd7a:115c:a1e0::/48"]);
    for (const c of webConfig.httpTailnet.cidrs) expect(webConfig.httpAllowedCidrs).toContain(c);
    expect(webConfig.httpTailnet.cacheMs).toBeLessThanOrEqual(10_000);
  });

  it("without configured ranges every http address is refused", () => {
    const cfg = { limits: webConfig.limits, httpAllowedCidrs: [] };
    expect(checkSites([site("a", "http://127.0.0.1/")], cfg).ok).toBe(false);
    expect(checkSites([site("a", "https://127.0.0.1/")], cfg).ok).toBe(true);
    expect(parseSites([site("a", "http://100.64.113.61/"), site("b")], cfg)).toEqual([site("b")]);
  });

  it("siteUrlError says what is wrong, in Turkish", () => {
    expect(siteUrlError("https://a.example.com/")).toBeUndefined();
    expect(siteUrlError("http://100.64.113.61:9119/")).toBeUndefined();
    expect(siteUrlError("http://nas:9119/")).toMatch(/yalnız IP adresiyle/);
    expect(siteUrlError("http://93.184.216.34/")).toMatch(/100\.64\.0\.0\/10.*https:\/\/ gerekir/);
    expect(siteUrlError("ftp://x/")).toMatch(/https:\/\/ ile başlamalı/);
    expect(siteUrlError("")).toMatch(/https:\/\/ ile başlamalı/);
    expect(siteUrlError("http://127.0.0.1/ x")).toMatch(/https:\/\/ ile başlamalı/);
  });

  it("rejects too many sites and non-arrays", () => {
    const many = Array.from({ length: webConfig.limits.maxSites + 1 }, (_, i) => site(`s${i}`));
    expect(checkSites(many).ok).toBe(false);
    expect(checkSites({} as unknown).ok).toBe(false);
    expect(checkSites([null] as unknown).ok).toBe(false);
  });

  it("parseSites keeps what is valid and never throws (monkey)", () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const junk = [
      null,
      1,
      "x",
      [],
      {},
      { id: 1 },
      { id: "ok", title: "Ok", url: "https://ok.example.com" },
      { id: "ok", title: "Dup", url: "https://dup.example.com" },
      { id: "b", title: "B", url: "ftp://b" },
      { id: "c", title: "<img src=x onerror=alert(1)>", url: "https://c.example.com" },
      { id: "d", title: "D", url: "http://100.64.113.61:9119" },
      { id: "e", title: "E", url: "http://8.8.8.8/" },
      { id: "f", title: "F", url: "http://1681223485/" },
      { id: "g", title: "G", url: "http://nas.ts.net/" },
    ];
    for (let i = 0; i < 300; i++) {
      const list = Array.from({ length: Math.floor(rnd() * 6) }, () => junk[Math.floor(rnd() * junk.length)]);
      const out = parseSites(list);
      expect(checkSites(out).ok).toBe(true);
      // The only http address that ever survives is the Tailscale IP literal.
      for (const s of out) if (s.url.startsWith("http:")) expect(s.url).toBe("http://100.64.113.61:9119/");
    }
    expect(parseSites("nope")).toEqual([]);
  });

  it("newSiteId: slug of the host, unique among existing ids", () => {
    expect(newSiteId("https://grafana.example.com/x", [])).toBe("grafana");
    expect(newSiteId("https://grafana.example.com/", ["grafana"])).toBe("grafana-2");
    expect(newSiteId("https://grafana.example.com/", ["grafana", "grafana-2"])).toBe("grafana-3");
    expect(newSiteId("https://www.Örnek.com/", [])).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(newSiteId("not a url", [])).toBe("site");
  });

  it("newSiteId: an IP address gives a readable id with the port; two ports on one machine never share an id", () => {
    const pano = newSiteId("http://100.64.113.61:9119/", []);
    const web = newSiteId("http://100.64.113.61:8787/", [pano]);
    expect([pano, web]).toEqual(["100-64-113-61-9119", "100-64-113-61-8787"]);
    expect(newSiteId("http://100.64.113.61/", [])).toBe("100-64-113-61");
    expect(newSiteId("https://100.64.113.61/", ["100-64-113-61"])).toBe("100-64-113-61-2");
    // Stable: the same address always derives the same id; odd spellings name the same machine.
    expect(newSiteId("http://100.64.113.61:9119/x", [])).toBe(pano);
    expect(newSiteId("http://0144.0100.0161.075:9119/", [])).toBe(pano);
    expect(newSiteId("http://[fd7a:115c:a1e0::1]:8080/", [])).toBe("fd7a-115c-a1e0-1-8080");
    expect(newSiteId("http://[::1]:3000/", [])).toBe("1-3000");
    const long = newSiteId("http://[fd7a:115c:a1e0:ab12:4843:cd96:6258:b240]:65535/", []);
    for (const id of [pano, web, long, newSiteId("http://[::1]/", [])]) expect(checkSites([site(id)]).ok).toBe(true);
    expect(checkSites([site(newSiteId(`https://${"a".repeat(60)}.com/`, []))]).ok).toBe(true);
  });
});
