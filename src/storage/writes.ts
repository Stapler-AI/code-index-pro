import type { Database } from "better-sqlite3";

/**
 * Indexer write patterns (FR-108, schema.md#write-patterns). Replacement is
 * always delete-then-insert (never update) — that keeps the FTS insert/delete
 * triggers sufficient. writeFile wraps everything for one file in a single
 * transaction so readers never see a half-indexed file.
 */

export interface FileInput {
  relativePath: string;
  language: string;
  fileHash: string;
  lastIndexed: string; // ISO-8601
}

export interface ChunkInput {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  nodeType: string;
  nodeName: string | null;
  parentNodeType: string | null;
  content: string;
  contextPath: string;
  depth: number;
}

export interface SymbolInput {
  /** Index into the chunks array of the symbol's body chunk, or null. */
  chunkIndex: number | null;
  name: string;
  kind: string;
  signature: string | null;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface EdgeInput {
  /** Index into the symbols array of the innermost enclosing symbol, or null at file scope. */
  sourceSymbolIndex: number | null;
  edgeType: string;
  targetName: string;
  targetModule: string | null;
  line: number;
}

/** Insert or update indexed_files by relative_path; returns the row id. */
export function upsertFile(db: Database, file: FileInput): number {
  const existing = db
    .prepare("SELECT id FROM indexed_files WHERE relative_path = ?")
    .get(file.relativePath) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE indexed_files SET language = ?, file_hash = ?, last_indexed = ? WHERE id = ?").run(
      file.language,
      file.fileHash,
      file.lastIndexed,
      existing.id,
    );
    return existing.id;
  }
  const info = db
    .prepare(
      "INSERT INTO indexed_files (relative_path, language, file_hash, last_indexed) VALUES (?, ?, ?, ?)",
    )
    .run(file.relativePath, file.language, file.fileHash, file.lastIndexed);
  return Number(info.lastInsertRowid);
}

/**
 * Delete-then-insert a file's chunks (FTS triggers keep the mirror in sync)
 * and maintain chunk_count. Returns inserted chunk ids in input order.
 * Not transactional on its own — call within a transaction (or use writeFile).
 */
export function replaceChunks(db: Database, fileId: number, chunks: ChunkInput[]): number[] {
  db.prepare("DELETE FROM code_chunks WHERE file_id = ?").run(fileId);
  const insert = db.prepare(
    `INSERT INTO code_chunks
       (file_id, start_line, end_line, start_byte, end_byte, node_type, node_name,
        parent_node_type, content, context_path, depth)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids = chunks.map((c) =>
    Number(
      insert.run(
        fileId,
        c.startLine,
        c.endLine,
        c.startByte,
        c.endByte,
        c.nodeType,
        c.nodeName,
        c.parentNodeType,
        c.content,
        c.contextPath,
        c.depth,
      ).lastInsertRowid,
    ),
  );
  db.prepare("UPDATE indexed_files SET chunk_count = ? WHERE id = ?").run(chunks.length, fileId);
  return ids;
}

/**
 * Delete-then-insert a file's symbols and edges. chunkIds maps each symbol's
 * chunkIndex to a code_chunks row id (from replaceChunks). Edges are written
 * with target_symbol_id = NULL — resolution is a separate pass (FR-304).
 * Returns inserted symbol ids in input order.
 * Not transactional on its own — call within a transaction (or use writeFile).
 */
export function replaceGraphRows(
  db: Database,
  fileId: number,
  symbols: SymbolInput[],
  edges: EdgeInput[],
  chunkIds: number[],
): number[] {
  db.prepare("DELETE FROM edges WHERE source_file_id = ?").run(fileId);
  db.prepare("DELETE FROM symbols WHERE file_id = ?").run(fileId);

  const insertSymbol = db.prepare(
    `INSERT INTO symbols (file_id, chunk_id, name, kind, signature, start_line, end_line, exported)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const symbolIds = symbols.map((s) =>
    Number(
      insertSymbol.run(
        fileId,
        s.chunkIndex === null ? null : chunkIds[s.chunkIndex],
        s.name,
        s.kind,
        s.signature,
        s.startLine,
        s.endLine,
        s.exported ? 1 : 0,
      ).lastInsertRowid,
    ),
  );

  const insertEdge = db.prepare(
    `INSERT INTO edges (source_file_id, source_symbol_id, edge_type, target_symbol_id, target_name, target_module, line)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  );
  for (const e of edges) {
    insertEdge.run(
      fileId,
      e.sourceSymbolIndex === null ? null : symbolIds[e.sourceSymbolIndex],
      e.edgeType,
      e.targetName,
      e.targetModule,
      e.line,
    );
  }
  return symbolIds;
}

export interface FileWrite {
  file: FileInput;
  chunks: ChunkInput[];
  symbols: SymbolInput[];
  edges: EdgeInput[];
}

/**
 * Persist one file's rows atomically: upsert + replace chunks/symbols/edges
 * in a single transaction. Returns the file id.
 */
export function writeFile(db: Database, write: FileWrite): number {
  return db.transaction(() => {
    const fileId = upsertFile(db, write.file);
    const chunkIds = replaceChunks(db, fileId, write.chunks);
    replaceGraphRows(db, fileId, write.symbols, write.edges, chunkIds);
    return fileId;
  })();
}

/**
 * Delete indexed_files rows whose relative_path was not seen during
 * discovery; cascades remove their chunks, symbols, and edges. Returns the
 * pruned paths.
 */
export function pruneStale(db: Database, seenPaths: Iterable<string>): string[] {
  const seen = new Set(seenPaths);
  const rows = db.prepare("SELECT id, relative_path FROM indexed_files").all() as {
    id: number;
    relative_path: string;
  }[];
  const del = db.prepare("DELETE FROM indexed_files WHERE id = ?");
  const pruned: string[] = [];
  db.transaction(() => {
    for (const row of rows) {
      if (!seen.has(row.relative_path)) {
        del.run(row.id);
        pruned.push(row.relative_path);
      }
    }
  })();
  return pruned;
}
