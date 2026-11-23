// Kendini güncelleme: the real end-to-end run (two packaged builds, a temp install, a temp engine). Run with
// `pnpm --filter @kokpit/app test:update`; never part of `pnpm test`, test:e2e or test:dist — it builds the app twice.
import { defineConfig } from "vitest/config";
import e2e from "./vitest.e2e.config.ts";

const MINUTE_MS = 60_000;

export default defineConfig({
  test: { ...e2e.test, name: "app-update", include: ["e2e/**/*.update.test.ts"], testTimeout: 5 * MINUTE_MS, hookTimeout: 20 * MINUTE_MS },
});
