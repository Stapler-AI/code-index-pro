import type { Database } from "better-sqlite3";
import { CORE_TABLES_DDL, FTS_DDL, GRAPH_TABLES_DDL, META_DDL } from "./schema";

/**
 * Numbered forward-only migrations tracked via PRAGMA user_version
 * (FR-106, schema.md#migrations). Because the database is a pure cache,
 * migrations never need to preserve data — an awkward migration may simply
 * clear tables and mark the index stale.
 */

export interface Migration {
  version: number;
  up(db: Database): void;
}

/** Migration 1 consolidates all DDL from DEV-102..105. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(CORE_TABLES_DDL);
      db.exec(GRAPH_TABLES_DDL);
      db.exec(FTS_DDL);
      db.exec(META_DDL);
    },
  },
];

/** Highest migration number this build of the tool knows. */
export const CURRENT_USER_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function userVersion(db: Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * A database whose user_version is higher than this tool knows was written by
 * a newer tool — it is foreign, never migrated (quarantine is DEV-107's job).
 */
export function isForeignDatabase(db: Database): boolean {
  return userVersion(db) > CURRENT_USER_VERSION;
}

export class ForeignDatabaseError extends Error {
  constructor(public readonly foundVersion: number) {
    super(
      `database user_version ${foundVersion} is newer than this tool's ` +
        `${CURRENT_USER_VERSION} — foreign database`,
    );
    this.name = "ForeignDatabaseError";
  }
}

/**
 * Apply every migration numbered above the database's user_version, each in
 * its own transaction that bumps user_version last. No-op when up to date.
 * Throws ForeignDatabaseError instead of touching a foreign database.
 */
export function runMigrations(db: Database): void {
  if (isForeignDatabase(db)) {
    throw new ForeignDatabaseError(userVersion(db));
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= userVersion(db)) continue;
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
