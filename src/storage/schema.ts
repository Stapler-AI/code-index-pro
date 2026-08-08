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

/** Apply the schema to a fresh database. (Interim entry point until DEV-106's migration runner owns this DDL as migration 1.) */
export function applySchema(db: Database): void {
  db.exec(CORE_TABLES_DDL);
}
