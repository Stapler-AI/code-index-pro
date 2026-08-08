import type { Database } from "better-sqlite3";
import { pruneStale } from "../storage/writes";

/**
 * Stale pruning stage (FR-205, indexing.md#change-detection). Runs at the end
 * of every pipeline run (wired by FR-206).
 *
 * The seen-set is the FULL discovery output — not just the files indexed this
 * run. A discovered file that was skipped (unchanged, too large, binary,
 * unrecognized extension) is still "seen" and keeps any existing rows; only
 * files absent from discovery (deleted, newly gitignored) are pruned, with
 * cascades removing their chunks, symbols, and edges.
 */
export function pruneUnseenFiles(db: Database, discoveredPaths: Iterable<string>): string[] {
  return pruneStale(db, discoveredPaths);
}
