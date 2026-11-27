import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Live tests start a real stack; run them with `pnpm test:live`.
    exclude: ["test/live/**", "node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 600_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "text", "lcov"],
      thresholds: { lines: 90 },
    },
  },
});
