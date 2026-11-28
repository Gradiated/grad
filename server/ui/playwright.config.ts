import { defineConfig } from "@playwright/test";

// Browser journeys against a real grad-server (e2e/stack.ts starts one).
//   pnpm -C server/ui exec vite build && pnpm -C server/ui e2e
// GRAD_E2E_CHROMIUM: a Chromium (or headless shell) binary to use instead of
// `playwright install --only-shell chromium`.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/stack.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    ...(process.env.GRAD_E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.GRAD_E2E_CHROMIUM } } : {}),
  },
  outputDir: "e2e-results",
});
