import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "app",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
    // i18n: the private (Turkish) test configuration.
    setupFiles: ["./src/i18n/test-setup.ts"],
  },
});
