import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Native addons (better-sqlite3, tree-sitter) must load in real processes.
    pool: "forks",
    // Integration-style tests spawn git and node subprocesses; the 5s default
    // flakes under parallel-fork contention.
    testTimeout: 30_000,
  },
});
