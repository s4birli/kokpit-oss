// Smoke test of the packaged app; `pnpm test:dist` runs electron-builder first.
import { defineConfig } from "vitest/config";
import e2e from "./vitest.e2e.config.ts";

export default defineConfig({
  test: { ...e2e.test, name: "app-dist", include: ["e2e/**/*.dist.test.ts"] },
});
