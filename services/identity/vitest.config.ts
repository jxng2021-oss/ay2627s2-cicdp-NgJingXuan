import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["vitest", "fastify", "drizzle-orm", "@electric-sql/pglite"],
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "../../coverage/identity",
    },
    include: ["../../tests/identity/**/*.test.ts"],
    testTimeout: 30_000,
    maxWorkers: 4,
    hookTimeout: 30_000,
  },
});
