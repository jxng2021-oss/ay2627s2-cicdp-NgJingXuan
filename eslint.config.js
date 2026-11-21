import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ["*.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: [
      "apps/dashboard/src/**/*.{ts,tsx}",
      "tests/dashboard/**/*.{ts,tsx}",
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["apps/demo-shop/src/**/*.{ts,tsx}", "tests/demo-shop/**/*.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
