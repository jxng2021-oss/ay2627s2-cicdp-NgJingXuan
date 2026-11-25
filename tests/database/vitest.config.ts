import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default", "json"],
    outputFile: { json: "../../qa/results/database.json" },
    include: ["**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
