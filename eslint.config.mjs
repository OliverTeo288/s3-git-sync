import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import obsidianmdPkg from "eslint-plugin-obsidianmd";

const obsidianmd = obsidianmdPkg.default ?? obsidianmdPkg;

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "no-control-regex": "error",
      // The Obsidian sentence-case rule produces false positives for proper-noun
      // acronyms (AWS, URL, MinIO, Git) and AWS code-example placeholders
      // (us-east-1, default profile name). Downgraded
      // to a warning locally; the official validator bot still flags them as
      // errors and we /skip those with an explanation.
      "obsidianmd/ui/sentence-case": "warn",
    },
  },
  {
    ignores: ["main.js", "node_modules/**", "tests/**", "coverage/**"],
  },
];
