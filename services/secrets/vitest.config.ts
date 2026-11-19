import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: [
      "vitest",
      "fastify",
      "drizzle-orm",
      "@electric-sql/pglite",
      "shamir-secret-sharing",
    ],
  },
  test: {
    include: ["../../tests/secrets/**/*.test.ts"],
    testTimeout: 30_000,
    maxWorkers: 4,
    hookTimeout: 30_000,
  },
});
