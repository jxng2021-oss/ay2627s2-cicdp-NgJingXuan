import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default", "json"],
    outputFile: { json: "../../qa/results/e2e.json" },
    fileParallelism: false,
    globalSetup: ["./global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
