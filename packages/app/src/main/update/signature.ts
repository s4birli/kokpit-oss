// Kendini güncelleme: an update is installed only when it is signed by the publisher key this app was built with
// (@kokpit/shared update-signing.ts; the public key is embedded by scripts/dist.ts). Checked before anything is
// downloaded, and again before anything is written.
import type { AppUpdateManifest } from "@kokpit/shared";
import { entriesSha256, keyIdOf, verifyManifest } from "@kokpit/shared/update-signing";
import { t } from "../../i18n/index.ts";

export type SignatureCheck = { ok: true } | { ok: false; message: string };

/** Why a build without the publisher's key installs nothing, in the current language. */
export const noUpdateKeyText = (): string => t("update.errors.noUpdateKey");

/** The fields the signature covers (everything but the signature and the key's name). */
export function signedFieldsOf(m: AppUpdateManifest): Omit<AppUpdateManifest, "signature" | "signingKeyId"> {
  const { signature: _s, signingKeyId: _k, ...fields } = m;
  return fields;
}

export function checkManifestSignature(manifest: AppUpdateManifest, publicKey: string | undefined): SignatureCheck {
  if (publicKey === undefined) return { ok: false, message: noUpdateKeyText() };
  if (manifest.signingKeyId !== keyIdOf(publicKey)) {
    return { ok: false, message: t("update.errors.otherPublisher", { keyId: manifest.signingKeyId }) };
  }
  if (!verifyManifest(publicKey, signedFieldsOf(manifest), manifest.signature)) return { ok: false, message: t("update.errors.badSignature") };
  return { ok: true };
}

/** The entry list is the one the signature covers (via the manifest's `entriesSha256`). */
export function entriesMatchManifest(entries: unknown, manifest: Pick<AppUpdateManifest, "entriesSha256">): boolean {
  return entriesSha256(entries) === manifest.entriesSha256;
}
