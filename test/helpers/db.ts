import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** DB helpers (QA-000): open a fixture's index database and inspect rows. */

export const INDEX_DB_REL_PATH = join(".code-index", "index.db");

export function indexDbPath(repoRoot: string): string {
  return join(repoRoot, INDEX_DB_REL_PATH);
}

export function indexDbExists(repoRoot: string): boolean {
  return existsSync(indexDbPath(repoRoot));
}

/** Open an existing fixture index database (fails if it does not exist). */
export function openIndexDb(repoRoot: string): Database.Database {
  return new Database(indexDbPath(repoRoot), { fileMustExist: true });
}

export function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
  return row.n;
}

/** Total rows inserted/updated/deleted on this connection — for zero-write assertions. */
export function totalChanges(db: Database.Database): number {
  const row = db.prepare("SELECT total_changes() AS n").get() as { n: number };
  return row.n;
}
