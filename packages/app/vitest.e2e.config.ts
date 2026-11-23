// End-to-end tests: real Electron (via Playwright `_electron`) against a real engine child process.
// Run with `pnpm --filter @kokpit/app test:e2e`; the root `pnpm test` never picks these up.
import { defineConfig } from "vitest/config";

const MINUTE_MS = 60_000;

export default defineConfig({
  test: {
    name: "app-e2e",
    include: ["e2e/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 2 * MINUTE_MS,
    hookTimeout: 2 * MINUTE_MS,
    // One Electron + one engine at a time; steps share state in order.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
