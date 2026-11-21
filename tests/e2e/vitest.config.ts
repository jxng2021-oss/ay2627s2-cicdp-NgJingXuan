import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["./global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
