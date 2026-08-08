import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database";
import { applySchema } from "../src/storage/schema";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

describe("FTS5 mirror (FR-104)", () => {
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

  function insertChunk(fileId: number, nodeName: string, content: string): number {
    const info = db
      .prepare(
        `INSERT INTO code_chunks
           (file_id, start_line, end_line, start_byte, end_byte, node_type, node_name,
            parent_node_type, content, context_path, depth)
         VALUES (?, 1, 3, 0, 42, 'function_declaration', ?, 'program', ?, 'function_declaration', 0)`,
      )
      .run(fileId, nodeName, content);
    return Number(info.lastInsertRowid);
  }

  function matchIds(query: string): number[] {
    const rows = db
      .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?")
      .all(query) as { rowid: number }[];
    return rows.map((r) => r.rowid);
  }

  it("inserted chunks are findable via MATCH on content and on node_name", () => {
    const fileId = insertFile("src/a.js");
    const chunkId = insertChunk(fileId, "sanitizeInput", "function sanitizeInput(raw) { return raw.trim(); }");

    expect(matchIds("content: trim")).toEqual([chunkId]);
    expect(matchIds("node_name: sanitizeInput")).toEqual([chunkId]);
  });

  it("stays consistent through repeated insert -> delete -> insert cycles", () => {
    const fileId = insertFile("src/a.js");

    for (let cycle = 0; cycle < 3; cycle++) {
      const id = insertChunk(fileId, `ephemeral${cycle}`, `function ephemeral${cycle}() { return ${cycle}; }`);
      db.prepare("DELETE FROM code_chunks WHERE id = ?").run(id);
    }
    const survivorId = insertChunk(fileId, "survivor", "function survivor() { return 'kept'; }");

    const chunkCount = (db.prepare("SELECT COUNT(*) AS n FROM code_chunks").get() as { n: number }).n;
    const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n;
    expect(chunkCount).toBe(1);
    expect(ftsCount).toBe(chunkCount);

    expect(matchIds("ephemeral0")).toEqual([]);
    expect(matchIds("ephemeral1")).toEqual([]);
    expect(matchIds("ephemeral2")).toEqual([]);
    expect(matchIds("survivor")).toEqual([survivorId]);
  });

  it("supports the spec's bm25()-ordered join with snippet()", () => {
    const fileId = insertFile("src/search.js");
    insertChunk(fileId, "parseQuery", "function parseQuery(input) { return query(input); }");
    insertChunk(fileId, "runQuery", "function runQuery(query) { return query + query; }");

    const rows = db
      .prepare(
        `SELECT c.id, f.relative_path, c.start_line, c.end_line, c.node_type, c.node_name,
                c.context_path, snippet(chunks_fts, 0, '«', '»', '…', 12) AS excerpt
         FROM chunks_fts
         JOIN code_chunks c   ON c.id = chunks_fts.rowid
         JOIN indexed_files f ON f.id = c.file_id
         WHERE chunks_fts MATCH ?
         ORDER BY bm25(chunks_fts)
         LIMIT 20`,
      )
      .all("query") as Record<string, unknown>[];

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["id", "relative_path", "start_line", "end_line", "node_type", "node_name", "context_path", "excerpt"].sort(),
      );
      expect(row.relative_path).toBe("src/search.js");
      expect(row.excerpt).toContain("«query»");
    }
    // bm25: the chunk with more occurrences of the term ranks first.
    expect(rows[0].node_name).toBe("runQuery");
  });
});
