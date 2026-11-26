import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["vitest", "react", "react-dom", "@testing-library/react", "next"],
  },
  test: {
    reporters: ["default", "json"],
    outputFile: { json: "../../qa/results/dashboard.json" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "../../qa/coverage/dashboard",
      thresholds: { lines: 80 },
    },
    environment: "jsdom",
    include: ["../../tests/dashboard/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
