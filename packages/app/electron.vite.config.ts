import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { BuildInfoSchema } from "@kokpit/shared";
import { computeBuildInfo } from "@kokpit/shared/build-info";
import { isLocale, LOCALES } from "@kokpit/shared/i18n";

/**
 * Kendini güncelleme: the build's identity, compiled into the main process. `scripts/dist.ts` hands in the identity
 * it also writes into Info.plist; any other build (dev, e2e) gets one of its own, made here.
 */
const build = process.env.KOKPIT_BUILD_INFO
  ? BuildInfoSchema.parse(JSON.parse(process.env.KOKPIT_BUILD_INFO))
  : computeBuildInfo({ packageJsonPath: fileURLToPath(new URL("./package.json", import.meta.url)) });

/**
 * i18n: the build's default language (until the user picks one in Ayarlar). `pnpm deploy:local` passes the engine
 * config's `language`; without one the shared default (i18n.defaults.json) applies.
 */
const DEFAULT_LANGUAGE_ENV = "KOKPIT_DEFAULT_LANGUAGE";
const defaultLanguage = process.env[DEFAULT_LANGUAGE_ENV] ?? "";
if (defaultLanguage !== "" && !isLocale(defaultLanguage)) throw new Error(`${DEFAULT_LANGUAGE_ENV} must be one of ${LOCALES.join(", ")}`);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@kokpit/shared", "zod"] })],
    // Kendini güncelleme: the publisher's public key (scripts/dist.ts); empty = this build installs no update.
    define: {
      __KOKPIT_BUILD__: JSON.stringify(build),
      __KOKPIT_UPDATE_KEY__: JSON.stringify(process.env.KOKPIT_UPDATE_PUBLIC_KEY ?? ""),
      __KOKPIT_DEFAULT_LANGUAGE__: JSON.stringify(defaultLanguage),
    },
  },
  // Sandboxed preloads cannot be ES modules; emit CommonJS (out/preload/index.cjs).
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@kokpit/shared", "zod"] })],
    build: { rolldownOptions: { output: { format: "cjs" } } },
  },
  renderer: { plugins: [react()] },
});
