// The transport gate in front of EVERY connection that runs the access key's handshake (the window's engine
// connection; updates have their own, stricter gate in update/transport.ts).
//
// Why: the handshake proves each side holds the key, but its proofs bind only the two nonces — not the channel.
// An impostor at the address the app dials that can also reach the real engine can relay the handshake and keep
// the authenticated session for itself (terminals = running code on the engine Mac). So the key's handshake is only
// started over a transport that already makes "the address" mean "the engine": this Mac (a loopback IP literal),
// Tailscale (an address Tailscale's own status lists right now — asked afresh on every (re)connection), or TLS.
// Anything else is refused before a byte is sent, unless the user turned on "güvenli olmayan ağda yine de bağlan"
// for exactly that address (Ayarlar › Bağlantı; off by default, stored per address in userData).
//
// The long-term fix is channel binding (TLS with the engine's certificate pinned, or a Noise handshake): then no
// relay can keep the session. Not built yet — docs §2.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TailnetConfig, TailnetVerifier } from "./tailnet.ts";
import { protectedTransport } from "./update/transport.ts";
import { t } from "../i18n/index.ts";

export type ConnectionVerdict = { ok: true; via: "loopback" | "tailnet" | "tls" | "insecure-optin" } | { ok: false; message: string };

/** The refusal, in the current language. */
export const connectionRefused = (): string => t("main.connection.refused");

export interface ConnectionGate {
  /** Whether the key's handshake may start with `url`. Never rejects. */
  check(url: string): Promise<ConnectionVerdict>;
  insecureAllowed(url: string): Promise<boolean>;
  /** The user's opt-in for exactly this address (an address that needs none is never stored). */
  setInsecure(url: string, on: boolean): Promise<void>;
}

const FILE_VERSION = 1;
const FILE_MODE = 0o600;

/** `ws://host:port` as one comparable string (path, query and case of the scheme/host dropped), or null. */
export function addressKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    if (u.host === "") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function createConnectionGate(deps: {
  tailnet: Pick<TailnetVerifier, "verify" | "invalidate">;
  config: Pick<TailnetConfig, "cidrs">;
  filePath: string;
  maxAddresses: number;
}): ConnectionGate {
  async function readAddresses(): Promise<string[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(deps.filePath, "utf8"));
      if (parsed === null || typeof parsed !== "object") return [];
      const { version, addresses } = parsed as { version?: unknown; addresses?: unknown };
      if (version !== FILE_VERSION || !Array.isArray(addresses) || !addresses.every((a) => typeof a === "string" && addressKey(a) === a)) return [];
      return (addresses as string[]).slice(0, deps.maxAddresses);
    } catch {
      return []; // missing or damaged: no opt-in (fail closed)
    }
  }

  async function writeAddresses(addresses: string[]): Promise<void> {
    await mkdir(dirname(deps.filePath), { recursive: true });
    const tmp = `${deps.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: FILE_VERSION, addresses }), { mode: FILE_MODE });
    await rename(tmp, deps.filePath);
  }

  async function protectedVia(url: string) {
    // A reconnection must not ride on a status read seconds ago: Tailscale may have gone down since.
    deps.tailnet.invalidate();
    return protectedTransport(url, deps.tailnet, deps.config);
  }

  return {
    async check(url) {
      const via = await protectedVia(url);
      if (via) return { ok: true, via };
      const key = addressKey(url);
      if (key !== null && (await readAddresses()).includes(key)) return { ok: true, via: "insecure-optin" };
      return { ok: false, message: connectionRefused() };
    },

    async insecureAllowed(url) {
      const key = addressKey(url);
      return key !== null && (await readAddresses()).includes(key);
    },

    async setInsecure(url, on) {
      const key = addressKey(url);
      if (key === null) return;
      const current = await readAddresses();
      if (!on) {
        if (current.includes(key)) await writeAddresses(current.filter((a) => a !== key));
        return;
      }
      // Only an address that really needs it is stored (loopback, a host on the tailnet, wss:// never do).
      if ((await protectedVia(url)) !== null || current.includes(key)) return;
      await writeAddresses([...current, key].slice(-deps.maxAddresses));
    },
  };
}
