import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Native addons (better-sqlite3, tree-sitter) must load in real processes.
    pool: "forks",
  },
});
