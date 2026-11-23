// Kendini güncelleme: an update is fetched only over a transport that protects it on the way to the right peer —
//   - this Mac (a loopback IP literal),
//   - Tailscale, when Tailscale's own status says the address is in the tailnet RIGHT NOW (WireGuard-encrypted and
//     authenticated; 100.64.0.0/10 is carrier-grade NAT space, so with Tailscale down the same address is some
//     unknown host — tailnet.ts),
//   - TLS (`wss://`).
// Anything else (a LAN address, a host name over plain ws://, Tailscale down) gets no update: the mutual handshake
// proves who answered, but after it plain ws:// has no integrity, and an update is code.
import { ipLiteralBytes } from "@kokpit/shared";
import { tailnetAddressOf, type TailnetConfig, type TailnetVerifier } from "../tailnet.ts";
import { t } from "../../i18n/index.ts";

export type TransportCheck = { ok: true; via: "loopback" | "tailnet" | "tls" } | { ok: false; message: string };

/** The refusal, in the current language. */
export const transportRefused = (): string => t("update.errors.transportRefused");

const isLoopback = (ip: Uint8Array): boolean =>
  ip.length === 4 ? ip[0] === 127 : ip.length === 16 && ip.slice(0, 15).every((b) => b === 0) && ip[15] === 1;

/** Whether an update may be fetched from the engine at `wsUrl`. Never rejects. */
export async function checkUpdateTransport(wsUrl: string, tailnet: Pick<TailnetVerifier, "verify">, cfg: Pick<TailnetConfig, "cidrs">): Promise<TransportCheck> {
  const via = await protectedTransport(wsUrl, tailnet, cfg);
  return via ? { ok: true, via } : { ok: false, message: transportRefused() };
}

/**
 * The protection a connection to `wsUrl` would have: this Mac (a loopback IP literal), Tailscale (an address in
 * Tailscale's ranges that Tailscale's own status lists right now), TLS — or null for none of them. Never rejects.
 * Shared by updates and by every connection that carries the access key's handshake (connection-gate.ts).
 */
export async function protectedTransport(wsUrl: string, tailnet: Pick<TailnetVerifier, "verify">, cfg: Pick<TailnetConfig, "cidrs">): Promise<"loopback" | "tailnet" | "tls" | null> {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  if (url.protocol === "wss:") return "tls";
  if (url.protocol !== "ws:") return null;
  // An IP literal only: a host name could resolve anywhere.
  const ip = ipLiteralBytes(url.hostname);
  if (!ip) return null;
  if (isLoopback(ip)) return "loopback";
  // Inside Tailscale's ranges, AND in the tailnet right now by Tailscale's own status.
  if (tailnetAddressOf(cfg, `http://${url.host}/`) === null) return null;
  try {
    if (await tailnet.verify(ip)) return "tailnet";
  } catch {
    // Fail closed.
  }
  return null;
}
