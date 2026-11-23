import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "engine",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 20000,
    pool: "forks",
    setupFiles: ["./test/i18n-setup.ts"],
  },
});
