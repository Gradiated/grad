import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Headless check against a running stack (no browser download): happy-dom
// renders the real App, which calls the real grad-server. Start the harness
// (tests/harness/stack.ts) and pass its base_url and api_key:
//   GRAD_LIVE_BASE_URL=http://127.0.0.1:PORT GRAD_LIVE_API_KEY=grad_e2e_admin_key \
//     pnpm -C server/ui exec vitest run --config vitest.live.config.ts
const base = process.env.GRAD_LIVE_BASE_URL ?? "http://127.0.0.1:18787";

export default defineConfig({
  resolve: { alias: { "@sdk": fileURLToPath(new URL("../../sdks/typescript/src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "happy-dom",
    // Same origin as the server, as in a real browser tab.
    environmentOptions: { happyDOM: { url: `${base}/` } },
    include: ["test/live/**/*.test.{ts,tsx}"],
    testTimeout: 60_000,
  },
});
