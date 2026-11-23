// @vitest-environment node
// İş M: security rules of the web-site views (pure; the Electron wiring lives in web-host.ts).
import { describe, expect, it } from "vitest";
import { webConfig } from "../renderer/engine/web-ipc.ts";
import {
  WEB_TEST_SITES_ENV,
  WEB_TEST_TRUST_HOST_ENV,
  defaultSites,
  parseWebShowRequest,
  sitePartition,
  webEnv,
  webNavigationDecision,
  webPopupDecision,
  webRequestAllowed,
  webTrustHost,
} from "./web-policy.ts";

const cfg = { ...webConfig, authPopupHosts: ["auth.example.org"] };

describe("sitePartition", () => {
  it("one persistent partition per site; unsafe ids refused", () => {
    expect(sitePartition(cfg, "wiki")).toBe("persist:web-wiki");
    for (const bad of ["", "..", "a/b", "A", "a b", "../x", 7, null]) expect(() => sitePartition(cfg, bad)).toThrow();
  });
});

describe("parseWebShowRequest", () => {
  it("takes a site id and bounds, never a URL", () => {
    expect(parseWebShowRequest({ siteId: "home", bounds: { x: 1, y: 2, width: 3, height: 4 }, url: "https://evil.example/" })).toEqual({
      siteId: "home",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
  });
  it.each([null, {}, { siteId: "../x", bounds: { x: 0, y: 0, width: 1, height: 1 } }, { siteId: "a", bounds: { x: -1, y: 0, width: 1, height: 1 } }])(
    "refuses %j",
    (raw) => expect(() => parseWebShowRequest(raw)).toThrow(),
  );
});

describe("webPopupDecision", () => {
  const site = "https://wiki.example.com/start";
  it("the site's own host and the configured auth hosts open as child windows", () => {
    expect(webPopupDecision(cfg, site, "https://wiki.example.com/edit")).toBe("child");
    expect(webPopupDecision(cfg, site, "https://auth.example.org/login")).toBe("child");
    expect(webPopupDecision(cfg, site, "https://sso.auth.example.org/login")).toBe("child");
  });
  it("other https links go to the user's browser; anything else is denied", () => {
    expect(webPopupDecision(cfg, site, "https://example.com/")).toBe("external");
    expect(webPopupDecision(cfg, site, "https://evil-wiki.example.com.attacker.io/")).toBe("external");
    expect(webPopupDecision(cfg, site, "http://wiki.example.com/")).toBe("deny");
    expect(webPopupDecision(cfg, site, "javascript:alert(1)")).toBe("deny");
    expect(webPopupDecision(cfg, site, "file:///etc/passwd")).toBe("deny");
  });
});

// Plain http: only a site on a private IP literal (Tailscale, loopback), and only inside its own origin.
describe("http sites (private IP literals only)", () => {
  const PANO = "http://100.64.113.61:9119/";
  const HTTPS_SITE = "https://wiki.example.com/start";
  const nav = (site: string, url: string, mainFrame = true) => webNavigationDecision(cfg, site, url, { mainFrame });

  it("an http site navigates inside its own origin (the login redirect)", () => {
    expect(nav(PANO, "http://100.64.113.61:9119/login?next=%2F")).toBe("allow");
    expect(nav(PANO, "http://100.64.113.61:9119/")).toBe("allow");
    expect(nav(PANO, "HTTP://100.64.113.61:9119/x")).toBe("allow");
    expect(nav(PANO, "http://0144.0100.0161.075:9119/x")).toBe("allow"); // the same address, spelled in octal
    expect(nav(PANO, "http://100.64.113.61:9119/frame", false)).toBe("allow");
  });

  it.each([
    ["another port on the same machine", "http://100.64.113.61:8787/"],
    ["the default port", "http://100.64.113.61/"],
    ["another Tailscale machine", "http://100.100.100.100:9119/"],
    ["loopback", "http://127.0.0.1:9119/"],
    ["a public address", "http://93.184.216.34:9119/"],
    ["a public address in decimal", "http://1681223485:9119/"],
    ["a host name", "http://example.com/"],
    ["a MagicDNS name", "http://homeserver.tail1234.ts.net:9119/"],
    ["a name that embeds the address", "http://100.64.113.61.nip.io:9119/"],
    ["its own address with credentials", "http://u:p@100.64.113.61:9119/"],
    ["its own address as credentials of another host", "http://100.64.113.61:9119@evil.example/"],
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["about:blank in the main frame", "about:blank"],
    ["ftp", "ftp://100.64.113.61:9119/"],
  ])("an http site may not navigate to %s", (_n, url) => {
    expect(nav(PANO, url)).toBe("deny");
    if (!url.startsWith("about:")) expect(nav(PANO, url, false)).toBe("deny");
  });

  it("an https link in an http site leaves for the user's browser (main frame) or loads as a frame", () => {
    expect(nav(PANO, "https://example.com/docs")).toBe("external");
    expect(nav(PANO, "https://100.64.113.61:9119/")).toBe("external"); // not the same origin: another scheme
    expect(nav(PANO, "https://example.com/embed", false)).toBe("allow");
  });

  it("an http site's helper frames: empty documents and its own (or https) blobs only", () => {
    expect(nav(PANO, "about:blank", false)).toBe("allow");
    expect(nav(PANO, "about:srcdoc", false)).toBe("allow");
    expect(nav(PANO, "blob:http://100.64.113.61:9119/3c1f", false)).toBe("allow");
    expect(nav(PANO, "blob:https://example.com/3c1f", false)).toBe("allow");
    expect(nav(PANO, "blob:http://100.64.113.61:8787/3c1f", false)).toBe("deny");
    expect(nav(PANO, "blob:http://example.com/3c1f", false)).toBe("deny");
    expect(nav(PANO, "blob:http://100.64.113.61:9119/3c1f")).toBe("deny"); // never the main frame
  });

  it("an https site is never downgraded to http — not even to a private address, not even to its own host", () => {
    for (const url of ["http://wiki.example.com/start", "http://100.64.113.61:9119/", "http://127.0.0.1/", "http://example.com/"]) {
      expect(nav(HTTPS_SITE, url)).toBe("deny");
      expect(nav(HTTPS_SITE, url, false)).toBe("deny");
    }
    // …and everything it could do before, it still can.
    expect(nav(HTTPS_SITE, "https://elsewhere.example.org/")).toBe("allow");
    expect(nav(HTTPS_SITE, "about:blank", false)).toBe("allow");
    expect(nav(HTTPS_SITE, "blob:https://wiki.example.com/1", false)).toBe("allow");
    expect(nav(HTTPS_SITE, "about:blank")).toBe("deny");
  });

  it("a site whose stored address is not acceptable navigates nowhere", () => {
    for (const site of ["", "http://example.com/", "http://8.8.8.8/", "http://u:p@100.64.113.61/", "javascript:1", "not a url"]) {
      expect(nav(site, "https://example.com/")).toBe("deny");
      expect(nav(site, "http://100.64.113.61:9119/")).toBe("deny");
      expect(nav(site, site)).toBe("deny");
    }
  });

  it("an https *.ts.net site (tailscale serve) is an ordinary https site: no http rule, no tailnet check involved", () => {
    const TS = "https://homeserver.tail1234.ts.net/";
    expect(nav(TS, "https://homeserver.tail1234.ts.net/login")).toBe("allow");
    expect(nav(TS, "http://homeserver.tail1234.ts.net/login")).toBe("deny");
    expect(nav(TS, "http://100.64.113.61:9119/")).toBe("deny");
    expect(webPopupDecision(cfg, TS, "https://homeserver.tail1234.ts.net/popup")).toBe("child");
    expect(webRequestAllowed(cfg, TS, "https://homeserver.tail1234.ts.net/api")).toBe(true);
    expect(webRequestAllowed(cfg, TS, "wss://homeserver.tail1234.ts.net/ws")).toBe(true);
  });

  it("without configured ranges an http site is not a site at all", () => {
    const none = { ...cfg, httpAllowedCidrs: [] };
    expect(webNavigationDecision(none, PANO, PANO)).toBe("deny");
    expect(webPopupDecision(none, PANO, PANO)).toBe("deny");
    expect(webRequestAllowed(none, PANO, PANO)).toBe(false);
  });

  it("popups: an http site's own origin opens as a child window; other http is denied; https goes to the browser", () => {
    expect(webPopupDecision(cfg, PANO, "http://100.64.113.61:9119/popup")).toBe("child");
    expect(webPopupDecision(cfg, PANO, "http://100.64.113.61:8787/")).toBe("deny");
    expect(webPopupDecision(cfg, PANO, "http://example.com/")).toBe("deny");
    expect(webPopupDecision(cfg, PANO, "http://8.8.8.8/")).toBe("deny");
    expect(webPopupDecision(cfg, PANO, "http://u@100.64.113.61:9119/")).toBe("deny");
    expect(webPopupDecision(cfg, PANO, "https://example.com/")).toBe("external");
    expect(webPopupDecision(cfg, PANO, "https://100.64.113.61:9119/")).toBe("external");
    expect(webPopupDecision(cfg, PANO, "https://auth.example.org/login")).toBe("child");
    // An https site never opens an http popup, private or not.
    expect(webPopupDecision(cfg, HTTPS_SITE, "http://100.64.113.61:9119/")).toBe("deny");
    expect(webPopupDecision(cfg, HTTPS_SITE, "http://127.0.0.1/")).toBe("deny");
  });

  it("requests (network backstop): plain http/ws only from an http site to its own address and port", () => {
    expect(webRequestAllowed(cfg, PANO, "http://100.64.113.61:9119/api/boards")).toBe(true);
    expect(webRequestAllowed(cfg, PANO, "ws://100.64.113.61:9119/ws")).toBe(true);
    for (const url of [
      "http://100.64.113.61:8787/api",
      "ws://100.64.113.61:8787/ws",
      "http://100.100.100.100:9119/",
      "http://127.0.0.1:9119/",
      "http://example.com/pixel.gif",
      "ws://example.com/",
      "http://93.184.216.34:9119/",
      "http://1681223485:9119/",
      "http://homeserver:9119/",
      "http://u:p@100.64.113.61:9119/",
      "not a url",
    ]) {
      expect(webRequestAllowed(cfg, PANO, url), url).toBe(false);
    }
    // An https site makes no plain http/ws request at all.
    for (const url of ["http://wiki.example.com/x", "ws://wiki.example.com/x", "http://100.64.113.61:9119/", "http://127.0.0.1/"]) {
      expect(webRequestAllowed(cfg, HTTPS_SITE, url), url).toBe(false);
    }
    // Other schemes are not this rule's business (https is the navigation rules', the rest never leaves the machine).
    for (const url of ["https://example.com/", "wss://example.com/", "data:text/plain,x", "blob:http://100.64.113.61:9119/1", "about:blank"]) {
      expect(webRequestAllowed(cfg, PANO, url), url).toBe(true);
      expect(webRequestAllowed(cfg, HTTPS_SITE, url), url).toBe(true);
    }
  });

  it("monkey: whatever the target, an http site only ever reaches its own origin over http, and an https site never does", () => {
    let seed = 4711;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const hosts = ["100.64.113.61", "0144.0100.0161.075", "1681944893", "100.64.113.61.", "100.64.113.62", "100.53.113.61", "1681223485", "8.8.8.8", "127.0.0.1", "localhost", "example.com", "100.64.113.61.nip.io", "[::1]", "[fd7a:115c:a1e0::1]", "[::ffff:100.64.113.61]", "EXAMPLE.com", ""];
    const target = (): string =>
      `${pick(["http", "HTTP", "https", "ws", "wss", "ftp", "blob:http", "javascript"])}${pick(["://", ":", ":\\\\"])}${pick(["", "", "u@", "u:p@", "100.64.113.61:9119@"])}${pick(hosts)}${pick(["", ":9119", ":8787", ":80", ":99999", ":x"])}${pick(["", "/", "/a?b", "#@100.64.113.61:9119", "/@100.64.113.61:9119/"])}`;
    const sameOrigin = (raw: string): boolean => {
      try {
        const u = new URL(raw);
        return u.protocol === "http:" && u.origin === "http://100.64.113.61:9119" && u.username === "" && u.password === "";
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 5000; i++) {
      const raw = target();
      const mainFrame = rnd() < 0.5;
      const d = webNavigationDecision(cfg, PANO, raw, { mainFrame });
      const isHttp = /^http:/i.test(raw) || /^blob:http:/i.test(raw);
      if (isHttp && d !== "deny") expect(sameOrigin(raw.replace(/^blob:/i, "")), raw).toBe(true);
      if (/^http:/i.test(raw) && sameOrigin(raw)) expect(d, raw).toBe("allow");
      if (d === "external") expect(/^https:/i.test(raw) && mainFrame, raw).toBe(true);
      if (/^(http|ws):/i.test(raw)) {
        expect(webNavigationDecision(cfg, HTTPS_SITE, raw, { mainFrame }), raw).toBe("deny");
        expect(webRequestAllowed(cfg, HTTPS_SITE, raw), raw).toBe(false);
        expect(webPopupDecision(cfg, HTTPS_SITE, raw), raw).toBe("deny");
      }
      if (/^http:/i.test(raw)) {
        expect(webRequestAllowed(cfg, PANO, raw), raw).toBe(sameOrigin(raw));
        expect(webPopupDecision(cfg, PANO, raw), raw).toBe(sameOrigin(raw) ? "child" : "deny");
      }
    }
  });
});

describe("defaultSites", () => {
  it("the app config's sites unless the test-only override is set", () => {
    expect(defaultSites(cfg, {})).toEqual(webConfig.sites);
    const override = [{ id: "home", title: "Yerel", url: "https://127.0.0.1:9/" }];
    expect(defaultSites(cfg, { [WEB_TEST_SITES_ENV]: JSON.stringify(override) })).toEqual(override);
    expect(defaultSites(cfg, { [WEB_TEST_SITES_ENV]: "[]" })).toEqual([]);
  });
  it("a broken override is an error, not a silent fallback to the real sites", () => {
    expect(() => defaultSites(cfg, { [WEB_TEST_SITES_ENV]: "{" })).toThrow();
    expect(() => defaultSites(cfg, { [WEB_TEST_SITES_ENV]: '[{"id":"a","title":"A","url":"http://a"}]' })).toThrow();
    expect(() => defaultSites(cfg, { [WEB_TEST_SITES_ENV]: '[{"id":"a","title":"A","url":"http://8.8.8.8/"}]' })).toThrow();
  });
  it("a local http test site (loopback IP literal) is accepted as an override", () => {
    const override = [{ id: "pano", title: "Pano", url: "http://127.0.0.1:9119/" }];
    expect(defaultSites(cfg, { [WEB_TEST_SITES_ENV]: JSON.stringify(override) })).toEqual(override);
  });
});

describe("test-only switches", () => {
  const env = { [WEB_TEST_SITES_ENV]: "[]", [WEB_TEST_TRUST_HOST_ENV]: "127.0.0.1", HOME: "/Users/x" };
  it("are dropped in a packaged app", () => {
    expect(webEnv(env, true)).toEqual({ HOME: "/Users/x" });
    expect(webEnv(env, false)).toEqual(env);
  });
  it("trust host: loopback only", () => {
    expect(webTrustHost({})).toBeNull();
    expect(webTrustHost({ [WEB_TEST_TRUST_HOST_ENV]: "127.0.0.1" })).toBe("127.0.0.1");
    expect(() => webTrustHost({ [WEB_TEST_TRUST_HOST_ENV]: "home.example.org" })).toThrow();
  });
});
