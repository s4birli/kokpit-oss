// Plain http to a Tailscale-range address (100.64.0.0/10, fd7a:115c:a1e0::/48) is only safe while that address
// really is a machine of the user's tailnet: 100.64.0.0/10 is carrier-grade NAT space, so with Tailscale down — or
// on a carrier network using that range — the same address is some unknown host, and the page's login would go to
// it in clear text. So an http site in those ranges is loaded only while main has VERIFIED, from Tailscale's own
// local status (`tailscale status --json`), that the tailnet is up (`BackendState === "Running"`) and that the exact
// address is one of `Self.TailscaleIPs` / `Peer[*].TailscaleIPs`.
//
// Fail closed: CLI missing, time limit, unreadable output, backend not running, address not in the tailnet → not
// verified, the site is not loaded. The answer is cached for a few seconds only (config). The status output holds
// device names and is never logged or kept: only the addresses are, in memory.
import { execFile } from "node:child_process";
import { ipLiteralBytes, isPrivateHttpUrl } from "@kokpit/shared";
import type { WebConfig } from "../renderer/engine/web-ipc.ts";

export type TailnetConfig = WebConfig["httpTailnet"];

/** Tailscale's local status as JSON text; null when it could not be read. May reject (treated as null). */
export type TailnetStatusReader = () => Promise<string | null>;

const RUNNING = "Running";
const KILL_SIGNAL = "SIGKILL";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Addresses in a node's `TailscaleIPs` that are plain IP literals. */
function nodeAddresses(node: unknown): Uint8Array[] {
  if (!isRecord(node) || !Array.isArray(node.TailscaleIPs)) return [];
  const out: Uint8Array[] = [];
  for (const raw of node.TailscaleIPs) {
    if (typeof raw !== "string") continue;
    const bytes = ipLiteralBytes(raw.includes(":") ? `[${raw}]` : raw);
    if (bytes) out.push(bytes);
  }
  return out;
}

/** `tailscale status --json` → every address of the tailnet (self + peers), or null unless the backend is running. */
export function parseTailnetStatus(text: string): Uint8Array[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.BackendState !== RUNNING) return null;
  const peers = isRecord(data.Peer) ? Object.values(data.Peer) : [];
  return [data.Self, ...peers].flatMap(nodeAddresses);
}

/**
 * The address that must be verified before `url` is loaded: the host of a plain-http URL inside the Tailscale
 * ranges. null: nothing to verify (https, loopback http, not a URL).
 */
export function tailnetAddressOf(cfg: Pick<TailnetConfig, "cidrs">, url: string): Uint8Array | null {
  if (!isPrivateHttpUrl(url, cfg.cidrs)) return null;
  return ipLiteralBytes(new URL(url).hostname);
}

const sameAddress = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export interface TailnetVerifier {
  /** True only while the tailnet is up and `ip` is one of its addresses. Never rejects. */
  verify(ip: Uint8Array): Promise<boolean>;
  /** Forget the cached status (a load failed: ask Tailscale again). */
  invalidate(): void;
}

export function createTailnetVerifier(deps: { config: Pick<TailnetConfig, "cacheMs">; read: TailnetStatusReader; now?: () => number }): TailnetVerifier {
  const now = deps.now ?? Date.now;
  /** The tailnet's addresses (null: not verified) and when they were read. */
  let cached: { at: number; addresses: Uint8Array[] | null } | null = null;
  let reading: Promise<Uint8Array[] | null> | null = null;

  function addresses(): Promise<Uint8Array[] | null> {
    if (cached && now() - cached.at < deps.config.cacheMs) return Promise.resolve(cached.addresses);
    if (reading) return reading;
    const mine: Promise<Uint8Array[] | null> = Promise.resolve()
      .then(deps.read)
      .then(
        (text) => (text === null ? null : parseTailnetStatus(text)),
        () => null,
      )
      .then((found) => {
        // Only the newest read may fill the cache (invalidate() may have come meanwhile).
        if (reading === mine) {
          cached = { at: now(), addresses: found };
          reading = null;
          return found;
        }
        return null;
      });
    reading = mine;
    return mine;
  }

  return {
    async verify(ip) {
      const known = await addresses();
      return known !== null && known.some((a) => sameAddress(a, ip));
    },
    invalidate() {
      cached = null;
      reading = null;
    },
  };
}

/**
 * Reads the status with the Tailscale CLI: the first of `binaries` that exists, with `statusArgs`, no shell, time
 * and size limited. Any failure of that CLI is "could not read" — a later candidate is not asked instead.
 */
export function createTailnetStatusReader(cfg: Pick<TailnetConfig, "binaries" | "statusArgs" | "env" | "timeoutMs" | "maxOutputBytes">): TailnetStatusReader {
  const env = { ...process.env, ...cfg.env };
  const run = (file: string): Promise<{ text: string | null; missing: boolean }> =>
    new Promise((resolve) => {
      execFile(file, cfg.statusArgs, { env, timeout: cfg.timeoutMs, maxBuffer: cfg.maxOutputBytes, killSignal: KILL_SIGNAL, encoding: "utf8", windowsHide: true }, (err, stdout) => {
        if (!err) return resolve({ text: String(stdout), missing: false });
        resolve({ text: null, missing: (err as NodeJS.ErrnoException).code === "ENOENT" });
      });
    });
  return async () => {
    for (const file of cfg.binaries) {
      const r = await run(file);
      if (!r.missing) return r.text;
    }
    return null;
  };
}
