// @vitest-environment node
// Bağlantılar — main side: the only place that hands an address to the operating system. Everything arriving here
// is untrusted IPC input: only http(s) leaves, normalized, and not too often.
import { describe, expect, it, vi } from "vitest";
import { t as msg } from "../i18n/index.ts";
import { linksConfig, type LinksConfig } from "../renderer/engine/links-ipc.ts";
import { createExternalOpener, createLinksHost, EXTERNAL_OPEN_TEST_ENV, LinkError, linkMenuTemplate, linksEnv, pathMenuTemplate } from "./links-host.ts";

const cfg: LinksConfig = { ...linksConfig, rate: { max: 3, windowMs: 10_000, minIntervalMs: 100 }, menuCloseGraceMs: 50, menuTargetMaxChars: 48 };

interface Item {
  label?: string;
  type?: string;
  enabled?: boolean;
  click?: () => void;
}

function host(config: LinksConfig = cfg) {
  let now = 1_000;
  const opened: string[] = [];
  const written: string[] = [];
  const popups: { template: Item[]; onClose: () => void }[] = [];
  const timers: (() => void)[] = [];
  const h = createLinksHost({
    config,
    openExternal: async (url) => void opened.push(url),
    write: (text) => void written.push(text),
    popup: (template, onClose) => void popups.push({ template: template as Item[], onClose }),
    now: () => now,
    defer: (fn) => void timers.push(fn),
  });
  return { h, opened, written, popups, advance: (ms: number) => (now += ms), runTimers: () => timers.splice(0).forEach((fn) => fn()) };
}
const labels = (t: Item[]): (string | undefined)[] => t.map((i) => (i.type === "separator" ? "—" : i.label));

describe("createLinksHost.openExternal", () => {
  it("opens an http(s) address, as the URL parser normalizes it", async () => {
    const t = host();
    await t.h.openExternal("HTTPS://Example.com/a b".replace(" ", "%20"));
    t.advance(200);
    await t.h.openExternal("http://localhost:3000");
    expect(t.opened).toEqual(["https://example.com/a%20b", "http://localhost:3000/"]);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "vscode://file/x",
    "mailto:a@example.com",
    "x-apple.systempreferences:com.apple.preference.security",
    "about:blank",
    "data:text/html,x",
    "smb://sunucu/paylasim",
    "tel:+905550000000",
    "https://user:pw@example.com/",
    "https://example.com/\nhttps://evil.example/",
    " https://example.com/",
    "example.com",
    "",
  ])("never hands %j to the operating system", async (raw) => {
    const t = host();
    await expect(t.h.openExternal(raw)).rejects.toThrow(LinkError);
    expect(t.opened).toEqual([]);
  });

  it("refuses anything that is not a string", async () => {
    const t = host();
    for (const bad of [undefined, null, 1, {}, ["https://example.com/"], { url: "https://example.com/" }, true]) {
      await expect(t.h.openExternal(bad)).rejects.toThrow(LinkError);
    }
    expect(t.opened).toEqual([]);
  });

  it("limits how often: a burst opens `rate.max` addresses at most, each at least `minIntervalMs` apart", async () => {
    const t = host();
    await t.h.openExternal("https://example.com/1");
    await expect(t.h.openExternal("https://example.com/2")).rejects.toThrow(msg("links.text.rateLimited"));
    for (const n of [3, 4]) {
      t.advance(100);
      await t.h.openExternal(`https://example.com/${n}`);
    }
    t.advance(100);
    await expect(t.h.openExternal("https://example.com/5")).rejects.toThrow(msg("links.text.rateLimited"));
    expect(t.opened).toEqual(["https://example.com/1", "https://example.com/3", "https://example.com/4"]);
    t.advance(cfg.rate.windowMs);
    await t.h.openExternal("https://example.com/6");
    expect(t.opened).toHaveLength(4);
  });

  it("a refused address does not use up the allowance", async () => {
    const t = host();
    for (let i = 0; i < 20; i++) await expect(t.h.openExternal("javascript:1")).rejects.toThrow(LinkError);
    await t.h.openExternal("https://example.com/");
    expect(t.opened).toEqual(["https://example.com/"]);
  });

  it("checkWeb returns the normalized address under the same rules (used before a local Chrome is started)", () => {
    const t = host();
    expect(t.h.checkWeb("http://LOCALHOST:3000/x")).toBe("http://localhost:3000/x");
    expect(() => t.h.checkWeb("http://localhost:3000/y")).toThrow(msg("links.text.rateLimited"));
    t.advance(200);
    expect(() => t.h.checkWeb("file:///x")).toThrow(LinkError);
    expect(() => t.h.checkWeb(undefined)).toThrow(LinkError);
  });
});

describe("linkMenuTemplate", () => {
  const noop = (): void => {};

  it("a web link in a project with a browser: the real target, then open here / open in the default browser / copy", () => {
    const t = linkMenuTemplate({ url: "https://example.com/yol?x=1", browser: true }, cfg, noop) as Item[];
    expect(labels(t)).toEqual(["https://example.com/yol?x=1", "—", msg("links.labels.openBrowser"), msg("links.labels.openExternal"), msg("links.labels.copyLink")]);
    expect(t[0]!.enabled).toBe(false);
  });

  it("without a project browser (SSH, app-only) there is no “Tarayıcıda aç”", () => {
    const t = linkMenuTemplate({ url: "https://example.com/", browser: false }, cfg, noop) as Item[];
    expect(labels(t)).toEqual(["https://example.com/", "—", msg("links.labels.openExternal"), msg("links.labels.copyLink")]);
  });

  it("the first line is the REAL target, normalized and shortened — whatever the link's text said", () => {
    const t = linkMenuTemplate({ url: `https://xn--bcher-kva.example/${"a".repeat(200)}/son`, browser: true }, cfg, noop) as Item[];
    expect(t[0]!.label!.startsWith("https://xn--bcher-kva.example/")).toBe(true);
    expect(t[0]!.label!.length).toBeLessThanOrEqual(cfg.menuTargetMaxChars);
    expect(t[0]!.label!.endsWith("/son")).toBe(true);
  });

  it.each(["file:///tmp/a.txt", "vscode://file/tmp/a.ts", "javascript:alert(1)", "mailto:a@example.com", "https://user:pw@example.com/", "example.com/yol"])(
    "%s can only be copied",
    (url) => {
      const t = linkMenuTemplate({ url, browser: true }, cfg, noop) as Item[];
      expect(labels(t).slice(-1)).toEqual([msg("links.labels.copyLink")]);
      expect(labels(t)).not.toContain(msg("links.labels.openBrowser"));
      expect(labels(t)).not.toContain(msg("links.labels.openExternal"));
    },
  );

  it.each(["", "https://example.com/\u0000", "https://exa mple.com/", "vscode://x\u001b[31m", `https://example.com/${"a".repeat(9000)}`])("no menu at all for %j", (url) => {
    expect(linkMenuTemplate({ url, browser: true }, cfg, noop)).toEqual([]);
  });
});

describe("createLinksHost.menu", () => {
  it("resolves with the item the user chose; opening is left to the renderer", async () => {
    const t = host();
    const chosen = t.h.menu({ url: "https://example.com/a", browser: true });
    expect(t.popups).toHaveLength(1);
    t.popups[0]!.template.find((i) => i.label === msg("links.labels.openBrowser"))!.click!();
    expect(await chosen).toBe("browser");
    const second = t.h.menu({ url: "https://example.com/a", browser: true });
    t.popups[1]!.template.find((i) => i.label === msg("links.labels.openExternal"))!.click!();
    expect(await second).toBe("external");
    expect(t.opened).toEqual([]);
    expect(t.written).toEqual([]);
  });

  it("“Bağlantıyı kopyala” writes the normalized target to the clipboard, here in main", async () => {
    const t = host();
    const chosen = t.h.menu({ url: "HTTPS://Example.com/a", browser: true });
    t.popups[0]!.template.find((i) => i.label === msg("links.labels.copyLink"))!.click!();
    expect(await chosen).toBe("copy");
    expect(t.written).toEqual(["https://example.com/a"]);
  });

  it("a link that is never opened is copied as it was written", async () => {
    const t = host();
    const chosen = t.h.menu({ url: "vscode://file/tmp/a.ts", browser: true });
    t.popups[0]!.template.find((i) => i.label === msg("links.labels.copyLink"))!.click!();
    expect(await chosen).toBe("copy");
    expect(t.written).toEqual(["vscode://file/tmp/a.ts"]);
  });

  it("closing the menu without choosing resolves with null — but a click arriving right after the close still counts", async () => {
    const t = host();
    const dismissed = t.h.menu({ url: "https://example.com/a", browser: true });
    t.popups[0]!.onClose();
    t.runTimers();
    expect(await dismissed).toBeNull();

    // macOS reports the close before it delivers the chosen item's click.
    const late = t.h.menu({ url: "https://example.com/a", browser: true });
    t.popups[1]!.onClose();
    t.popups[1]!.template.find((i) => i.label === msg("links.labels.openBrowser"))!.click!();
    t.runTimers();
    expect(await late).toBe("browser");
  });

  it("refuses malformed requests and unusable addresses without showing a menu", async () => {
    const t = host();
    const bad: unknown[] = [undefined, null, "https://example.com/", 5, [], {}, { url: 5, browser: true }, { url: "https://example.com/", browser: "yes" }, { url: "", browser: true }, { url: "https://example.com/\u0007", browser: true }];
    for (const req of bad) await expect(t.h.menu(req)).rejects.toThrow(LinkError);
    expect(t.popups).toEqual([]);
  });
});

describe("createExternalOpener (tests never open the user's real default browser)", () => {
  it("normally hands the address to the shell", async () => {
    const shell = vi.fn(async () => {});
    const opener = createExternalOpener({ env: {}, openExternal: shell });
    await opener.open("https://example.com/");
    expect(shell).toHaveBeenCalledWith("https://example.com/");
    expect(opener.recorded).toBeUndefined();
  });

  it("with the test switch it records instead of opening", async () => {
    const shell = vi.fn(async () => {});
    const opener = createExternalOpener({ env: { [EXTERNAL_OPEN_TEST_ENV]: "record" }, openExternal: shell });
    await opener.open("https://example.com/a");
    await opener.open("https://example.com/b");
    expect(shell).not.toHaveBeenCalled();
    expect(opener.recorded).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("a packaged app ignores the switch", () => {
    expect(linksEnv({ [EXTERNAL_OPEN_TEST_ENV]: "record", HOME: "/h" }, true)).toEqual({ HOME: "/h" });
    expect(linksEnv({ [EXTERNAL_OPEN_TEST_ENV]: "record" }, false)).toEqual({ [EXTERNAL_OPEN_TEST_ENV]: "record" });
  });
});

// ---- Yollar: the menu of a file path ----

describe("pathMenuTemplate / createLinksHost.menu: dosya yolu", () => {
  const noop = (): void => {};
  const PATH = "/Users/ada/Documents/Acme-ux-2026-11-05/index.html";

  it("the path first (disabled), then only what the engine offers, then “Yolu kopyala”", () => {
    const all = pathMenuTemplate({ path: PATH, browser: true, files: true }, cfg, noop) as Item[];
    expect(labels(all).slice(1)).toEqual(["—", msg("links.labels.openBrowser"), msg("links.labels.showInFiles"), msg("links.labels.copyPath")]);
    expect(all[0]!.enabled).toBe(false);
    expect(all[0]!.label!.length).toBeLessThanOrEqual(cfg.menuTargetMaxChars);
    expect(all[0]!.label!.endsWith("/index.html")).toBe(true);
    expect(labels(pathMenuTemplate({ path: "src/a.ts", browser: false, files: true }, cfg, noop) as Item[])).toEqual(["src/a.ts", "—", msg("links.labels.showInFiles"), msg("links.labels.copyPath")]);
    expect(labels(pathMenuTemplate({ path: "~/a.zip", browser: false, files: false }, cfg, noop) as Item[])).toEqual(["~/a.zip", "—", msg("links.labels.copyPath")]);
    // Never the default browser, never an address item: a path is not handed to the operating system.
    expect(labels(all)).not.toContain(msg("links.labels.openExternal"));
    expect(labels(all)).not.toContain(msg("links.labels.copyLink"));
  });

  it.each(["", "~/a\u0000b", "~/a\u001b[31m.html", "~/a‮/b.html", "~/a\nb", `/${"a".repeat(5000)}`])("no menu at all for %j", (path) => {
    expect(pathMenuTemplate({ path, browser: true, files: true }, cfg, noop)).toEqual([]);
  });

  it("resolves with the choice; “Yolu kopyala” writes the path itself; nothing is ever opened here", async () => {
    const t = host();
    const first = t.h.menu({ path: PATH, browser: true, files: true });
    t.popups[0]!.template.find((i) => i.label === msg("links.labels.openBrowser"))!.click!();
    expect(await first).toBe("browser");
    const second = t.h.menu({ path: PATH, browser: true, files: true });
    t.popups[1]!.template.find((i) => i.label === msg("links.labels.showInFiles"))!.click!();
    expect(await second).toBe("files");
    const third = t.h.menu({ path: "~/Belgeler/Yeni Klasör/a b.html", browser: false, files: false });
    t.popups[2]!.template.find((i) => i.label === msg("links.labels.copyPath"))!.click!();
    expect(await third).toBe("copy");
    expect(t.written).toEqual(["~/Belgeler/Yeni Klasör/a b.html"]);
    expect(t.opened).toEqual([]);
  });

  it.each([
    ["both a path and an address", { path: "/a/b", url: "https://example.com/", browser: true, files: true }],
    ["a path without the files flag", { path: "/a/b", browser: true }],
    ["a non-string path", { path: 7, browser: true, files: true }],
    ["a path with control characters", { path: "/a\u0007/b", browser: true, files: true }],
  ])("refuses %s", async (_n, request) => {
    const t = host();
    await expect(t.h.menu(request)).rejects.toBeInstanceOf(LinkError);
    expect(t.popups).toEqual([]);
  });
});
