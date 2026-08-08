import type { Database } from "better-sqlite3";
import { existsSync, renameSync } from "node:fs";
import { indexDbPath, openDatabase } from "./database";
import { checkMeta, populateMeta } from "./meta";
import { isForeignDatabase, runMigrations, userVersion } from "./migrations";

/**
 * Health check & quarantine-and-rebuild (FR-107,
 * schema.md#health-check-and-recovery). The database is a pure cache, so
 * recovery is always quarantine + fresh rebuild — never repair.
 */

export const REQUIRED_TABLES = [
  "indexed_files",
  "code_chunks",
  "symbols",
  "edges",
  "chunks_fts",
  "meta",
] as const;

export interface RecoveryEvent {
  timestamp: string; // ISO-8601
  reason: string;
  quarantinePath: string;
}

export interface OpenResult {
  db: Database;
  /** True when the previous database was quarantined and rebuilt. */
  recovered: boolean;
  recoveryEvent?: RecoveryEvent;
  /** True when the rebuilt database needs a full re-index. */
  fullReindexRequired: boolean;
}

/**
 * Run the on-open health check. Returns a list of failure descriptions;
 * empty means healthy.
 */
export function checkHealth(db: Database, repoRoot: string): string[] {
  const failures: string[] = [];

  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  const present = new Set(rows.map((r) => r.name));
  for (const table of REQUIRED_TABLES) {
    if (!present.has(table)) failures.push(`missing required table: ${table}`);
  }

  const quickCheck = db.pragma("quick_check", { simple: true }) as string;
  if (quickCheck !== "ok") failures.push(`quick_check failed: ${quickCheck}`);

  if (present.has("meta")) {
    for (const mismatch of checkMeta(db, repoRoot)) {
      failures.push(
        `meta mismatch: ${mismatch.key} is ${mismatch.actual ?? "missing"}, expected ${mismatch.expected}`,
      );
    }
  }

  if (isForeignDatabase(db)) {
    failures.push(`foreign database: user_version ${userVersion(db)} is newer than this tool`);
  }

  return failures;
}

/** Move index.db and its -wal/-shm sidecars aside; returns the quarantine path. */
function quarantineDatabase(repoRoot: string): string {
  const dbPath = indexDbPath(repoRoot);
  const quarantinePath = `${dbPath}.quarantine-${new Date().toISOString()}`;
  renameSync(dbPath, quarantinePath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, quarantinePath + suffix);
  }
  return quarantinePath;
}

const RECOVERY_EVENTS_KEY = "recovery_events";
const REINDEX_REQUIRED_KEY = "reindex_required";

/** Recovery events recorded across rebuilds — surfaced by index_status (FR-604). */
export function getRecoveryEvents(db: Database): RecoveryEvent[] {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(RECOVERY_EVENTS_KEY) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as RecoveryEvent[]) : [];
}

export function isReindexRequired(db: Database): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(REINDEX_REQUIRED_KEY) as
    | { value: string }
    | undefined;
  return row?.value === "1";
}

/** Cleared by the pipeline once the full re-index has run. */
export function clearReindexRequired(db: Database): void {
  db.prepare("DELETE FROM meta WHERE key = ?").run(REINDEX_REQUIRED_KEY);
}

function createFresh(repoRoot: string): Database {
  const db = openDatabase(repoRoot);
  runMigrations(db);
  populateMeta(db, repoRoot);
  return db;
}

/**
 * Open the repo's index database with the on-open health check. A missing
 * database is created fresh; an unhealthy one (corrupt, foreign, copied) is
 * quarantined and rebuilt, the event recorded in the new database's meta.
 */
export function openHealthy(repoRoot: string): OpenResult {
  const dbPath = indexDbPath(repoRoot);

  if (!existsSync(dbPath)) {
    return { db: createFresh(repoRoot), recovered: false, fullReindexRequired: false };
  }

  let db: Database | null = null;
  let failure: string | null = null;
  try {
    db = openDatabase(repoRoot);
    const failures = checkHealth(db, repoRoot);
    if (failures.length > 0) failure = failures.join("; ");
  } catch (err) {
    failure = `open failed: ${(err as Error).message}`;
  }

  if (failure === null && db !== null) {
    runMigrations(db); // apply any pending forward migrations
    return { db, recovered: false, fullReindexRequired: false };
  }

  db?.close();
  const quarantinePath = quarantineDatabase(repoRoot);
  const event: RecoveryEvent = {
    timestamp: new Date().toISOString(),
    reason: failure ?? "unknown",
    quarantinePath,
  };

  const fresh = createFresh(repoRoot);
  const events = getRecoveryEvents(fresh);
  events.push(event);
  const upsert = fresh.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  upsert.run(RECOVERY_EVENTS_KEY, JSON.stringify(events));
  upsert.run(REINDEX_REQUIRED_KEY, "1");

  return { db: fresh, recovered: true, recoveryEvent: event, fullReindexRequired: true };
}
