import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPipeline } from "../src/pipeline/run";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

function totalChanges(db: Database): number {
  return (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

function lastIndexedByPath(db: Database): Map<string, string> {
  const rows = db.prepare("SELECT relative_path, last_indexed FROM indexed_files").all() as {
    relative_path: string;
    last_indexed: string;
  }[];
  return new Map(rows.map((r) => [r.relative_path, r.last_indexed]));
}

describe("pipeline orchestration (FR-206)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    db = openDatabase(repo.root);
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
    repo.cleanup();
  });

  it("first run indexes every eligible fixture file, with chunks persisted", () => {
    const delta = runPipeline(db, repo.root);

    const paths = [...lastIndexedByPath(db).keys()].sort();
    // Eligible = js/ts/tsx only; README.md and .gitignore are skipped.
    expect(paths).toEqual(["src/component.tsx", "src/greet.ts", "src/math.js"]);
    expect(delta.filesAdded).toBe(3);
    expect(delta.filesUpdated).toBe(0);
    expect(delta.filesRemoved).toBe(0);
    expect(delta.durationMs).toBeGreaterThanOrEqual(0);

    const chunkCount = (db.prepare("SELECT COUNT(*) AS n FROM code_chunks").get() as { n: number }).n;
    expect(chunkCount).toBeGreaterThan(0);
  });

  it("an immediate second run performs zero row writes", () => {
    runPipeline(db, repo.root);
    const before = lastIndexedByPath(db);
    const changesBefore = totalChanges(db);

    const delta = runPipeline(db, repo.root);

    expect(totalChanges(db)).toBe(changesBefore);
    expect(lastIndexedByPath(db)).toEqual(before);
    expect(delta).toMatchObject({ filesAdded: 0, filesUpdated: 0, filesRemoved: 0 });
  });

  it("editing one file re-indexes only that file", () => {
    runPipeline(db, repo.root);
    const before = lastIndexedByPath(db);

    repo.edit("src/greet.ts", (c) => c.replace("Hello", "Howdy"));
    const delta = runPipeline(db, repo.root);

    expect(delta).toMatchObject({ filesAdded: 0, filesUpdated: 1, filesRemoved: 0 });
    const after = lastIndexedByPath(db);
    for (const [path, stamp] of before) {
      if (path === "src/greet.ts") continue;
      expect(after.get(path), path).toBe(stamp);
    }
    const chunk = db
      .prepare(
        `SELECT c.content FROM code_chunks c
         JOIN indexed_files f ON f.id = c.file_id
         WHERE f.relative_path = 'src/greet.ts' AND c.content LIKE '%Howdy%'`,
      )
      .get();
    expect(chunk).toBeDefined();
  });

  it("a deleted file is pruned and counted in the delta", () => {
    runPipeline(db, repo.root);
    repo.remove("src/math.js");

    const delta = runPipeline(db, repo.root);

    expect(delta).toMatchObject({ filesAdded: 0, filesUpdated: 0, filesRemoved: 1 });
    expect(db.prepare("SELECT * FROM indexed_files WHERE relative_path = 'src/math.js'").get()).toBeUndefined();
  });

  it("calls the extraction hook per changed file (same tree, no re-parse) and persists its rows", () => {
    const seen: { relativePath: string; chunkCount: number; treeOk: boolean }[] = [];
    runPipeline(db, repo.root, {
      extract: ({ relativePath, tree, content, chunks }) => {
        seen.push({
          relativePath,
          chunkCount: chunks.length,
          treeOk: tree.rootNode.text === content,
        });
        return {
          symbols: [
            { chunkIndex: null, name: `sym:${relativePath}`, kind: "module", signature: null, startLine: 1, endLine: 1, exported: false },
          ],
          edges: [],
        };
      },
    });

    expect(seen.map((s) => s.relativePath).sort()).toEqual([
      "src/component.tsx",
      "src/greet.ts",
      "src/math.js",
    ]);
    for (const s of seen) {
      expect(s.treeOk, s.relativePath).toBe(true);
      expect(s.chunkCount).toBeGreaterThan(0);
    }
    const symbolNames = (db.prepare("SELECT name FROM symbols ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(symbolNames).toEqual(["sym:src/component.tsx", "sym:src/greet.ts", "sym:src/math.js"]);
  });

  it("runs the resolution hook once per run, after all changed files are persisted", () => {
    const calls: { changedPaths: string[]; persistedRows: number }[] = [];
    const hooks = {
      resolve: (hookDb: Database, changedFiles: { relativePath: string }[]) => {
        calls.push({
          changedPaths: changedFiles.map((f) => f.relativePath).sort(),
          persistedRows: (hookDb.prepare("SELECT COUNT(*) AS n FROM indexed_files").get() as { n: number }).n,
        });
      },
    };

    runPipeline(db, repo.root, hooks);
    expect(calls).toHaveLength(1);
    expect(calls[0].changedPaths).toEqual(["src/component.tsx", "src/greet.ts", "src/math.js"]);
    expect(calls[0].persistedRows).toBe(3); // every changed file already written

    // Unchanged second run: hook still called exactly once, with an empty change set.
    runPipeline(db, repo.root, hooks);
    expect(calls).toHaveLength(2);
    expect(calls[1].changedPaths).toEqual([]);
  });

  it("prunes stale files before the resolution hook runs", () => {
    runPipeline(db, repo.root);
    repo.remove("src/math.js");

    let mathRowsAtResolveTime = -1;
    runPipeline(db, repo.root, {
      resolve: (hookDb) => {
        mathRowsAtResolveTime = (
          hookDb
            .prepare("SELECT COUNT(*) AS n FROM indexed_files WHERE relative_path = 'src/math.js'")
            .get() as { n: number }
        ).n;
      },
    });

    // The deleted file's rows are already gone when resolution runs, so its
    // symbols cannot create phantom ambiguity or attract doomed links.
    expect(mathRowsAtResolveTime).toBe(0);
  });
});
