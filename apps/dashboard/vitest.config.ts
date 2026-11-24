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
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "../../coverage/dashboard",
    },
    environment: "jsdom",
    include: ["../../tests/dashboard/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
