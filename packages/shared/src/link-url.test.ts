// Links a program prints in a terminal: which targets may be opened (http/https only), how they are found in a
// line of text, and when an OSC 8 link's visible text lies about where it goes.
import { describe, expect, it } from "vitest";
import { createRateLimiter, deceptiveLinkText, findLinks, LINK_LIMITS, parseLinkTarget } from "./link-url.ts";

const urlsIn = (text: string): string[] => findLinks(text).map((l) => l.url);

describe("parseLinkTarget", () => {
  it.each([
    ["http://localhost:3000", "http://localhost:3000/"],
    ["http://127.0.0.1:5173/a?b=1#c", "http://127.0.0.1:5173/a?b=1#c"],
    ["https://docs.example.com/yol/çğış", "https://docs.example.com/yol/%C3%A7%C4%9F%C4%B1%C5%9F"],
    ["HTTPS://Example.COM/A", "https://example.com/A"],
    ["http://[::1]:8080/x", "http://[::1]:8080/x"],
    ["http://192.168.1.20:8000/", "http://192.168.1.20:8000/"],
    ["https://bücher.example/", "https://xn--bcher-kva.example/"],
    ["http:\\\\example.com\\a", "http://example.com/a"],
  ])("web: %s → %s", (raw, url) => expect(parseLinkTarget(raw)).toMatchObject({ kind: "web", url }));

  it("reports the real host (with its port) of a web link", () => {
    expect(parseLinkTarget("https://Example.com:8443/x")).toEqual({ kind: "web", url: "https://example.com:8443/x", host: "example.com:8443" });
  });

  it.each([
    ["javascript:alert(1)", "javascript:"],
    ["vscode://file/tmp/a.ts", "vscode:"],
    ["mailto:a@example.com", "mailto:"],
    ["data:text/html,<script>1</script>", "data:"],
    ["chrome://settings", "chrome:"],
    ["about:blank", "about:"],
    ["x-apple.systempreferences:com.apple.preference.security", "x-apple.systempreferences:"],
    ["ssh://host/path", "ssh:"],
    ["blob:https://example.com/1", "blob:"],
    ["ws://127.0.0.1:1/", "ws:"],
  ])("refuses the scheme of %s", (raw, scheme) => expect(parseLinkTarget(raw)).toEqual({ kind: "refused", reason: "scheme", scheme }));

  it("a file: link is its own kind: never opened, only copied", () => {
    expect(parseLinkTarget("file:///tmp/a%20b.txt")).toEqual({ kind: "file", url: "file:///tmp/a%20b.txt" });
  });

  it.each([
    ["", "empty"],
    [undefined, "empty"],
    [42, "empty"],
    [{ href: "https://example.com" }, "empty"],
    ["example.com/path", "malformed"],
    ["http://", "malformed"],
    ["https://exa mple.com/", "control"],
    [" https://example.com/", "control"],
    ["https://example.com/\n", "control"],
    ["https://example.com/a\tb", "control"],
    ["https://example.com/\u0000", "control"],
    ["https://example.com/\u001b[31m", "control"],
    ["https://example.com/\u202efdp.exe", "control"],
    ["https://exam\u200bple.com/", "control"],
    ["https://user:pw@example.com/", "credentials"],
    ["https://google.com@evil.example/", "credentials"],
    [`https://example.com/${"a".repeat(LINK_LIMITS.maxUrlLength)}`, "too-long"],
  ])("refuses %j (%s)", (raw, reason) => expect(parseLinkTarget(raw)).toMatchObject({ kind: "refused", reason }));

  it("never throws, whatever it is given", () => {
    const junk: unknown[] = [null, [], {}, Symbol("x"), () => "x", 1n, NaN, "\uD800", "http://[", "http://%", "://", ":", "a:", "//x", "http:/\\/\\x"];
    for (const j of junk) expect(() => parseLinkTarget(j)).not.toThrow();
  });
});

describe("findLinks", () => {
  it.each([
    ["Local:   http://localhost:3000/", ["http://localhost:3000/"]],
    ["  ➜  Network: http://192.168.1.20:5173/", ["http://192.168.1.20:5173/"]],
    ["see https://example.com/a?b=1&c=2#frag for more", ["https://example.com/a?b=1&c=2#frag"]],
    ["HTTPS://EXAMPLE.COM/Yol", ["HTTPS://EXAMPLE.COM/Yol"]],
    ["two: http://a.example/1 and https://b.example/2", ["http://a.example/1", "https://b.example/2"]],
    ["ipv6 http://[::1]:8080/x ok", ["http://[::1]:8080/x"]],
    ["ipv6 at the end http://[fd7a:115c:a1e0::1]", ["http://[fd7a:115c:a1e0::1]"]],
  ])("finds plain URLs: %j", (text, urls) => expect(urlsIn(text)).toEqual(urls));

  it.each([
    ["Bkz. https://example.com/a.", "https://example.com/a"],
    ["(https://example.com/a)", "https://example.com/a"],
    ["Bkz. (https://example.com/a).", "https://example.com/a"],
    ["https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ["(see https://en.wikipedia.org/wiki/Foo_(bar))", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ["[https://example.com/a]", "https://example.com/a"],
    ["<https://example.com/a>", "https://example.com/a"],
    ['"https://example.com/a"', "https://example.com/a"],
    ["'https://example.com/a'", "https://example.com/a"],
    ["`https://example.com/a`", "https://example.com/a"],
    ["https://example.com/a, sonra", "https://example.com/a"],
    ["https://example.com/a; https://example.com/b!", "https://example.com/a"],
    ["https://example.com/a?!", "https://example.com/a"],
    ["https://example.com/a...", "https://example.com/a"],
    ["**https://example.com/a**", "https://example.com/a"],
    ["│ https://example.com/a │", "https://example.com/a"],
    ["https://example.com/a│", "https://example.com/a"],
  ])("leaves the punctuation around a URL out: %j", (text, first) => expect(urlsIn(text)[0]).toBe(first));

  it.each([
    ["Türkçe: şurada https://örnek.example/yol/çğış, görüldü", ["https://örnek.example/yol/çğış"]],
    ["详见https://example.com/a。然后", ["https://example.com/a"]],
    ["こちらhttps://example.com/docs/をご覧ください", ["https://example.com/docs/"]],
    ["링크: https://example.com/a 입니다", ["https://example.com/a"]],
    ["（https://example.com/a）", ["https://example.com/a"]],
  ])("Turkish and CJK text around a URL: %j", (text, urls) => expect(urlsIn(text)).toEqual(urls));

  it.each([
    ["ready on localhost:3000", ["http://localhost:3000"]],
    ["localhost:5173/app?x=1 hazır", ["http://localhost:5173/app?x=1"]],
    ["listening 127.0.0.1:8080.", ["http://127.0.0.1:8080"]],
    ["on 0.0.0.0:4000/", ["http://0.0.0.0:4000/"]],
    ["[::1]:9000/x", ["http://[::1]:9000/x"]],
  ])("a bare local address with a port is an http link: %j", (text, urls) => expect(urlsIn(text)).toEqual(urls));

  it.each([
    "localhost",
    "localhost: 3000",
    "localhost:abc",
    "ssh user@localhost:22",
    "my.localhost:3000",
    "notlocalhost:3000",
    "file:///tmp/a.txt",
    "vscode://file/tmp/a.ts",
    "javascript:alert(1)",
    "mailto:a@example.com",
    "example.com/path",
    "www.example.com",
    "http://",
    "https:// example.com",
    "xhttps://example.com/",
    "ftp://example.com/",
    "https://user:pw@example.com/",
    "",
  ])("no link in %j", (text) => expect(urlsIn(text)).toEqual([]));

  it("reports where the link is in the line (UTF-16 offsets) and what was written", () => {
    const text = "çğ 😀 Bkz. (https://example.com/a).";
    const [link] = findLinks(text);
    expect(link).toBeDefined();
    expect(text.slice(link!.start, link!.end)).toBe("https://example.com/a");
    expect(link!.text).toBe("https://example.com/a");
  });

  it("a bare local address keeps its own text; only the opened URL gets the scheme", () => {
    const text = "bak: localhost:3000/x";
    const [link] = findLinks(text);
    expect(text.slice(link!.start, link!.end)).toBe("localhost:3000/x");
    expect(link).toMatchObject({ text: "localhost:3000/x", url: "http://localhost:3000/x" });
  });

  it("a very long URL is one link up to the length limit, and none beyond it", () => {
    const fits = `https://example.com/${"a".repeat(LINK_LIMITS.maxUrlLength - 100)}`;
    expect(urlsIn(`x ${fits} y`)).toEqual([fits]);
    expect(urlsIn(`x https://example.com/${"a".repeat(LINK_LIMITS.maxUrlLength)} y`)).toEqual([]);
  });

  it("control characters end a URL and are never part of one", () => {
    expect(urlsIn("https://example.com/a\u001b[0m rest")).toEqual(["https://example.com/a"]);
    expect(urlsIn("https://example.com/a\u0000b")).toEqual(["https://example.com/a"]);
    expect(urlsIn("https://example.com/a\u202eb")).toEqual(["https://example.com/a"]);
    expect(urlsIn("https://example.com/a\u0007")).toEqual(["https://example.com/a"]);
  });

  it("looks at a bounded part of a huge line and returns a bounded number of links", () => {
    const many = Array.from({ length: LINK_LIMITS.maxLinksPerLine * 3 }, (_, i) => `http://a.example/${i}`).join(" ");
    expect(findLinks(many)).toHaveLength(LINK_LIMITS.maxLinksPerLine);
    const late = `${" ".repeat(LINK_LIMITS.maxLineChars)}https://example.com/late`;
    expect(findLinks(late)).toEqual([]);
  });

  it("monkey: random lines never throw, and every link found is an openable web address inside the line", () => {
    const pieces = ["http://", "https://", "localhost:", "127.0.0.1:", "[::1]", "example.com", "/", "?", "#", "(", ")", "[", "]", ".", ",", " ", "\t", "\u001b[1m", "\u0000", "çğış", "漢字", "😀", "%", "%zz", "@", ":", "3000", "//", "\\", "'", '"', "<", ">", "│", "\u202e", "a".repeat(40)];
    let seed = 20261118;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 3000; i++) {
      const text = Array.from({ length: 1 + Math.floor(rnd() * 14) }, () => pieces[Math.floor(rnd() * pieces.length)]).join("");
      const links = findLinks(text);
      let last = 0;
      for (const l of links) {
        expect(l.start).toBeGreaterThanOrEqual(last);
        expect(l.end).toBeGreaterThan(l.start);
        expect(text.slice(l.start, l.end)).toBe(l.text);
        expect(parseLinkTarget(l.url).kind).toBe("web");
        expect(/[\s\u0000-\u001f\u007f\u202e]/.test(l.text)).toBe(false);
        last = l.end;
      }
    }
  });
});

describe("deceptiveLinkText (OSC 8: the text shown is not where the link goes)", () => {
  it.each([
    ["https://ornek.example/giris", "https://kotu.example/giris", "https://ornek.example/giris"],
    ["ornek.example", "https://kotu.example/", "https://ornek.example/"],
    ["www.banka.example/giris", "http://127.0.0.1:9/x", "https://www.banka.example/giris"],
    ["Git: https://ornek.example/a (tıkla)", "https://kotu.example/a", "https://ornek.example/a"],
    ["localhost:3000", "https://kotu.example/", "http://localhost:3000/"],
    ["https://ornek.example:8443/", "https://ornek.example/", "https://ornek.example:8443/"],
  ])("%j → %s is deceptive", (shown, target, shownUrl) => expect(deceptiveLinkText(shown, target)).toBe(shownUrl));

  it.each([
    ["Belgeler", "https://docs.example/a"],
    ["buraya tıkla", "https://docs.example/a"],
    ["", "https://docs.example/a"],
    ["https://docs.example/a", "https://docs.example/a"],
    ["https://docs.example/a", "https://docs.example/a?utm=1"],
    ["https://DOCS.example", "https://docs.example/uzun/yol"],
    ["docs.example", "https://docs.example/uzun/yol"],
    // A long address shown over several rows: each row holds only a piece of the same address.
    ["https://docs.exa", "https://docs.example/uzun/yol"],
    ["mple/uzun/yol", "https://docs.example/uzun/yol"],
    ["v1.2.3", "https://docs.example/surum"],
    ["dosya.txt", "https://docs.example/dosya.txt"],
  ])("%j → %s is not", (shown, target) => expect(deceptiveLinkText(shown, target)).toBeNull());

  it("says nothing about targets that are not opened anyway", () => {
    expect(deceptiveLinkText("https://ornek.example/", "javascript:alert(1)")).toBeNull();
    expect(deceptiveLinkText("https://ornek.example/", "file:///etc/passwd")).toBeNull();
  });
});

describe("createRateLimiter", () => {
  it("allows `max` actions per window and at most one per `minIntervalMs`", () => {
    let now = 1000;
    const limiter = createRateLimiter({ max: 3, windowMs: 10_000, minIntervalMs: 200, now: () => now });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false); // too soon after the last one
    now += 200;
    expect(limiter.allow()).toBe(true);
    now += 200;
    expect(limiter.allow()).toBe(true);
    now += 200;
    expect(limiter.allow()).toBe(false); // the window is full
    now += 10_000;
    expect(limiter.allow()).toBe(true);
  });

  it("a refused action does not count", () => {
    let now = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, minIntervalMs: 0, now: () => now });
    expect(limiter.allow()).toBe(true);
    for (let i = 0; i < 50; i++) expect(limiter.allow()).toBe(false);
    now = 1000;
    expect(limiter.allow()).toBe(true);
  });
});
