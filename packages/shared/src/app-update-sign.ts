// Kendini güncelleme: what an update's publisher signature covers (Ed25519, update-signing.ts). Isomorphic: only
// the canonical text is built here; signing and verifying live with node:crypto.
//
// Signed: the build's identity (build id and its build time, version), the payload's format and bundle name, the
// blob's SHA-256 and size, the unpacked size and entry count, SHA-256 of the entry list, the minimum engine build
// and the publish time — everything the app acts on. A field changed by anyone without the publisher's private key
// (an impostor at the engine's address, someone holding only the engine's access key) breaks the signature.
import { buildStamp } from "./app-update.ts";

const PAYLOAD_TAG = "kokpit-app-update-v1";

export interface SignedManifestFields {
  buildId: string;
  version: string;
  format: number;
  bundleName: string;
  sha256: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  entriesSha256: string;
  minEngineBuild?: string | undefined;
  createdAt: string;
}

/** The exact text that is signed: a tag line, then one JSON array in a fixed order. */
export function signedPayload(m: SignedManifestFields): string {
  return `${PAYLOAD_TAG}\n${JSON.stringify([
    m.buildId,
    buildStamp(m.buildId) ?? null,
    m.version,
    m.format,
    m.bundleName,
    m.sha256,
    m.size,
    m.unpackedSize,
    m.entryCount,
    m.entriesSha256,
    m.minEngineBuild ?? null,
    m.createdAt,
  ])}`;
}

/**
 * The entry list as signed text: one array per entry in list order, fixed field order, absent fields as null. Works
 * on a list as it arrived (before validation): extra fields are not part of it, so they cannot change what is
 * checked — the validated list is what gets used.
 */
export function canonicalEntries(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  const rows: unknown[] = [];
  for (const e of entries) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return undefined;
    const r = e as Record<string, unknown>;
    rows.push([r.path ?? null, r.type ?? null, r.mode ?? null, r.size ?? null, r.sha256 ?? null, r.target ?? null]);
  }
  return JSON.stringify(rows);
}
