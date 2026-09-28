import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["main.js", "styles.css", "dev-vault/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.mjs", "scripts/**"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["test/fakes/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
