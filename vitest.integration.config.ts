import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Network I/O to LocalStack takes time
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run sequentially — each test mutates shared S3 state
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      // Platform.isDesktop = false → uses FetchHttpHandler (real Node.js fetch)
      obsidian: resolve(__dirname, "tests/__mocks__/obsidian.mobile.ts"),
      localforage: resolve(__dirname, "tests/__mocks__/localforage.ts"),
    },
  },
});
