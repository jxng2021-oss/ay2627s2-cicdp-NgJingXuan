import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { dedupe: ["vitest"] },
  test: {
    include: ["../../tests/sdk/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "../../coverage/sdk",
    },
  },
});
