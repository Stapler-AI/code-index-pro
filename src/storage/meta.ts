import type { Database } from "better-sqlite3";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Meta rows & mismatch detection (FR-105, schema.md#meta-table).
 * Detects a database created by an incompatible tool version or copied from
 * another repo — either condition makes the health check (DEV-107) rebuild.
 */

/**
 * Version of the schema contract recorded in meta. Distinct from PRAGMA
 * user_version (the migration counter, DEV-106): a schema_version mismatch
 * means "this database's contract is not ours — rebuild".
 */
export const SCHEMA_VERSION = "1";

export function toolVersion(): string {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/**
 * Canonical repo identity (DEV-805 reconciliation, flagged design decision):
 * repo_root exists to detect a COPIED database, so symlink aliases of the
 * same directory (macOS /var -> /private/var, /tmp -> /private/tmp) must not
 * read as a copy — resolve()-only comparison spuriously quarantined healthy
 * indexes opened via the other alias. Falls back to resolve() when the path
 * does not exist on disk.
 */
export function canonicalRepoRoot(repoRoot: string): string {
  try {
    return realpathSync(resolve(repoRoot));
  } catch {
    return resolve(repoRoot);
  }
}

/** Populate the three meta rows on database creation. */
export function populateMeta(db: Database, repoRoot: string): void {
  const insert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  insert.run("schema_version", SCHEMA_VERSION);
  insert.run("repo_root", canonicalRepoRoot(repoRoot));
  insert.run("tool_version", toolVersion());
}

export interface MetaMismatch {
  key: "schema_version" | "repo_root";
  expected: string;
  actual: string | null;
}

/**
 * Report meta mismatches for the health check to act on. Checks
 * schema_version (incompatible version) and repo_root (copied database);
 * tool_version is recorded for diagnostics only — schema_version carries the
 * compatibility contract.
 */
export function checkMeta(db: Database, repoRoot: string): MetaMismatch[] {
  const read = db.prepare("SELECT value FROM meta WHERE key = ?");
  const actualOf = (key: string): string | null => {
    const row = read.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  };

  const mismatches: MetaMismatch[] = [];
  const expectations: { key: MetaMismatch["key"]; expected: string }[] = [
    { key: "schema_version", expected: SCHEMA_VERSION },
    { key: "repo_root", expected: canonicalRepoRoot(repoRoot) },
  ];
  for (const { key, expected } of expectations) {
    const actual = actualOf(key);
    if (actual !== expected) mismatches.push({ key, expected, actual });
  }
  return mismatches;
}
