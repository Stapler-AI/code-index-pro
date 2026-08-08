import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

describe("graph tables (FR-103)", () => {
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

  function insertFile(relativePath: string): number {
    const info = db
      .prepare(
        `INSERT INTO indexed_files (relative_path, language, file_hash, last_indexed)
         VALUES (?, 'javascript', 'abc123', '2026-08-07T00:00:00.000Z')`,
      )
      .run(relativePath);
    return Number(info.lastInsertRowid);
  }

  function insertChunk(fileId: number): number {
    const info = db
      .prepare(
        `INSERT INTO code_chunks
           (file_id, start_line, end_line, start_byte, end_byte, node_type, node_name,
            parent_node_type, content, context_path, depth)
         VALUES (?, 1, 3, 0, 42, 'function_declaration', 'f', 'program',
                 'function f() {}', 'function_declaration', 0)`,
      )
      .run(fileId);
    return Number(info.lastInsertRowid);
  }

  function insertSymbol(fileId: number, chunkId: number | null, name = "f"): number {
    const info = db
      .prepare(
        `INSERT INTO symbols (file_id, chunk_id, name, kind, signature, start_line, end_line, exported)
         VALUES (?, ?, ?, 'function', ?, 1, 3, 1)`,
      )
      .run(fileId, chunkId, name, `${name}() → void`);
    return Number(info.lastInsertRowid);
  }

  function insertEdge(sourceFileId: number, sourceSymbolId: number | null, targetSymbolId: number | null): number {
    const info = db
      .prepare(
        `INSERT INTO edges (source_file_id, source_symbol_id, edge_type, target_symbol_id, target_name, target_module, line)
         VALUES (?, ?, 'calls', ?, 'g', NULL, 2)`,
      )
      .run(sourceFileId, sourceSymbolId, targetSymbolId);
    return Number(info.lastInsertRowid);
  }

  it("all six graph indexes exist", () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('symbols', 'edges')")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const expected of [
      "idx_symbols_name",
      "idx_symbols_file",
      "idx_edges_source",
      "idx_edges_target",
      "idx_edges_target_name",
      "idx_edges_type",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("deleting a file cascades to its symbols and edges", () => {
    const keepFile = insertFile("src/keep.js");
    const dropFile = insertFile("src/drop.js");
    const keepSym = insertSymbol(keepFile, null, "keep");
    const dropSym = insertSymbol(dropFile, null, "drop");
    insertEdge(keepFile, keepSym, null);
    insertEdge(dropFile, dropSym, null);

    db.prepare("DELETE FROM indexed_files WHERE id = ?").run(dropFile);

    const symbols = db.prepare("SELECT file_id FROM symbols").all() as { file_id: number }[];
    expect(symbols).toEqual([{ file_id: keepFile }]);
    const edges = db.prepare("SELECT source_file_id FROM edges").all() as { source_file_id: number }[];
    expect(edges).toEqual([{ source_file_id: keepFile }]);
  });

  it("deleting a chunk nulls symbols.chunk_id", () => {
    const fileId = insertFile("src/a.js");
    const chunkId = insertChunk(fileId);
    const symId = insertSymbol(fileId, chunkId);

    db.prepare("DELETE FROM code_chunks WHERE id = ?").run(chunkId);

    const row = db.prepare("SELECT chunk_id FROM symbols WHERE id = ?").get(symId) as {
      chunk_id: number | null;
    };
    expect(row.chunk_id).toBeNull();
  });

  it("deleting a target symbol nulls edges.target_symbol_id; deleting a source symbol removes the edge", () => {
    const fileId = insertFile("src/a.js");
    const source = insertSymbol(fileId, null, "caller");
    const target = insertSymbol(fileId, null, "callee");
    const edgeId = insertEdge(fileId, source, target);

    db.prepare("DELETE FROM symbols WHERE id = ?").run(target);
    const afterTargetDelete = db.prepare("SELECT target_symbol_id FROM edges WHERE id = ?").get(edgeId) as {
      target_symbol_id: number | null;
    };
    expect(afterTargetDelete.target_symbol_id).toBeNull();

    db.prepare("DELETE FROM symbols WHERE id = ?").run(source);
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges").get()).toEqual({ n: 0 });
  });
});
