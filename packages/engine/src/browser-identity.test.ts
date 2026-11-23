import { describe, expect, it } from "vitest";
import type { CdpConnection, CdpListener } from "./cdp.ts";
import { applyIdentity, identityFromProbe, parseDevToolsActivePort, type ChromeProbe } from "./browser-identity.ts";

// What a headless Chrome (157, Apple Silicon, macOS 14.7.8) reports of itself, measured with no override.
const HEADLESS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.0.0 Safari/537.36";
const NORMAL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const BRANDS = [
  { brand: "Not-A.Brand", version: "99" },
  { brand: "Google Chrome", version: "157" },
  { brand: "Chromium", version: "157" },
];
const FULL = [
  { brand: "Not-A.Brand", version: "99.0.0.0" },
  { brand: "Google Chrome", version: "157.0.8103.79" },
  { brand: "Chromium", version: "157.0.8103.79" },
];
const probe = (data: Record<string, unknown> | undefined, over: Partial<ChromeProbe> = {}): ChromeProbe => ({
  product: "Chrome/157.0.8103.79",
  userAgent: HEADLESS_UA,
  platform: "MacIntel",
  data,
  ...over,
});
const HIGH = {
  brands: BRANDS,
  mobile: false,
  platform: "macOS",
  architecture: "arm",
  bitness: "64",
  model: "",
  platformVersion: "14.7.8",
  fullVersionList: FULL,
  uaFullVersion: "157.0.8103.79",
  wow64: false,
  formFactors: ["Desktop"],
};

describe("identityFromProbe", () => {
  it("is Chrome's own identity with only the Headless token dropped", () => {
    const id = identityFromProbe(probe(HIGH));
    expect(id).toEqual({
      product: "Chrome/157.0.8103.79",
      userAgent: NORMAL_UA,
      platform: "MacIntel",
      userAgentMetadata: {
        brands: BRANDS,
        fullVersionList: FULL,
        fullVersion: "157.0.8103.79",
        platform: "macOS",
        platformVersion: "14.7.8",
        architecture: "arm",
        model: "",
        mobile: false,
        bitness: "64",
        wow64: false,
        formFactors: ["Desktop"],
      },
    });
  });

  it("drops a Headless brand (older headless Chrome) and keeps the GREASE brand Chrome made", () => {
    const brands = [{ brand: "Chromium", version: "120" }, { brand: "HeadlessChrome", version: "120" }, { brand: "Not_A Brand", version: "8" }];
    const full = [{ brand: "Chromium", version: "120.0.6099.5" }, { brand: "HeadlessChrome", version: "120.0.6099.5" }, { brand: "Not_A Brand", version: "8.0.0.0" }];
    const id = identityFromProbe(probe({ ...HIGH, brands, fullVersionList: full, uaFullVersion: "120.0.6099.5" }, { product: "HeadlessChrome/120.0.6099.5" }));
    expect(id?.userAgentMetadata?.brands).toEqual([brands[0], brands[2]]);
    expect(id?.userAgentMetadata?.fullVersionList).toEqual([full[0], full[2]]);
    expect(id?.product).toBe("HeadlessChrome/120.0.6099.5");
  });

  it("never empties a value the probe had; derives an empty fullVersionList from the brands and Chrome's full version", () => {
    const id = identityFromProbe(probe({ ...HIGH, fullVersionList: [], uaFullVersion: undefined }));
    expect(id?.userAgentMetadata).toMatchObject({ architecture: "arm", bitness: "64", platformVersion: "14.7.8", fullVersionList: FULL, fullVersion: "157.0.8103.79" });
  });

  it("missing high-entropy values stay empty (never invented); odd types are ignored", () => {
    const id = identityFromProbe(probe({ brands: BRANDS, mobile: false, platform: "macOS", architecture: 7, bitness: null, wow64: "no" }));
    expect(id?.userAgentMetadata).toMatchObject({ architecture: "", bitness: "", platformVersion: "", model: "", wow64: false, platform: "macOS", fullVersionList: FULL });
    expect(id?.userAgentMetadata).not.toHaveProperty("formFactors");
  });

  it("no userAgentData (not a secure page, old Chrome): the User-Agent only", () => {
    expect(identityFromProbe(probe(undefined))).toEqual({ product: "Chrome/157.0.8103.79", userAgent: NORMAL_UA, platform: "MacIntel" });
    expect(identityFromProbe(probe({ brands: "x" }))?.userAgentMetadata).toBeUndefined();
    expect(identityFromProbe(probe({ ...HIGH, brands: [{ brand: "HeadlessChrome", version: "157" }] }))?.userAgentMetadata).toBeUndefined();
  });

  it("refuses text that cannot go into a header or is not Chrome's", () => {
    expect(identityFromProbe(probe(HIGH, { userAgent: "Mozilla/5.0 Firefox/1" }))).toBeNull();
    expect(identityFromProbe(probe(HIGH, { userAgent: `${NORMAL_UA}\r\nX: y` }))).toBeNull();
    expect(identityFromProbe(probe(HIGH, { userAgent: "x".repeat(600) + " Chrome/1" }))).toBeNull();
    expect(identityFromProbe(probe(HIGH, { userAgent: 5 as unknown as string }))).toBeNull();
    const bad = identityFromProbe(probe({ ...HIGH, brands: [{ brand: "A\nB", version: "1" }, ...BRANDS], fullVersionList: [{ brand: "x", version: "1;2" }, ...FULL] }));
    expect(bad?.userAgentMetadata?.brands).toEqual(BRANDS);
    expect(bad?.userAgentMetadata?.fullVersionList).toEqual(FULL);
    expect(identityFromProbe(probe(HIGH, { platform: "Mac\u0000" }))?.platform).toBeUndefined();
  });
});

describe("parseDevToolsActivePort", () => {
  it("reads Chrome's port file", () => {
    expect(parseDevToolsActivePort("51234\n/devtools/browser/ab-12\n")).toEqual({ port: 51234, path: "/devtools/browser/ab-12" });
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort("0\n/devtools/browser/x")).toBeNull();
    expect(parseDevToolsActivePort("80\n/../x")).toBeNull();
    expect(parseDevToolsActivePort("80\nhttp://evil/devtools/browser/x")).toBeNull();
  });
});

function fakeCdp() {
  const sent: [string, Record<string, unknown> | undefined, string | undefined][] = [];
  let listener: CdpListener | undefined;
  const cdp = {
    send: (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      sent.push([method, params, sessionId]);
      return Promise.resolve({});
    },
    on: (l: CdpListener) => {
      listener = l;
      return () => (listener = undefined);
    },
  } as unknown as CdpConnection;
  return { cdp, sent, emit: (m: string, p: Record<string, unknown>, s?: string) => listener?.(m, p, s) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("applyIdentity", () => {
  const id = identityFromProbe(probe(HIGH))!;
  const override = { userAgent: id.userAgent, platform: id.platform, userAgentMetadata: id.userAgentMetadata };

  it("auto-attaches every target paused; each gets the override (then its children are attached) before it runs", async () => {
    const f = fakeCdp();
    await applyIdentity(f.cdp, id, () => {}, 1000);
    expect(f.sent).toEqual([["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, undefined]]);
    f.sent.length = 0;
    f.emit("Target.attachedToTarget", { sessionId: "s1", targetInfo: { targetId: "t1", type: "page" }, waitingForDebugger: true });
    await tick();
    expect(f.sent).toEqual([
      ["Network.setUserAgentOverride", override, "s1"],
      ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, "s1"],
      ["Runtime.runIfWaitingForDebugger", {}, "s1"],
    ]);
    f.sent.length = 0;
    f.emit("Target.attachedToTarget", { sessionId: "s2", targetInfo: { targetId: "w1", type: "service_worker" }, waitingForDebugger: true }, "s1");
    await tick();
    expect(f.sent).toEqual([
      ["Network.setUserAgentOverride", override, "s2"],
      ["Runtime.runIfWaitingForDebugger", {}, "s2"],
    ]);
  });

  it("another session on a target already covered (a panel's tab session) only gets the override", async () => {
    const f = fakeCdp();
    await applyIdentity(f.cdp, id, () => {}, 1000);
    f.emit("Target.attachedToTarget", { sessionId: "s1", targetInfo: { targetId: "t1", type: "page" } });
    await tick();
    f.sent.length = 0;
    f.emit("Target.attachedToTarget", { sessionId: "live", targetInfo: { targetId: "t1", type: "page" } });
    await tick();
    expect(f.sent.map((s) => s[0])).toEqual(["Network.setUserAgentOverride", "Runtime.runIfWaitingForDebugger"]);
    // Once ours is gone, the next session covers the target again.
    f.emit("Target.detachedFromTarget", { sessionId: "s1", targetId: "t1" });
    f.sent.length = 0;
    f.emit("Target.attachedToTarget", { sessionId: "s3", targetInfo: { targetId: "t1", type: "page" } });
    await tick();
    expect(f.sent.map((s) => s[0])).toEqual(["Network.setUserAgentOverride", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
  });

  it("a failing override still lets the target run", async () => {
    const f = fakeCdp();
    const warns: string[] = [];
    await applyIdentity(f.cdp, id, (msg) => warns.push(msg), 1000);
    const send = f.cdp.send.bind(f.cdp);
    (f.cdp as { send: CdpConnection["send"] }).send = ((m: string, p?: Record<string, unknown>, s?: string) =>
      m === "Network.setUserAgentOverride" ? Promise.reject(new Error("gone")) : send(m, p, s)) as CdpConnection["send"];
    f.sent.length = 0;
    f.emit("Target.attachedToTarget", { sessionId: "s9", targetInfo: { targetId: "t9", type: "other" } });
    await tick();
    expect(f.sent.map((s) => s[0])).toContain("Runtime.runIfWaitingForDebugger");
    expect(warns.length).toBe(1);
  });

  it("navigate: a tab the engine opens loads its address only once its override is in place (from its first request)", async () => {
    const f = fakeCdp();
    const handle = await applyIdentity(f.cdp, id, () => {}, 1000);
    f.sent.length = 0;
    // Chrome may answer Target.createTarget before it reports the attach: navigate waits for it.
    const nav = handle.navigate("t5", "http://127.0.0.1:1/a");
    await tick();
    expect(f.sent).toEqual([]);
    f.emit("Target.attachedToTarget", { sessionId: "s5", targetInfo: { targetId: "t5", type: "page" }, waitingForDebugger: true });
    await nav;
    expect(f.sent.map((s) => s[0])).toEqual(["Network.setUserAgentOverride", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger", "Page.navigate"]);
    expect(f.sent.at(-1)).toEqual(["Page.navigate", { url: "http://127.0.0.1:1/a" }, "s5"]);
    // Already covered: at once.
    await handle.navigate("t5", "http://127.0.0.1:1/b");
    expect(f.sent.at(-1)).toEqual(["Page.navigate", { url: "http://127.0.0.1:1/b" }, "s5"]);
  });

  it("navigate gives up when the target never shows up", async () => {
    const f = fakeCdp();
    const handle = await applyIdentity(f.cdp, id, () => {}, 20);
    await expect(handle.navigate("nope", "http://127.0.0.1:1/a")).rejects.toThrow();
  });

  it("ignores malformed events", async () => {
    const f = fakeCdp();
    await applyIdentity(f.cdp, id, () => {}, 1000);
    f.sent.length = 0;
    f.emit("Target.attachedToTarget", { sessionId: 5 });
    f.emit("Target.attachedToTarget", {});
    await tick();
    expect(f.sent).toEqual([]);
  });
});
