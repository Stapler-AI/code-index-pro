import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { openIndexDb } from "./helpers/db";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

function runCli(...argv: string[]): { exitCode: number; stdout: string } {
  let stdout = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  try {
    const exitCode = main(argv);
    return { exitCode, stdout };
  } finally {
    spy.mockRestore();
  }
}

describe("code-index clear (FR-703)", () => {
  let repo: FixtureRepo;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = buildFixtureRepo({ git: true });
  });
  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("after indexing, clear removes the whole .code-index/ directory", () => {
    runCli("index", repo.root);
    expect(existsSync(join(repo.root, ".code-index"))).toBe(true);

    process.chdir(repo.root);
    const { exitCode, stdout } = runCli("clear");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed");
    expect(existsSync(join(repo.root, ".code-index"))).toBe(false);
  });

  it("a subsequent index run works from scratch", () => {
    runCli("index", repo.root);
    process.chdir(repo.root);
    runCli("clear");

    const { exitCode, stdout } = runCli("index", repo.root);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/3 added, 0 updated, 0 removed/);
    const db = openIndexDb(repo.root);
    try {
      const files = (db.prepare("SELECT COUNT(*) AS n FROM indexed_files").get() as { n: number }).n;
      expect(files).toBe(3);
    } finally {
      db.close();
    }
  });

  it("clear without an index reports there is nothing to do", () => {
    process.chdir(repo.root);
    const { exitCode, stdout } = runCli("clear");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No index to clear.");
  });
});
