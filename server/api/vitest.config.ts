import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: [
      "test/fixtures/postgres-global.ts",
      "test/fixtures/minio-global.ts",
    ],
    setupFiles: ["test/fixtures/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
      reporter: ["text-summary", "text", "json-summary"],
      thresholds: { lines: 90, branches: 80 },
    },
  },
});
