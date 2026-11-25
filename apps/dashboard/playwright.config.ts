import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "../../tests/dashboard-ui",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["json", { outputFile: "../../qa/results/dashboard-ui.json" }],
  ],
  outputDir: "test-results",
  globalTeardown: "../../tests/dashboard-ui/global-teardown.ts",
  use: {
    baseURL: process.env.DASHBOARD_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
