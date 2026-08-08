import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateFile } from "../src/pipeline/changes";
import { extractChunks, parseSource } from "../src/pipeline/chunks";
import { discoverFiles } from "../src/pipeline/discovery";
import { detectLanguage } from "../src/pipeline/language";
import { pruneUnseenFiles } from "../src/pipeline/prune";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { writeFile } from "../src/storage/writes";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

/** Minimal real indexing pass: discover -> detect -> diff -> chunk -> persist. */
function indexAll(db: Database, root: string): string[] {
  const discovered = discoverFiles(root);
  for (const relativePath of discovered) {
    const language = detectLanguage(relativePath);
    if (language === null) continue;
    const decision = evaluateFile(db, root, relativePath);
    if (decision.action !== "index") continue;
    const tree = parseSource(language, decision.content);
    writeFile(db, {
      file: { relativePath, language, fileHash: decision.fileHash, lastIndexed: new Date().toISOString() },
      chunks: extractChunks(tree, decision.content, language),
      symbols: [
        { chunkIndex: null, name: relativePath, kind: "module", signature: null, startLine: 1, endLine: 1, exported: false },
      ],
      edges: [{ sourceSymbolIndex: 0, edgeType: "references", targetName: "x", targetModule: null, line: 1 }],
    });
  }
  return discovered;
}

describe("stale pruning (FR-205 / FR-200)", () => {
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

  it("removes a deleted file's rows (files, chunks, FTS, symbols, edges) via cascade", () => {
    indexAll(db, repo.root);
    const victimId = (
      db.prepare("SELECT id FROM indexed_files WHERE relative_path = 'src/math.js'").get() as { id: number }
    ).id;
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE file_id = ?").get(victimId) as { n: number }).n,
    ).toBeGreaterThan(0);

    repo.remove("src/math.js");
    const rediscovered = discoverFiles(repo.root);
    const pruned = pruneUnseenFiles(db, rediscovered);

    expect(pruned).toEqual(["src/math.js"]);
    expect(db.prepare("SELECT * FROM indexed_files WHERE relative_path = 'src/math.js'").get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM code_chunks WHERE file_id = ?").get(victimId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM symbols WHERE file_id = ?").get(victimId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE source_file_id = ?").get(victimId)).toEqual({ n: 0 });
    // FTS mirror stays consistent with the surviving chunks.
    const chunkCount = (db.prepare("SELECT COUNT(*) AS n FROM code_chunks").get() as { n: number }).n;
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get()).toEqual({ n: chunkCount });
    expect(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'multiply'").all()).toEqual([]);
  });

  it("keeps rows for files still present in discovery (including skipped-unchanged ones)", () => {
    indexAll(db, repo.root);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM indexed_files").get() as { n: number }).n;
    expect(before).toBeGreaterThan(1);

    // Nothing deleted: re-discovery sees every path, so prune must be a no-op.
    const rediscovered = discoverFiles(repo.root);
    const pruned = pruneUnseenFiles(db, rediscovered);

    expect(pruned).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM indexed_files").get() as { n: number }).n).toBe(before);
  });
});
