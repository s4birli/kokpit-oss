// Gizli tarayıcı kimliği: a hidden (headless) Chrome presents itself exactly as the same Chrome would with a window.
//
// Headless Chrome differs from itself with a window in ONE place: its User-Agent string says "HeadlessChrome/…"
// (measured, Chrome 157: `navigator.userAgentData` — brands, platform, architecture, bitness, platformVersion,
// fullVersionList — is already the real one). Replacing the string with `--user-agent` alone empties every
// high-entropy client hint (architecture "", platformVersion "", fullVersionList []), which no real Chrome reports.
//
// So nothing here is written by hand: a throwaway headless Chrome of the same executable (temp profile, mock
// keychain, no network — it only opens a chrome:// page) is asked what it reports BEFORE any override
// (`probeChromeIdentity`); `identityFromProbe` keeps every value and drops only the "Headless" token; the project
// Chrome then gets that User-Agent as `--user-agent` (so even the first requests of a restored session carry it)
// and, over CDP, the full metadata on every target — pages, popups, frames, workers — before it runs
// (`applyIdentity`).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectCdp, type CdpConnection } from "./cdp.ts";

/** Printable ASCII and space only: these values go into an argv and into request headers. */
const SAFE_HEADER = /^[\x20-\x7e]+$/;
/** Longest User-Agent accepted (the old template's cap). */
const MAX_UA = 512;
/** Longest single metadata value (brand, version, platform…) accepted. */
const MAX_VALUE = 128;
const MAX_BRANDS = 16;
const VERSION = /^\d{1,10}(\.\d{1,10}){0,3}$/;
/** The token headless Chrome puts before "Chrome/" in its User-Agent and product, and into a brand on older builds. */
const HEADLESS = "Headless";
const HEADLESS_UA = /\bHeadless(?=Chrome\/)/g;
const GREASE_SUFFIX = ".0.0.0";
const LOOPBACK = "127.0.0.1";
const DEVTOOLS_ACTIVE_PORT = "DevToolsActivePort";

/** The client hints the probe asks Chrome for (all of UADataValues' high-entropy ones the CDP override can carry). */
export const PROBE_HINTS = ["architecture", "bitness", "model", "platformVersion", "fullVersionList", "uaFullVersion", "wow64", "formFactors"] as const;

/** Evaluated in the probe page: what this Chrome reports of itself. */
export const PROBE_EXPRESSION = `(async () => ({
  platform: navigator.platform,
  data: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(${JSON.stringify(PROBE_HINTS)}) : undefined,
}))()`;

/** Raw answers of an un-overridden Chrome (untrusted shape: checked by identityFromProbe). */
export interface ChromeProbe {
  /** Browser.getVersion `product`, e.g. "Chrome/157.0.8103.79". */
  product: string;
  /** Browser.getVersion `userAgent` (headless: "… HeadlessChrome/157.0.0.0 …"). */
  userAgent: string;
  /** navigator.platform. */
  platform: unknown;
  /** navigator.userAgentData.getHighEntropyValues(PROBE_HINTS), when the page has it. */
  data: unknown;
}

export interface Brand {
  brand: string;
  version: string;
}

/** CDP Emulation.UserAgentMetadata. */
export interface UserAgentMetadata {
  brands: Brand[];
  fullVersionList: Brand[];
  fullVersion?: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
  formFactors?: string[];
}

export interface HiddenIdentity {
  /** The probed Chrome's Browser.getVersion product: the identity belongs to that build only. */
  product: string;
  userAgent: string;
  /** navigator.platform; absent = Chrome's own stays. */
  platform?: string;
  /** Absent = the probe page had no userAgentData: only the User-Agent is replaced. */
  userAgentMetadata?: UserAgentMetadata;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safe = (v: unknown, max = MAX_VALUE): v is string => typeof v === "string" && v.length <= max && (v === "" || SAFE_HEADER.test(v));
const text = (v: unknown): string => (safe(v) ? v : "");

/** Brands as Chrome listed them, without a Headless one and without anything that could not go into a header. */
function brandList(v: unknown): Brand[] {
  if (!Array.isArray(v)) return [];
  const out: Brand[] = [];
  for (const b of v.slice(0, MAX_BRANDS)) {
    if (!isRecord(b) || !safe(b.brand) || b.brand === "" || !safe(b.version) || !VERSION.test(b.version)) continue;
    if (b.brand.includes(HEADLESS) || /["\\]/.test(b.brand)) continue;
    out.push({ brand: b.brand, version: b.version });
  }
  return out;
}

/** "Chrome/157.0.8103.79" → "157.0.8103.79". */
function productVersion(product: string): string | undefined {
  const v = /\/(\d+\.\d+\.\d+\.\d+)$/.exec(product)?.[1];
  return v !== undefined && VERSION.test(v) ? v : undefined;
}

/**
 * The identity a hidden Chrome presents: the probed Chrome's own User-Agent and client hints, with only the
 * "Headless" token gone. A value the probe lacked stays empty (never made up); fullVersionList, when Chrome gave
 * none, is the brands with Chrome's full version (and a GREASE brand's "<major>.0.0.0" — Chrome's own rule).
 * null = nothing usable (no Chrome User-Agent, or text unfit for a header).
 */
export function identityFromProbe(p: ChromeProbe): HiddenIdentity | null {
  if (!safe(p.userAgent, MAX_UA) || !safe(p.product)) return null;
  const userAgent = p.userAgent.replace(HEADLESS_UA, "");
  if (userAgent === "" || !/ Chrome\/\d/.test(userAgent) || userAgent.includes(HEADLESS)) return null;
  const id: HiddenIdentity = { product: p.product, userAgent };
  if (safe(p.platform) && p.platform !== "") id.platform = p.platform;
  const d = p.data;
  if (!isRecord(d)) return id;
  const brands = brandList(d.brands);
  if (brands.length === 0) return id;
  const fullVersion = safe(d.uaFullVersion) && VERSION.test(d.uaFullVersion) ? d.uaFullVersion : productVersion(p.product);
  let fullVersionList = brandList(d.fullVersionList);
  if (fullVersionList.length === 0 && fullVersion !== undefined) {
    const major = fullVersion.split(".")[0];
    fullVersionList = brands.map((b) => ({ brand: b.brand, version: b.version === major ? fullVersion : `${b.version}${GREASE_SUFFIX}` }));
  }
  const metadata: UserAgentMetadata = {
    brands,
    fullVersionList,
    ...(fullVersion === undefined ? {} : { fullVersion }),
    platform: text(d.platform),
    platformVersion: text(d.platformVersion),
    architecture: text(d.architecture),
    model: text(d.model),
    mobile: d.mobile === true,
    bitness: text(d.bitness),
    wow64: d.wow64 === true,
  };
  if (Array.isArray(d.formFactors) && d.formFactors.length > 0 && d.formFactors.every((f) => safe(f) && f !== "")) {
    metadata.formFactors = (d.formFactors as string[]).slice(0, MAX_BRANDS);
  }
  id.userAgentMetadata = metadata;
  return id;
}

/** Chrome's `<profile>/DevToolsActivePort`: "<port>\n/devtools/browser/<id>". */
export function parseDevToolsActivePort(content: string): { port: number; path: string } | null {
  const [portText, path] = content.split("\n");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (path === undefined || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path)) return null;
  return { port, path };
}

/** What auto-attaching asks: every new target waits until its override is in place. */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } as const;
/** Targets whose own children (frames in other processes, their dedicated workers) are attached through them. */
const PARENT_TYPES = new Set(["page", "iframe"]);

/** What the engine does through the identity's own sessions. */
export interface IdentityHandle {
  /**
   * Loads `url` in the tab `targetId` once its override is in place. A tab Chrome creates with an address starts
   * that request before any DevTools client can attach to it (measured, Chrome 157: Sec-CH-UA-Arch "" on a
   * Target.createTarget URL), so the engine opens about:blank and loads the address through this.
   */
  navigate(targetId: string, url: string): Promise<void>;
}

/**
 * Gives every target of the Chrome behind `cdp` — the existing ones, new tabs and popups, frames and workers, also
 * what other DevTools clients open — `identity` before its first script or request: auto-attach (paused), override,
 * attach its children, resume. The overrides live as long as this connection does, so the caller applies it again
 * on every connect (also to an adopted Chrome after an engine restart). A target whose override fails still runs.
 * `waitMs`: longest `navigate` waits for Chrome to report a new tab.
 */
export async function applyIdentity(
  cdp: CdpConnection,
  identity: HiddenIdentity,
  warn: (msg: string, err: unknown) => void,
  waitMs: number,
): Promise<IdentityHandle> {
  const override = {
    userAgent: identity.userAgent,
    ...(identity.platform === undefined ? {} : { platform: identity.platform }),
    ...(identity.userAgentMetadata === undefined ? {} : { userAgentMetadata: identity.userAgentMetadata }),
  };
  /** targetId → the session of ours that attaches its children, settled once the target runs with the override. */
  const covered = new Map<string, { sessionId: string; ready: Promise<void> }>();
  /** targetId → navigate calls waiting for Chrome to report the target. */
  const waiters = new Map<string, (() => void)[]>();
  cdp.on((method, params) => {
    if (method === "Target.detachedFromTarget") {
      const { sessionId, targetId } = params;
      if (typeof targetId === "string" && covered.get(targetId)?.sessionId === sessionId) covered.delete(targetId);
      return;
    }
    if (method !== "Target.attachedToTarget") return;
    const sessionId = params.sessionId;
    const info = params.targetInfo;
    if (typeof sessionId !== "string" || !isRecord(info) || typeof info.targetId !== "string") return;
    const targetId = info.targetId;
    const parent = typeof info.type === "string" && PARENT_TYPES.has(info.type) && !covered.has(targetId);
    const ready = (async () => {
      try {
        await cdp.send("Network.setUserAgentOverride", override, sessionId);
        if (parent) await cdp.send("Target.setAutoAttach", { ...AUTO_ATTACH }, sessionId);
      } catch (err) {
        warn("hidden browser identity not applied to a target", err);
      } finally {
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      }
    })();
    if (!parent) return;
    covered.set(targetId, { sessionId, ready });
    for (const wake of waiters.get(targetId) ?? []) wake();
    waiters.delete(targetId);
  });
  await cdp.send("Target.setAutoAttach", { ...AUTO_ATTACH });

  function reported(targetId: string): Promise<void> {
    if (covered.has(targetId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const left = (waiters.get(targetId) ?? []).filter((w) => w !== wake);
        if (left.length > 0) waiters.set(targetId, left);
        else waiters.delete(targetId);
        reject(new Error(`target ${targetId} was not attached in time`));
      }, waitMs);
      waiters.set(targetId, [...(waiters.get(targetId) ?? []), wake]);
    });
  }

  return {
    async navigate(targetId, url) {
      await reported(targetId);
      const entry = covered.get(targetId);
      if (!entry) throw new Error(`target ${targetId} is gone`);
      await entry.ready;
      await cdp.send("Page.navigate", { url }, entry.sessionId);
    },
  };
}

export interface ProbeOptions {
  chromePath: string;
  /** Chrome's argv besides the profile and DevTools port (headless, mock keychain, …). */
  args: readonly string[];
  /** A secure page of Chrome's own (navigator.userAgentData is only exposed to secure contexts). */
  url: string;
  timeoutMs: number;
  pollMs: number;
  cdpTimeoutMs: number;
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a throwaway headless Chrome of `chromePath` (own temp profile, DevTools on a loopback port it picks) and
 * reads what it reports of itself with no override: Browser.getVersion and, in `url`, navigator.platform and
 * userAgentData's high-entropy values. The Chrome and its profile are gone when this returns.
 */
export async function probeChromeIdentity(o: ProbeOptions): Promise<ChromeProbe> {
  const profile = mkdtempSync(join(tmpdir(), "kokpit-chrome-probe-"));
  const deadline = Date.now() + o.timeoutMs;
  let exited: string | null = null;
  const child = o.spawn(o.chromePath, [`--user-data-dir=${profile}`, `--remote-debugging-address=${LOOPBACK}`, "--remote-debugging-port=0", ...o.args], { stdio: "ignore" });
  child.once("exit", (code, signal) => (exited = `${code ?? signal}`));
  child.once("error", (err) => (exited = err.message));
  let cdp: CdpConnection | undefined;
  try {
    let active: { port: number; path: string } | null = null;
    while (!active) {
      if (exited !== null) throw new Error(`probe Chrome exited (${exited})`);
      if (Date.now() > deadline) throw new Error("probe Chrome did not open its DevTools port in time");
      try {
        active = parseDevToolsActivePort(readFileSync(join(profile, DEVTOOLS_ACTIVE_PORT), "utf8"));
      } catch {
        /* not written yet */
      }
      if (!active) await sleep(o.pollMs);
    }
    cdp = await connectCdp(`ws://${LOOPBACK}:${active.port}${active.path}`, { timeoutMs: o.cdpTimeoutMs });
    const version = await cdp.send<{ product?: unknown; userAgent?: unknown }>("Browser.getVersion");
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: o.url });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    // The page is ready once it is the probe page and a secure context (userAgentData exists).
    const ready = `location.href.startsWith(${JSON.stringify(o.url)}) && document.readyState === "complete" && !!navigator.userAgentData`;
    for (;;) {
      const r = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: ready, returnByValue: true }, sessionId);
      if (r.result?.value === true) break;
      if (Date.now() > deadline) break; // read what there is: no userAgentData = the User-Agent only
      await sleep(o.pollMs);
    }
    const r = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression: PROBE_EXPRESSION, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    const value = isRecord(r.result?.value) ? r.result.value : {};
    return {
      product: typeof version.product === "string" ? version.product : "",
      userAgent: typeof version.userAgent === "string" ? version.userAgent : "",
      platform: value.platform,
      data: value.data,
    };
  } finally {
    if (cdp && !cdp.closed) {
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
    }
    if (exited === null) {
      const gone = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGKILL");
      await Promise.race([gone, sleep(o.timeoutMs)]);
    }
    rmSync(profile, { recursive: true, force: true });
  }
}
