import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: [
      "vitest",
      "fastify",
      "drizzle-orm",
      "@electric-sql/pglite",
      "undici",
    ],
  },
  test: {
    reporters: ["default", "json"],
    outputFile: { json: "../../qa/results/gateway.json" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "../../qa/coverage/gateway",
      thresholds: { lines: 80 },
    },
    include: ["../../tests/gateway/**/*.test.ts"],
    testTimeout: 30_000,
    maxWorkers: 4,
    hookTimeout: 30_000,
    execArgv: ["--expose-gc"],
  },
});
