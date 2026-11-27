import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The UI talks to grad-server through the TypeScript SDK's generated client and
// browser-safe transport, imported from source so there is one client.
const sdk = fileURLToPath(new URL("../../sdks/typescript/src", import.meta.url));

export default defineConfig({
  base: "/",
  resolve: { alias: { "@sdk": sdk } },
  oxc: { jsx: { runtime: "automatic" } },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    // No inline scripts: the server's CSP is script-src 'self'.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    // `pnpm dev` proxies the API to a local grad-server (grad local up or the harness).
    proxy: { "/v1": process.env.GRAD_API ?? "http://127.0.0.1:8787", "/health/": process.env.GRAD_API ?? "http://127.0.0.1:8787" },
  },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["test/live/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx"],
      reporter: ["text-summary"],
      thresholds: { lines: 90, branches: 75 },
    },
  },
});
