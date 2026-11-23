// Kendini güncelleme: the identity of this build of the app. The value is put in by the build
// (`define` in electron.vite.config.ts); code that runs unbuilt (unit tests) gets a placeholder.
import type { BuildInfo } from "@kokpit/shared";

declare const __KOKPIT_BUILD__: BuildInfo | undefined;
declare const __KOKPIT_UPDATE_KEY__: string | undefined;

/**
 * The publisher's PUBLIC key (raw Ed25519, base64) this build accepts updates from; put in by scripts/dist.ts from
 * the deploy's key folder. Undefined: this build installs no update at all.
 */
export const APP_UPDATE_KEY: string | undefined =
  typeof __KOKPIT_UPDATE_KEY__ !== "undefined" && __KOKPIT_UPDATE_KEY__ !== "" ? __KOKPIT_UPDATE_KEY__ : undefined;

export const APP_BUILD: BuildInfo =
  typeof __KOKPIT_BUILD__ !== "undefined" ? __KOKPIT_BUILD__ : { buildId: "0.0.0-unbuilt", version: "0.0.0", commit: "unknown", builtAt: new Date(0).toISOString() };
