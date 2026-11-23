// @vitest-environment node
// Kendini güncelleme — everything the engine says is untrusted input, also on the authenticated socket: a
// compromised or buggy engine must not be able to name a file outside the staging folder, send the download to
// another host, or have a bomb unpacked.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type BuildInfo } from "@kokpit/shared";
import { entriesSha256 } from "@kokpit/shared/update-signing";
import { DEFAULT_UPDATE_CONFIG as cfg } from "./config.ts";
import { downloadArchive } from "./download.ts";
import { stagingChild } from "./install.ts";
import type { EngineSession } from "./session.ts";
import { freshState, memoryStateStore } from "./state.ts";
import { archiveUrl, parseCheckResult, parseDownloadResult as parseDownload, UntrustedError } from "./untrusted.ts";
import { createUpdater } from "./updater.ts";

const ORIGIN = "http://100.64.0.1:7420";
const TOKEN = "t".repeat(43);
const A = "0.1.0+20261118100000.aaa";
const B = "0.1.0+20261118110000.bbb";
const build = (buildId: string): BuildInfo => ({ buildId, version: "0.1.0", commit: "abc", builtAt: "2026-11-18T10:00:00.000Z" });
const ENTRIES = [
  { path: "Contents", type: "dir" },
  { path: "Contents/Info.plist", type: "file", mode: 0o644, size: 3000, sha256: "b".repeat(64) },
];
const manifest = (over: Record<string, unknown> = {}) => ({
  buildId: B,
  version: "0.1.0",
  format: 1 as const,
  bundleName: "Kokpit.app",
  sha256: "a".repeat(64),
  size: 1000,
  unpackedSize: 3000,
  entryCount: 2,
  createdAt: "2026-11-18T12:00:00.000Z",
  entriesSha256: entriesSha256(ENTRIES)!,
  signingKeyId: "c".repeat(16),
  signature: `${"A".repeat(86)}==`,
  ...over,
});
const checkResult = (update: unknown) => ({ engine: { build: build("0.1.0+20261118090000.eng"), protocol: PROTOCOL_VERSION }, update });

describe("the check answer", () => {
  it("a well-formed answer passes; no update is null", () => {
    expect(parseCheckResult(checkResult(manifest()), cfg).update).toEqual(manifest());
    expect(parseCheckResult(checkResult(null), cfg).update).toBeNull();
  });

  it.each([
    ["parent traversal", { buildId: "../../Library/LaunchAgents/evil" }],
    ["a path", { buildId: "a/b" }],
    ["absolute path", { buildId: "/tmp/evil" }],
    ["dot-dot inside", { buildId: "1..2" }],
    ["leading dot", { buildId: ".hidden" }],
    ["backslash", { buildId: "a\\b" }],
    ["NUL", { buildId: "a\0b" }],
    ["newline (log line / helper file name)", { buildId: "a\nb" }],
    ["space", { buildId: "a b" }],
    ["shell text", { buildId: "$(touch /tmp/x)" }],
    ["too long", { buildId: "a".repeat(121) }],
    ["empty", { buildId: "" }],
    ["not a string", { buildId: 5 }],
    ["hash not hex", { sha256: "z".repeat(64) }],
    ["hash too short", { sha256: "ab" }],
    ["size zero", { size: 0 }],
    ["size negative", { size: -1 }],
    ["size not an integer", { size: 1.5 }],
    ["size over the cap", { size: cfg.maxArchiveBytes + 1 }],
    ["version with a path", { version: "../1" }],
    ["version with markup", { version: "<b>1</b>" }],
    ["version too long", { version: "1".repeat(61) }],
    ["an unknown format", { format: 2 }],
    ["no format", { format: undefined }],
    ["a bundle name that is a path", { bundleName: "../Evil.app" }],
    ["a bundle name outside the plain alphabet", { bundleName: "Kökpit.app" }],
    ["a bundle name that is no .app", { bundleName: "Kokpit" }],
    ["an unpacked size over the cap", { unpackedSize: cfg.maxUnpackedBytes + 1 }],
    ["more entries than the cap", { entryCount: cfg.maxBundleFiles + 1 }],
    ["a negative unpacked size", { unpackedSize: -1 }],
  ])("refuses a manifest with %s", (_n, patch) => {
    expect(() => parseCheckResult(checkResult(manifest(patch)), cfg)).toThrow(UntrustedError);
  });

  it.each([["a string", "x"], ["an array", []], ["no engine", { update: null }], ["null", null]])("refuses %s as the answer", (_n, raw) => {
    expect(() => parseCheckResult(raw, cfg)).toThrow(UntrustedError);
  });
});

describe("the download answer", () => {
  const good = { path: `/app-updates/${TOKEN}`, size: 1000, sha256: "a".repeat(64), expiresAt: "2026-11-18T12:10:00.000Z", entries: ENTRIES };
  const parseDownloadResult = (raw: unknown, m: ReturnType<typeof manifest>) => parseDownload(raw, m, cfg);

  it("the expected route on the engine's own origin becomes the URL", () => {
    expect(archiveUrl(ORIGIN, parseDownloadResult(good, manifest()).path)).toBe(`${ORIGIN}/app-updates/${TOKEN}`);
    expect(archiveUrl("https://mini.tail1234.ts.net", good.path)).toBe(`https://mini.tail1234.ts.net/app-updates/${TOKEN}`);
  });

  it.each([
    ["another host (protocol-relative)", `//evil.example/app-updates/${TOKEN}`],
    ["an absolute URL", `http://evil.example/app-updates/${TOKEN}`],
    ["an absolute URL to a metadata address", "http://169.254.169.254/latest/meta-data"],
    ["userinfo trick", `@evil.example/app-updates/${TOKEN}`],
    ["backslashes", `\\\\evil.example\\app-updates\\${TOKEN}`],
    ["backslash after the slash", `/\\evil.example/app-updates/${TOKEN}`],
    ["another route", "/health"],
    ["the media route", `/files/media/${TOKEN}`],
    ["traversal out of the route", `/app-updates/../files/media/${TOKEN}`],
    ["encoded traversal", `/app-updates/%2e%2e/${TOKEN}`],
    ["encoded slash", `/app-updates/${TOKEN}%2f..`],
    ["a query", `/app-updates/${TOKEN}?next=http://evil.example`],
    ["a fragment", `/app-updates/${TOKEN}#x`],
    ["a suffix", `/app-updates/${TOKEN}/more`],
    ["a short token", "/app-updates/abc"],
    ["whitespace", ` /app-updates/${TOKEN}`],
    ["a tab inside", `/app-up\tdates/${TOKEN}`],
    ["a file URL", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["empty", ""],
  ])("refuses %s as the path", (_n, path) => {
    expect(() => parseDownloadResult({ ...good, path }, manifest())).toThrow(UntrustedError);
    expect(() => archiveUrl(ORIGIN, path)).toThrow(UntrustedError);
  });

  it("refuses a download that is not the manifest's archive (another size or hash)", () => {
    expect(() => parseDownloadResult({ ...good, size: 999 }, manifest())).toThrow(UntrustedError);
    expect(() => parseDownloadResult({ ...good, sha256: "b".repeat(64) }, manifest())).toThrow(UntrustedError);
    expect(() => parseDownloadResult({ ...good, path: 5 }, manifest())).toThrow(UntrustedError);
    expect(() => parseDownloadResult(null, manifest())).toThrow(UntrustedError);
  });

  it("the entry list is checked as a whole before anything is fetched: a path out of the bundle, a list that is not the manifest's", () => {
    const evil = [ENTRIES[0], { ...ENTRIES[1], path: "../../Library/LaunchAgents/evil.plist" }];
    expect(() => parseDownloadResult({ ...good, entries: evil }, manifest())).toThrow(UntrustedError);
    expect(() => parseDownloadResult({ ...good, entries: [ENTRIES[0]] }, manifest())).toThrow(UntrustedError);
    expect(() => parseDownloadResult({ ...good, entries: [ENTRIES[0], { ...ENTRIES[1], size: 2999 }] }, manifest())).toThrow(UntrustedError);
    // A list that is valid but not the signed one: refused before it is even looked at.
    const other = [ENTRIES[0], { ...ENTRIES[1], sha256: "d".repeat(64) }];
    expect(() => parseDownloadResult({ ...good, entries: other }, manifest())).toThrow("imzalı listeyle uyuşmuyor");
    expect(() => parseDownloadResult({ ...good, entries: "x" }, manifest())).toThrow(UntrustedError);
    expect(() => parseDownloadResult({ ...good, entries: undefined }, manifest())).toThrow(UntrustedError);
    expect(parseDownloadResult(good, manifest()).entries).toEqual(ENTRIES);
  });

  it("random junk never yields a URL on another origin", () => {
    const pieces = ["/", "//", "\\", "@", ":", "http:", "https:", "evil.example", "app-updates", TOKEN, "..", "%2e", "%2f", "?", "#", " ", "\t", "\n", "\0", "100.64.0.1:7420", "localhost"];
    let seed = 20261118;
    const rnd = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let i = 0; i < 3000; i++) {
      const path = Array.from({ length: 1 + rnd(6) }, () => pieces[rnd(pieces.length)]).join("");
      let url: string | undefined;
      try {
        url = archiveUrl(ORIGIN, path);
      } catch (err) {
        expect(err).toBeInstanceOf(UntrustedError);
        continue;
      }
      expect(url, path).toBe(`${ORIGIN}/app-updates/${TOKEN}`);
    }
  });
});

describe("paths under the staging folder", () => {
  const staging = "/Applications/.Kokpit-update";

  it("a validated build id is a direct child", () => {
    expect(stagingChild(staging, B)).toBe(`${staging}/${B}`);
    expect(stagingChild(staging, `${B}.zip.part`)).toBe(`${staging}/${B}.zip.part`);
  });

  it.each(["../evil", "..", ".", "", "a/b", "/etc/passwd", "a/../../b", "x\0y", "backup/../../x", "a\\b"])("refuses %j — whatever let it through upstream", (name) => {
    expect(() => stagingChild(staging, name)).toThrow(UntrustedError);
  });
});

describe("the updater refuses a hostile engine", () => {
  function hostile(answers: { check?: unknown; download?: unknown }) {
    const calls = { download: 0, verify: 0, urls: [] as string[], logs: [] as string[] };
    const session: EngineSession = {
      engine: { version: "0.1.0", build: build("0.1.0+20261118090000.eng"), protocol: PROTOCOL_VERSION },
      httpOrigin: ORIGIN,
      request: (async (method: string) => (method === "app.update.check" ? answers.check : method === "app.update.download" ? answers.download : {})) as EngineSession["request"],
      close() {},
    };
    const state = memoryStateStore(freshState());
    const updater = createUpdater({
      cfg,
      app: build(A),
      packaged: true,
      state,
      settings: async () => ({ url: "ws://100.64.0.1:7420", key: "k".repeat(20) }),
      connect: async () => session,
      transport: async () => ({ ok: true, via: "loopback" }),
      // The signature is not what these tests are about: every manifest counts as signed here.
      verifySignature: () => ({ ok: true }),
      download: async (_m, url) => {
        calls.download++;
        calls.urls.push(await url());
        return "/staging/x.zip.part";
      },
      verify: async () => {
        calls.verify++;
        return "/staging/x/Kokpit.app";
      },
      reverify: async () => true,
      inspect: async () => ({ ok: true }),
      stagedExists: () => true,
      otherInstances: async () => 0,
      startSwap: async () => {},
      helperResult: () => undefined,
      markHealthy: async () => {},
      cleanup: async () => {},
      now: () => Date.UTC(2026, 10, 18, 12, 0, 0), // the clock of the day the builds were made
      emit: () => {},
      log: (m, d) => void calls.logs.push(`${m} ${JSON.stringify(d ?? {})}`),
    });
    return { updater, calls, state };
  }

  it("a manifest whose build id is a path: nothing is downloaded, nothing staged, and the id is not echoed into the log", async () => {
    const evil = "../../Library/LaunchAgents/evil";
    const h = hostile({ check: checkResult(manifest({ buildId: evil })) });
    await h.updater.check();
    expect(h.calls.download).toBe(0);
    expect(h.state.get().pending).toBeUndefined();
    expect(h.updater.status().phase).toBe("idle");
    expect(h.updater.status().target).toBeUndefined();
    expect(h.calls.logs.join("\n")).not.toContain("LaunchAgents");
  });

  it("a download path that leaves the engine's origin: no request goes anywhere, nothing is verified or staged", async () => {
    const h = hostile({ check: checkResult(manifest()), download: { path: `//evil.example/app-updates/${TOKEN}`, size: 1000, sha256: "a".repeat(64), expiresAt: "x", entries: ENTRIES } });
    await h.updater.check();
    expect(h.calls.urls).toEqual([]);
    expect(h.calls.verify).toBe(0);
    expect(h.state.get().pending).toBeUndefined();
    expect(h.updater.status().phase).toBe("error");
  });

  it("an entry list with a path out of the bundle: no request for the blob, nothing verified or staged", async () => {
    const evil = [ENTRIES[0], { ...ENTRIES[1], path: "../../Library/LaunchAgents/evil.plist" }];
    const h = hostile({ check: checkResult(manifest()), download: { path: `/app-updates/${TOKEN}`, size: 1000, sha256: "a".repeat(64), expiresAt: "x", entries: evil } });
    await h.updater.check();
    expect(h.calls.urls).toEqual([]);
    expect(h.calls.verify).toBe(0);
    expect(h.state.get().pending).toBeUndefined();
    expect(h.calls.logs.join("\n")).not.toContain("LaunchAgents");
    expect(h.updater.status().message ?? "").not.toContain("LaunchAgents");
  });
});

describe("the download does not follow the engine elsewhere", () => {
  it("a redirect is not followed: the other server is never asked", async () => {
    let otherHits = 0;
    const other = http.createServer((_q, s) => {
      otherHits++;
      s.end("x".repeat(10));
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
    const first = http.createServer((_q, s) => s.writeHead(302, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/x` }).end());
    await new Promise<void>((r) => first.listen(0, "127.0.0.1", () => r()));
    const dir = mkdtempSync(join(tmpdir(), "kokpit-update-redirect-"));
    try {
      const url = `http://127.0.0.1:${(first.address() as AddressInfo).port}/app-updates/${TOKEN}`;
      await expect(downloadArchive({ url: async () => url, partPath: join(dir, "a.part"), size: 10, attempts: 2, idleTimeoutMs: 1000 })).rejects.toMatchObject({ code: "http" });
      expect(otherHits).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      first.close();
      other.close();
    }
  });
});
