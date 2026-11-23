// @vitest-environment node
// Plain http to a Tailscale-range address is loaded only while that exact address is VERIFIED to be in the user's
// tailnet. These tests never call the real Tailscale CLI: the status reader is a fake, and the CLI runner is
// exercised with small shell scripts in a temp folder.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipLiteralBytes } from "@kokpit/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webConfig } from "../renderer/engine/web-ipc.ts";
import { createTailnetStatusReader, createTailnetVerifier, parseTailnetStatus, tailnetAddressOf, type TailnetStatusReader } from "./tailnet.ts";

const NAS = "100.64.113.61";
const ip = (text: string): Uint8Array => ipLiteralBytes(text)!;
const status = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    Version: "1.90.6",
    BackendState: "Running",
    Self: { HostName: "mac-mini", TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::102"], Online: true },
    Peer: {
      "nodekey:aaaa": { HostName: "homeserver", TailscaleIPs: [NAS, "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240"], Online: true },
      "nodekey:bbbb": { HostName: "telefon", TailscaleIPs: ["100.64.9.9"], Online: false },
    },
    ...over,
  });
const cfg = { ...webConfig.httpTailnet, cacheMs: 5000 };

describe("parseTailnetStatus", () => {
  it("a running tailnet: the addresses of self and of every peer", () => {
    const parsed = parseTailnetStatus(status())!;
    expect(parsed.map((b) => b.join("."))).toContain("100.64.113.61");
    expect(parsed).toHaveLength(5);
  });

  it.each([
    ["stopped", status({ BackendState: "Stopped" })],
    ["needs login", status({ BackendState: "NeedsLogin" })],
    ["starting", status({ BackendState: "Starting" })],
    ["no state", JSON.stringify({ Self: { TailscaleIPs: [NAS] } })],
    ["state in another case", status({ BackendState: "running" })],
    ["not JSON", "Tailscale is stopped."],
    ["truncated JSON", status().slice(0, 80)],
    ["an array", "[]"],
    ["null", "null"],
    ["empty", ""],
  ])("%s → not verified at all", (_n, text) => expect(parseTailnetStatus(text)).toBeNull());

  it("junk inside a running status is skipped, never trusted", () => {
    const parsed = parseTailnetStatus(
      status({ Self: { TailscaleIPs: "100.64.1.2" }, Peer: { a: null, b: { TailscaleIPs: [7, null, "homeserver", "100.64.113.61.evil.example", "0144.0100.0161.075", NAS] }, c: "x" } }),
    )!;
    expect(parsed.map((b) => b.join("."))).toEqual(["100.64.113.61"]);
    expect(parseTailnetStatus(status({ Self: null, Peer: null }))).toEqual([]);
  });
});

describe("tailnetAddressOf", () => {
  it("names the address to verify for http sites in the Tailscale ranges only", () => {
    expect(tailnetAddressOf(cfg, "http://100.64.113.61:9119/")).toEqual(ip(NAS));
    expect(tailnetAddressOf(cfg, "http://[fd7a:115c:a1e0::1]:8787/")).toEqual(ip("[fd7a:115c:a1e0::1]"));
    // Loopback http needs no tailnet; https is not this rule's business.
    expect(tailnetAddressOf(cfg, "http://127.0.0.1:9119/")).toBeNull();
    expect(tailnetAddressOf(cfg, "http://[::1]/")).toBeNull();
    expect(tailnetAddressOf(cfg, "https://100.64.113.61/")).toBeNull();
    expect(tailnetAddressOf(cfg, "https://nas.tail1234.ts.net/")).toBeNull();
    expect(tailnetAddressOf(cfg, "not a url")).toBeNull();
  });
});

describe("createTailnetVerifier", () => {
  function setup(answers: (string | null | Error | Promise<string | null>)[]) {
    let now = 1_000_000;
    let reads = 0;
    const read: TailnetStatusReader = async () => {
      const a = answers[Math.min(reads++, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      return a;
    };
    const verifier = createTailnetVerifier({ config: cfg, read, now: () => now });
    return { verifier, reads: () => reads, advance: (ms: number) => (now += ms) };
  }

  it("running + the address is a peer's (or our own): verified", async () => {
    const { verifier } = setup([status()]);
    expect(await verifier.verify(ip(NAS))).toBe(true);
    expect(await verifier.verify(ip("100.64.1.2"))).toBe(true);
    expect(await verifier.verify(ip("[fd7a:115c:a1e0:ab12:4843:cd96:6258:b240]"))).toBe(true);
  });

  it("running + the address is in the CGNAT range but NOT in the tailnet: refused", async () => {
    const { verifier } = setup([status()]);
    expect(await verifier.verify(ip("100.64.113.62"))).toBe(false);
    expect(await verifier.verify(ip("100.64.0.1"))).toBe(false);
    expect(await verifier.verify(ip("[fd7a:115c:a1e0::dead]"))).toBe(false);
  });

  it.each([
    ["Tailscale stopped", status({ BackendState: "Stopped" })],
    ["CLI missing / unreadable", null],
    ["garbage output", "<html>captive portal</html>"],
    ["the reader throws (timeout)", new Error("timeout")],
  ])("fails closed: %s", async (_n, answer) => {
    const { verifier } = setup([answer]);
    expect(await verifier.verify(ip(NAS))).toBe(false);
  });

  it("caches the answer for a few seconds only, then asks again — in both directions", async () => {
    const { verifier, reads, advance } = setup([status(), status({ BackendState: "Stopped" }), status()]);
    expect(await verifier.verify(ip(NAS))).toBe(true);
    advance(cfg.cacheMs - 1);
    expect(await verifier.verify(ip(NAS))).toBe(true);
    expect(reads()).toBe(1);
    advance(2);
    expect(await verifier.verify(ip(NAS))).toBe(false); // Tailscale went down: no longer loaded
    expect(reads()).toBe(2);
    advance(cfg.cacheMs + 1);
    expect(await verifier.verify(ip(NAS))).toBe(true);
    expect(reads()).toBe(3);
  });

  it("invalidate() drops the cache at once (a failed load asks again)", async () => {
    const { verifier, reads } = setup([status(), status({ BackendState: "Stopped" })]);
    expect(await verifier.verify(ip(NAS))).toBe(true);
    verifier.invalidate();
    expect(await verifier.verify(ip(NAS))).toBe(false);
    expect(reads()).toBe(2);
  });

  it("simultaneous checks share one status read", async () => {
    let release!: (v: string) => void;
    const pending = new Promise<string>((r) => (release = r));
    const { verifier, reads } = setup([pending]);
    const all = Promise.all([verifier.verify(ip(NAS)), verifier.verify(ip(NAS)), verifier.verify(ip("100.1.1.1"))]);
    release(status());
    expect(await all).toEqual([true, true, false]);
    expect(reads()).toBe(1);
  });

  it("a read that started before invalidate() is not trusted afterwards", async () => {
    let release!: (v: string) => void;
    const stale = new Promise<string>((r) => (release = r));
    const { verifier } = setup([stale, status({ BackendState: "Stopped" })]);
    const first = verifier.verify(ip(NAS));
    verifier.invalidate();
    const second = verifier.verify(ip(NAS));
    release(status());
    expect(await second).toBe(false);
    await first;
    expect(await verifier.verify(ip(NAS))).toBe(false);
  });
});

describe("createTailnetStatusReader (fake CLIs, never the real one)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kokpit-tailnet-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  // The configured timeout (seconds) for every case; only the hanging-CLI case needs a short one. A 400 ms limit on
  // all of them failed under a full parallel run, where merely starting `sh` can take longer.
  const HANG_TIMEOUT_MS = 400;
  const reader = (binaries: string[], over: Partial<typeof cfg> = {}) => createTailnetStatusReader({ ...cfg, binaries, ...over });

  it("gives the CLI the configured environment: the app-bundled Tailscale binary acts as a CLI only when TERM is set (an app started from Finder has no TERM)", async () => {
    // Measured on macOS with Tailscale 1.104: without TERM it tries to start the GUI and prints an error instead of JSON.
    const cli = script("tailscale", 'if [ -z "$TERM" ]; then echo "The Tailscale GUI failed to start"; else printf \'{"term":"%s"}\' "$TERM"; fi');
    const saved = process.env.TERM;
    delete process.env.TERM;
    try {
      expect(await reader([cli])()).toBe(`{"term":"${cfg.env.TERM}"}`);
    } finally {
      if (saved !== undefined) process.env.TERM = saved;
    }
  });

  it("runs the first candidate that exists with the configured arguments and returns its output", async () => {
    const cli = script("tailscale", 'printf \'{"args":"%s"}\' "$*"');
    expect(await reader([join(dir, "yok"), cli])()).toBe('{"args":"status --json"}');
  });

  it("no candidate exists → null", async () => {
    expect(await reader([join(dir, "yok"), join(dir, "yok2")])()).toBeNull();
    expect(await reader([])()).toBeNull();
  });

  it("a CLI that fails, hangs or floods → null (and a later candidate is NOT tried in its place)", async () => {
    const good = script("good", "echo '{}'");
    expect(await reader([script("fail", "echo '{\"BackendState\":\"Running\"}'; exit 1"), good])()).toBeNull();
    expect(await reader([script("hang", "sleep 30"), good], { timeoutMs: HANG_TIMEOUT_MS })()).toBeNull();
    expect(await reader([script("flood", "yes x | head -c 200000"), good], { maxOutputBytes: 1000 })()).toBeNull();
  });
});
