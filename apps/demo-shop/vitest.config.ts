import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["vitest"],
  },
  test: {
    reporters: ["default", "json"],
    outputFile: { json: "../../qa/results/demo-shop.json" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "../../qa/coverage/demo-shop",
    },
    environment: "node",
    include: ["../../tests/demo-shop/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
