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
    include: ["../../tests/gateway/**/*.test.ts"],
    testTimeout: 30_000,
    maxWorkers: 4,
    hookTimeout: 30_000,
    execArgv: ["--expose-gc"],
  },
});
