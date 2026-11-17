// ESLint for the extension (src/), the website (site/), build scripts and tests. Types are checked
// by `tsc --noEmit` (pnpm typecheck, part of pnpm check; site/ by pnpm site:build).
// Formatting is Prettier's (pnpm format).
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["dist/**", "site/dist/**", "safari/**", "_metadata/**", "node_modules/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // ignoreRestSiblings: `const { omitted, ...rest } = value` keeps `omitted` off the spread.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      // `x != null` (null or undefined) stays allowed.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "array-callback-return": ["error", { checkForEach: true }],
      "no-promise-executor-return": "error",
    },
  },
  // Type-aware rules for every TypeScript file: src/ (tsconfig.json), tests/ (tests/tsconfig.json) and
  // site/ (site/tsconfig.json, whose types come from the workspace install, `pnpm install`).
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        // vitest.config.ts sits outside every tsconfig; the default project covers it.
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
  // The extension and the website run in the browser.
  {
    files: ["src/**/*.ts", "site/src/**/*.ts"],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  // Each extension script is bundled into one classic script (scripts/build.mjs): static imports
  // are inlined, but a dynamic import() would try to load a file at run time.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Extension scripts are bundled into classic scripts: use a static import instead.",
        },
      ],
    },
  },
  // Build scripts, configs and tests run in Node; e2e tests also evaluate code inside pages and the extension.
  {
    files: [
      "scripts/**/*.mjs",
      "tests/**/*.mjs",
      "tests/*.ts",
      "*.config.js",
      "*.config.ts",
      "site/*.config.ts",
    ],
    languageOptions: { sourceType: "module", globals: { ...globals.node } },
  },
  {
    files: ["tests/e2e/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions, renderSite: "readonly" },
    },
  },
);
