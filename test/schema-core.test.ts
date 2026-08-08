import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database";
import { applySchema } from "../src/storage/schema";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function columns(db: Database, table: string): Map<string, ColumnInfo> {
  const rows = db.pragma(`table_info(${table})`) as ColumnInfo[];
  return new Map(rows.map((r) => [r.name, r]));
}

function indexNames(db: Database, table: string): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
    .all(table) as { name: string }[];
  return rows.map((r) => r.name);
}

describe("core tables (FR-102)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    db = openDatabase(repo.root);
    applySchema(db);
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

  it("indexed_files has the spec'd columns, types, and constraints", () => {
    const cols = columns(db, "indexed_files");
    expect([...cols.keys()]).toEqual([
      "id",
      "relative_path",
      "language",
      "file_hash",
      "last_indexed",
      "chunk_count",
    ]);
    expect(cols.get("id")!.pk).toBe(1);
    expect(cols.get("id")!.type).toBe("INTEGER");
    for (const name of ["relative_path", "language", "file_hash", "last_indexed"]) {
      expect(cols.get(name)!.type, name).toBe("TEXT");
      expect(cols.get(name)!.notnull, name).toBe(1);
    }
    expect(cols.get("chunk_count")!.type).toBe("INTEGER");
    expect(cols.get("chunk_count")!.notnull).toBe(1);
    expect(cols.get("chunk_count")!.dflt_value).toBe("0");
  });

  it("code_chunks has the spec'd columns, types, and constraints", () => {
    const cols = columns(db, "code_chunks");
    expect([...cols.keys()]).toEqual([
      "id",
      "file_id",
      "start_line",
      "end_line",
      "start_byte",
      "end_byte",
      "node_type",
      "node_name",
      "parent_node_type",
      "content",
      "context_path",
      "depth",
    ]);
    expect(cols.get("id")!.pk).toBe(1);
    const integerNotNull = ["file_id", "start_line", "end_line", "start_byte", "end_byte", "depth"];
    for (const name of integerNotNull) {
      expect(cols.get(name)!.type, name).toBe("INTEGER");
      expect(cols.get(name)!.notnull, name).toBe(1);
    }
    for (const name of ["node_type", "content", "context_path"]) {
      expect(cols.get(name)!.type, name).toBe("TEXT");
      expect(cols.get(name)!.notnull, name).toBe(1);
    }
    for (const name of ["node_name", "parent_node_type"]) {
      expect(cols.get(name)!.type, name).toBe("TEXT");
      expect(cols.get(name)!.notnull, name).toBe(0);
    }
  });

  it("code_chunks.file_id references indexed_files with ON DELETE CASCADE", () => {
    const fks = db.pragma("foreign_key_list(code_chunks)") as {
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }[];
    expect(fks).toHaveLength(1);
    expect(fks[0].table).toBe("indexed_files");
    expect(fks[0].from).toBe("file_id");
    expect(fks[0].on_delete).toBe("CASCADE");
  });

  it("has idx_chunks_file_id and idx_chunks_node_type", () => {
    const names = indexNames(db, "code_chunks");
    expect(names).toContain("idx_chunks_file_id");
    expect(names).toContain("idx_chunks_node_type");
  });

  it("rejects a duplicate relative_path", () => {
    insertFile("src/a.js");
    expect(() => insertFile("src/a.js")).toThrow(/UNIQUE/);
  });

  it("deleting an indexed_files row cascades to its code_chunks", () => {
    const keepId = insertFile("src/keep.js");
    const dropId = insertFile("src/drop.js");
    insertChunk(keepId);
    insertChunk(dropId);
    insertChunk(dropId);

    db.prepare("DELETE FROM indexed_files WHERE id = ?").run(dropId);

    const remaining = db.prepare("SELECT file_id FROM code_chunks").all() as { file_id: number }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].file_id).toBe(keepId);
  });
});
