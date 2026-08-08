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

describe("code-index stats (FR-702)", () => {
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

  it("output matches direct SQL counts per language, unresolved edges, and last run", () => {
    runCli("index", repo.root);
    process.chdir(repo.root);

    const { exitCode, stdout } = runCli("stats");
    expect(exitCode).toBe(0);

    const db = openIndexDb(repo.root);
    try {
      const expected = db
        .prepare(
          `SELECT f.language,
                  COUNT(*) AS files,
                  (SELECT COUNT(*) FROM code_chunks c JOIN indexed_files fi ON fi.id = c.file_id
                    WHERE fi.language = f.language) AS chunks,
                  (SELECT COUNT(*) FROM symbols s JOIN indexed_files fi ON fi.id = s.file_id
                    WHERE fi.language = f.language) AS symbols
           FROM indexed_files f GROUP BY f.language`,
        )
        .all() as { language: string; files: number; chunks: number; symbols: number }[];
      expect(expected.length).toBe(3); // javascript, typescript, tsx

      for (const row of expected) {
        const line = new RegExp(
          `^\\s{2}${row.language}: ${row.files} files, ${row.chunks} chunks, ${row.symbols} symbols$`,
          "m",
        );
        expect(stdout).toMatch(line);
        expect(row.symbols).toBeGreaterThan(0); // M3 graph hooks are wired into the CLI
        expect(row.chunks).toBeGreaterThan(0);
      }

      const unresolved = (
        db.prepare("SELECT COUNT(*) AS n FROM edges WHERE target_symbol_id IS NULL").get() as { n: number }
      ).n;
      expect(stdout).toMatch(new RegExp(`^\\s{2}unresolved edges: ${unresolved}$`, "m"));

      const lastRun = (
        db.prepare("SELECT MAX(last_indexed) AS t FROM indexed_files").get() as { t: string }
      ).t;
      expect(stdout).toContain(`last run: ${lastRun}`);
    } finally {
      db.close();
    }
  });

  it("surfaces a quarantine-and-rebuild instead of silently reporting an empty index", () => {
    runCli("index", repo.root);
    // Simulate a copied database: tamper repo_root so the health check fails.
    const db = openIndexDb(repo.root);
    db.prepare("UPDATE meta SET value = '/somewhere/else' WHERE key = 'repo_root'").run();
    db.close();

    process.chdir(repo.root);
    const { exitCode, stdout } = runCli("stats");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("quarantined and rebuilt");
    expect(stdout).toContain("(empty index)");
  });

  it("reports an empty index and 'last run: never' before any indexing", () => {
    process.chdir(repo.root);
    const { exitCode, stdout } = runCli("stats");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("(empty index)");
    expect(stdout).toContain("unresolved edges: 0");
    expect(stdout).toContain("last run: never");
  });
});
