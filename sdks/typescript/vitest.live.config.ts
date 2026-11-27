import { defineConfig } from "vitest/config";

// Live tests against tests/harness/stack.ts (they skip when server/api/node_modules is missing).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/live/**/*.live.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 600_000,
  },
});
