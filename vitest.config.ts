import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Exclude integration tests — they need LocalStack running (use npm run test:integration)
    exclude: ["tests/integration/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/settings.ts", "src/changeView.ts"],
    },
  },
  resolve: {
    alias: {
      // Stub the Obsidian browser API for unit tests
      obsidian: resolve(__dirname, "tests/__mocks__/obsidian.ts"),
      // Stub localforage with an in-memory Map-backed implementation
      localforage: resolve(__dirname, "tests/__mocks__/localforage.ts"),
    },
  },
});
