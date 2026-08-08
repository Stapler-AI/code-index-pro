# Database Schema

The code index is a single SQLite database per indexed repository. It is the contract between the writers (the [indexer pipeline](indexing.md)) and the readers (the [query layer](search.md), the [AST graph](ast-graph.md), and the [MCP server](mcp-server.md)).

> **Status:** target design. The core tables (`indexed_files`, `code_chunks`) are ported from the Swift/GRDB reference implementation (`CodeIndexDatabase.swift`, `CodeIndexModels.swift` in stapler-workstation-native). The graph tables (`symbols`, `edges`), FTS5, and the `meta` table are new.

## Overview

- **One database per repo**, stored at `.code-index/index.db` inside the indexed repository. The `.code-index/` directory must be gitignored and is excluded from indexing.
- **Driver:** `better-sqlite3` (synchronous API; see [decision log](architecture.md#decision-log)).
- **Pragmas:** `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`.
- **The database is a cache, never a source of truth.** Every row is derivable from the working tree. Deleting or rebuilding the database is always safe — this stance drives the [recovery strategy](#health-check-and-recovery).

## Conventions

- `snake_case` column names. *(Divergence from the Swift reference, which uses camelCase — the two database formats are **not** interchangeable.)*
- Timestamps are ISO-8601 text (e.g. `2026-08-07T18:30:00.000Z`).
- Primary keys are `INTEGER PRIMARY KEY` (SQLite rowid aliases).
- Booleans are `INTEGER` 0/1.

## Core tables (ported)

### `indexed_files`

One row per file currently in the index. Acts as the module node of the [AST graph](ast-graph.md).

```sql
CREATE TABLE indexed_files (
  id            INTEGER PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,   -- path relative to repo root
  language      TEXT NOT NULL,          -- 'javascript' | 'typescript' | 'tsx' | ...
  file_hash     TEXT NOT NULL,          -- SHA-256 hex of the file bytes
  last_indexed  TEXT NOT NULL,          -- ISO 8601
  chunk_count   INTEGER NOT NULL DEFAULT 0
);
```

| Column | Semantics |
|---|---|
| `relative_path` | As reported by `git ls-files`; forward slashes; unique — an upsert key. |
| `language` | Detected from the extension table in [indexing.md](indexing.md#language-detection). |
| `file_hash` | SHA-256 of raw bytes. Change detection: if the hash matches, the file is skipped on re-index. |
| `chunk_count` | Denormalized count of `code_chunks` rows, maintained by the indexer. |

### `code_chunks`

One row per *meaningful* AST node (per-language node-type allowlist — see [indexing.md](indexing.md#chunk-extraction)). This is the retrieval unit: search results point at chunks, and `get_chunk` returns one chunk body.

```sql
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
```

| Column | Semantics |
|---|---|
| `content` | Capped at 2000 characters with a trailing `...` when truncated. Keeps blobs bounded; tradeoff: truncated tails are invisible to FTS (accepted for v1 — see [indexing.md](indexing.md#chunk-extraction)). |
| `context_path` | Breadcrumb of enclosing meaningful node types joined with `" > "`. A cheap "where am I" signal that costs a few tokens per result. |
| `depth` | Number of meaningful ancestors. `0` = top level. |
| `start_byte`/`end_byte` | Allow an agent (or tool) to slice the exact region from the live file instead of trusting possibly-truncated `content`. |

## Graph tables (new)

Design rationale and query patterns live in [ast-graph.md](ast-graph.md).

### `symbols`

One row per named declaration. The node set of the code graph.

```sql
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
```

| Column | Semantics |
|---|---|
| `chunk_id` | Link to the chunk holding the symbol's body, when one exists — the drill-down path from a graph answer to source text. |
| `signature` | The default representation returned by graph queries; bodies are never returned by graph tools. Derived best-effort from the declaration (params, return type when written). |
| `exported` | 1 when the declaration is exported (ESM `export`, CJS `module.exports` assignment). Enables the dead-exports query. |

### `edges`

Directed relationships between symbols (and files). The edge set of the code graph.

```sql
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
```

Key semantics:

- **`target_name` is always populated** with the identifier as written in source. `target_symbol_id` is filled in by the [resolution pass](indexing.md#edge-resolution) when the target can be located in the index; `NULL` means *unresolved* (external package, dynamic construct, or ambiguous). Consumers must treat unresolved edges as best-effort hints, not absence of a relationship.
- **`source_symbol_id IS NULL`** means the edge originates at file scope (e.g. a top-level `import`).
- `target_module` carries the import specifier verbatim for `imports` edges, enabling module-level dependency maps without resolution.

## Full-text search (new)

An external-content FTS5 table mirrors `code_chunks` for ranked text search — replacing the Swift reference's `LIKE '%q%'` table scan.

```sql
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
```

The indexer only ever inserts and deletes chunk rows (never updates), so insert/delete triggers are sufficient. Queries use `bm25()` for ranking and `snippet()` for excerpts:

```sql
SELECT c.id, f.relative_path, c.start_line, c.end_line, c.node_type, c.node_name,
       c.context_path, snippet(chunks_fts, 0, '«', '»', '…', 12) AS excerpt
FROM chunks_fts
JOIN code_chunks c   ON c.id = chunks_fts.rowid
JOIN indexed_files f ON f.id = c.file_id
WHERE chunks_fts MATCH ?
ORDER BY bm25(chunks_fts)
LIMIT 20;
```

## Meta table

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Rows: `schema_version`, `repo_root` (absolute path at creation time), `tool_version`. Used to detect a database created by an incompatible tool version or copied from another repo — either condition triggers a rebuild.

## Migrations

Numbered forward-only migrations tracked via `PRAGMA user_version`, mirroring the GRDB `DatabaseMigrator` approach of the reference implementation:

1. On open, read `user_version`.
2. Apply each migration with a number greater than it, each in its own transaction, bumping `user_version` as the last statement.
3. A database with a `user_version` *higher* than the tool knows is treated as foreign → quarantine and rebuild.

Because the database is a pure cache, migrations never need to preserve data faithfully — a migration that is awkward to write as SQL may simply be "bump version, clear all tables, mark index stale."

## Health check and recovery

Ported from `CodeIndexDatabase.openRecovering` / `validateHealth` in the Swift reference:

**On every open:**

1. Verify all required tables exist (`indexed_files`, `code_chunks`, `symbols`, `edges`, `chunks_fts`, `meta`) via `sqlite_master`.
2. Run `PRAGMA quick_check`; require the single result `ok`.
3. Verify `meta.schema_version` and `meta.repo_root` match expectations.

**On failure — quarantine and rebuild:**

1. Move `index.db` (and `-wal` / `-shm` sidecars) to `index.db.quarantine-<ISO-timestamp>`.
2. Create a fresh database and run all migrations.
3. Report the recovery (the MCP server surfaces it in `index_status`), and trigger a full re-index.

This is always safe because nothing in the database is precious.

## Write patterns

Used by the indexer; all per-file writes happen in one transaction so readers never see a half-indexed file:

- **`upsertFile`** — insert or update `indexed_files` by `relative_path`, returning `id`.
- **`replaceChunks(fileId, chunks)`** — `DELETE FROM code_chunks WHERE file_id = ?` then bulk insert. (Delete-then-insert, not update — this is what keeps the FTS triggers simple.)
- **Graph rows** for a file are replaced the same way: delete symbols/edges owned by the file (cascades handle chunks→symbols links), insert fresh rows.
- **Edge resolution** runs after the batch of changed files is written; see [indexing.md](indexing.md#edge-resolution).
- **Stale pruning** — files present in `indexed_files` but absent from discovery are deleted; `ON DELETE CASCADE` removes their chunks, symbols, and edges.
