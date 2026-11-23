import { defineConfig } from "vitest/config";

// i18n: setupFiles = the private (Turkish) test configuration; see src/i18n/test-setup.ts.
export default defineConfig({ test: { name: "shared", include: ["src/**/*.test.ts"], setupFiles: ["./src/i18n/test-setup.ts"] } });
