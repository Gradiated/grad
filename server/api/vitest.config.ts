import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: [
      "test/fixtures/postgres-global.ts",
      "test/fixtures/s3-global.ts",
    ],
    setupFiles: ["test/fixtures/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The process entrypoints (the live harness runs them).
      exclude: ["src/main.ts", "src/worker/main.ts"],
      reporter: ["text-summary", "text", "json-summary", "lcov"],
      thresholds: { lines: 90, branches: 80 },
    },
  },
});
