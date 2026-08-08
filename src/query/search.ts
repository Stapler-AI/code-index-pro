import type { Database } from "better-sqlite3";
import { capResults, CappedResults } from "./caps";

/**
 * Text search (FR-401, search.md#text-search-fts5): FTS5 MATCH over chunk
 * content + node_name, ranked by bm25(), with snippet() excerpts.
 *
 * The query string passes through to FTS5, exposing the documented syntax
 * subset: terms (`parse chunk`), phrases (`"replace chunks"`), prefix
 * (`pars*`), proximity (`NEAR(hash detect, 10)`), and column filters
 * (`content: cache`, `node_name: parse`).
 *
 * Known blind spot (documented in search.md): chunk content is capped at
 * 2000 chars, so text beyond the cap in a very large function is
 * unsearchable here.
 */

export interface SearchCodeOptions {
  /** Maximum hits returned. */
  limit?: number;
  /** Restrict hits to files whose relative_path starts with this prefix. */
  pathPrefix?: string;
}

export const SEARCH_CODE_DEFAULT_LIMIT = 20;

/** One hit, ~20 tokens (search.md result shape). */
export interface SearchHit {
  chunkId: number;
  path: string;
  startLine: number;
  endLine: number;
  nodeType: string;
  nodeName: string | null;
  contextPath: string;
  excerpt: string;
}

/** Snippet marker/config: excerpt shows the match inside [ ] with … ellipses. */
const SNIPPET_ARGS = { column: 0, open: "[", close: "]", ellipsis: "…", tokens: 12 };

/**
 * Run an FTS5 query. A syntactically invalid FTS query throws better-sqlite3's
 * SqliteError (fts5: syntax error…) — callers surface that as a bad request.
 * Fetches limit+1 rows so the response can report truncation (FR-404).
 */
export function searchCode(
  db: Database,
  query: string,
  options: SearchCodeOptions = {},
): CappedResults<SearchHit> {
  const limit = options.limit ?? SEARCH_CODE_DEFAULT_LIMIT;
  const pathPrefix = options.pathPrefix ?? null;

  const rows = db
    .prepare(
      `SELECT c.id AS chunkId,
              f.relative_path AS path,
              c.start_line AS startLine,
              c.end_line AS endLine,
              c.node_type AS nodeType,
              c.node_name AS nodeName,
              c.context_path AS contextPath,
              snippet(chunks_fts, ?, ?, ?, ?, ?) AS excerpt
       FROM chunks_fts
       JOIN code_chunks c ON c.id = chunks_fts.rowid
       JOIN indexed_files f ON f.id = c.file_id
       WHERE chunks_fts MATCH ?
         AND (? IS NULL OR substr(f.relative_path, 1, length(?)) = ?)
       ORDER BY bm25(chunks_fts), c.id
       LIMIT ?`,
    )
    .all(
      SNIPPET_ARGS.column,
      SNIPPET_ARGS.open,
      SNIPPET_ARGS.close,
      SNIPPET_ARGS.ellipsis,
      SNIPPET_ARGS.tokens,
      query,
      pathPrefix,
      pathPrefix,
      pathPrefix,
      limit + 1,
    ) as SearchHit[];
  return capResults(rows, limit);
}
