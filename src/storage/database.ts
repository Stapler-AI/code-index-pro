import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Database location & lifecycle (FR-101, schema.md#overview).
 * One SQLite database per indexed repo at .code-index/index.db.
 */

/**
 * Directory holding the index database. Always excluded from indexing
 * (enforced by file discovery) and expected to be gitignored.
 */
export const CODE_INDEX_DIR = ".code-index";

export const INDEX_DB_FILENAME = "index.db";

export function indexDbPath(repoRoot: string): string {
  return join(repoRoot, CODE_INDEX_DIR, INDEX_DB_FILENAME);
}

/**
 * Open (creating if needed) the repo's index database, with the .code-index/
 * directory created as needed and the spec'd pragmas applied on every open.
 */
export function openDatabase(repoRoot: string): Database.Database {
  mkdirSync(join(repoRoot, CODE_INDEX_DIR), { recursive: true });
  const db = new Database(indexDbPath(repoRoot));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  return db;
}
