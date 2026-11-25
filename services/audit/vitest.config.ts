import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["vitest", "fastify", "drizzle-orm", "@electric-sql/pglite"],
  },
  test: {
    reporters: ["default", "json"],
    outputFile: { json: "../../qa/results/audit.json" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "../../qa/coverage/audit",
    },
    include: ["../../tests/audit/**/*.test.ts"],
    testTimeout: 30_000,
    maxWorkers: 4,
    hookTimeout: 30_000,
  },
});
