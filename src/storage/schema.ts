import type { Database } from "better-sqlite3";

/**
 * Schema DDL (schema.md). Each section lands with its own task (DEV-102..105)
 * and is consolidated into migration 1 by the migration runner (DEV-106).
 *
 * Conventions (schema.md#conventions): snake_case columns, ISO-8601 text
 * timestamps, INTEGER 0/1 booleans, INTEGER PRIMARY KEY rowid aliases.
 */

/** Core tables (ported): indexed_files and code_chunks (schema.md#core-tables-ported). */
export const CORE_TABLES_DDL = `
CREATE TABLE indexed_files (
  id            INTEGER PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,   -- path relative to repo root
  language      TEXT NOT NULL,          -- 'javascript' | 'typescript' | 'tsx' | ...
  file_hash     TEXT NOT NULL,          -- SHA-256 hex of the file bytes
  last_indexed  TEXT NOT NULL,          -- ISO 8601
  chunk_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE code_chunks (
  id               INTEGER PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
  start_line       INTEGER NOT NULL,     -- 1-indexed, inclusive
  end_line         INTEGER NOT NULL,
  start_byte       INTEGER NOT NULL,     -- byte offsets into the source file
  end_byte         INTEGER NOT NULL,
  node_type        TEXT NOT NULL,        -- tree-sitter node type, e.g. 'function_declaration'
  node_name        TEXT,                 -- from the node's 'name' field, if present
  parent_node_type TEXT,
  content          TEXT NOT NULL,        -- source text, capped at 2000 chars (+ '...')
  context_path     TEXT NOT NULL,        -- e.g. 'class_declaration > method_definition'
  depth            INTEGER NOT NULL      -- nesting depth among meaningful nodes
);

CREATE INDEX idx_chunks_file_id   ON code_chunks(file_id);
CREATE INDEX idx_chunks_node_type ON code_chunks(node_type);
`;

/** Graph tables (new): symbols and edges (schema.md#graph-tables-new). */
export const GRAPH_TABLES_DDL = `
CREATE TABLE symbols (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
  chunk_id   INTEGER REFERENCES code_chunks(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,     -- function|class|method|variable|interface|type_alias|enum|module
  signature  TEXT,              -- one-line, token-cheap: 'parseFile(path, opts) → Chunk[]'
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  exported   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(file_id);

CREATE TABLE edges (
  id               INTEGER PRIMARY KEY,
  source_file_id   INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
  source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,  -- NULL = file/module scope
  edge_type        TEXT NOT NULL,   -- calls|imports|exports|references|extends|implements
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL, -- NULL = unresolved
  target_name      TEXT NOT NULL,   -- raw identifier as written; always populated
  target_module    TEXT,            -- import specifier: './db', 'react'
  line             INTEGER NOT NULL
);

CREATE INDEX idx_edges_source      ON edges(source_symbol_id);
CREATE INDEX idx_edges_target      ON edges(target_symbol_id);
CREATE INDEX idx_edges_target_name ON edges(target_name);
CREATE INDEX idx_edges_type        ON edges(edge_type);
`;

/**
 * Full-text search (new): external-content FTS5 mirror of code_chunks
 * (schema.md#full-text-search-new). The indexer only ever inserts and deletes
 * chunk rows (never updates), so insert/delete triggers are sufficient.
 */
export const FTS_DDL = `
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  node_name,
  content='code_chunks',
  content_rowid='id'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON code_chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, node_name)
  VALUES (new.id, new.content, new.node_name);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON code_chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, node_name)
  VALUES ('delete', old.id, old.content, old.node_name);
END;
`;

/** Apply the schema to a fresh database. (Interim entry point until DEV-106's migration runner owns this DDL as migration 1.) */
export function applySchema(db: Database): void {
  db.exec(CORE_TABLES_DDL);
  db.exec(GRAPH_TABLES_DDL);
  db.exec(FTS_DDL);
}
