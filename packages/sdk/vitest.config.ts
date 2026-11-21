import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { dedupe: ["vitest"] },
  test: { include: ["../../tests/sdk/**/*.test.ts"] },
});
