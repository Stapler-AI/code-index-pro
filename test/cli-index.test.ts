import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function rowCounts(db: Database): Record<string, number> {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    files: count("indexed_files"),
    chunks: count("code_chunks"),
    fts: count("chunks_fts"),
  };
}

describe("code-index index (FR-701 / FR-700)", () => {
  let repo: FixtureRepo;
  afterEach(() => repo?.cleanup());

  it("first run populates the database and prints the delta", () => {
    repo = buildFixtureRepo({ git: true });

    const { exitCode, stdout } = runCli("index", repo.root);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/3 added, 0 updated, 0 removed in \d+ ms/);

    const db = openIndexDb(repo.root);
    try {
      const counts = rowCounts(db);
      expect(counts.files).toBe(3); // src/math.js, src/greet.ts, src/component.tsx
      expect(counts.chunks).toBeGreaterThan(0);
      expect(counts.fts).toBe(counts.chunks);
    } finally {
      db.close();
    }
  });

  it("--full after an edit rebuilds from empty and converges to the same row counts", () => {
    repo = buildFixtureRepo({ git: true });
    runCli("index", repo.root);

    repo.edit("src/greet.ts", (c) => c.replace("Hello", "Howdy"));
    const incremental = runCli("index", repo.root);
    expect(incremental.stdout).toMatch(/0 added, 1 updated, 0 removed/);

    const before = (() => {
      const db = openIndexDb(repo.root);
      try {
        return rowCounts(db);
      } finally {
        db.close();
      }
    })();

    const full = runCli("index", repo.root, "--full");
    expect(full.exitCode).toBe(0);
    // Rebuilt from empty: every file is re-added, none merely updated.
    expect(full.stdout).toMatch(/3 added, 0 updated, 0 removed/);

    const db = openIndexDb(repo.root);
    try {
      expect(rowCounts(db)).toEqual(before);
      const howdy = db
        .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'Howdy'")
        .all();
      expect(howdy.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("recovers a corrupted index, reports it, and clears the reindex flag after the run", () => {
    repo = buildFixtureRepo({ git: true });
    runCli("index", repo.root);
    repo.write(".code-index/index.db", "garbage, not sqlite");

    const { exitCode, stdout } = runCli("index", repo.root);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("quarantined and rebuilt");
    expect(stdout).toMatch(/3 added, 0 updated, 0 removed/);
    const db = openIndexDb(repo.root);
    try {
      const flag = db.prepare("SELECT value FROM meta WHERE key = 'reindex_required'").get();
      expect(flag).toBeUndefined(); // cleared by the successful full run
      expect(rowCounts(db).files).toBe(3);
    } finally {
      db.close();
    }
  });

  it("unknown commands exit 1 with usage", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(main(["bogus"])).toBe(1);
      const err = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(err).toContain("unknown or not-yet-implemented command: bogus");
      expect(err).toContain("Usage: code-index");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
