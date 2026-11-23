// İş M: security rules shared by every embedded web view, as pure functions.
// web-view-host.ts wires them into Electron; each kind of view (web-policy.ts, …) adds what is specific to it.
import { isHttpsUrl } from "@kokpit/shared";
import type { SurfaceBounds } from "../renderer/engine/surface.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
/** Larger than any real display; anything above is junk from a confused renderer. */
const MAX_BOUND = 100_000;

export function parseBounds(raw: unknown): SurfaceBounds | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of ["x", "y", "width", "height"] as const) {
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_BOUND) return null;
    out[k] = Math.round(v);
  }
  return out as unknown as SurfaceBounds;
}

/** Where a view (and its login popups) may navigate: https only. */
export function navigationAllowed(raw: string, frame: { mainFrame: boolean } = { mainFrame: true }): boolean {
  if (isHttpsUrl(raw)) return true;
  if (frame.mainFrame) return false;
  // The page's own helper frames: empty documents and blobs it created on an https origin.
  if (raw === "about:blank" || raw === "about:srcdoc") return true;
  return raw.startsWith("blob:") && isHttpsUrl(raw.slice("blob:".length));
}

/** `host` is `allowed` or one of its subdomains. */
export function hostMatches(host: string, allowed: string): boolean {
  const h = host.toLowerCase();
  const a = allowed.toLowerCase();
  return h === a || h.endsWith(`.${a}`);
}

/** Drops `Token/version` products (e.g. Electron/39, kokpit/0.1) from a user agent. */
export function cleanUserAgent(cfg: { userAgentDropTokens: readonly string[] }, ua: string): string {
  const drop = new Set(cfg.userAgentDropTokens.map((t) => t.toLowerCase()));
  return ua
    .split(" ")
    .filter((part) => !drop.has(part.split("/")[0]!.toLowerCase()))
    .join(" ");
}

/** Test-only: the loopback host named by `envName` whose self-signed certificate a view accepts; else null. */
export function loopbackTrustHost(env: NodeJS.ProcessEnv, envName: string, makeError: (msg: string) => Error): string | null {
  const raw = env[envName];
  if (raw === undefined || raw === "") return null;
  if (!LOOPBACK_HOSTS.has(raw)) throw makeError(`${envName} yalnız yerel adres olabilir.`);
  return raw;
}

/** The environment without test-only switches when the app is packaged. */
export function withoutTestSwitches(env: NodeJS.ProcessEnv, isPackaged: boolean, names: readonly string[]): NodeJS.ProcessEnv {
  if (!isPackaged) return env;
  const out = { ...env };
  for (const n of names) delete out[n];
  return out;
}
