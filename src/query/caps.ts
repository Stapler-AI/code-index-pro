/**
 * Caps & truncation (FR-404). Every list-returning query takes a limit
 * (defaults 20 for FTS, 50 for graph queries per ast-graph.md's result
 * shaping) and reports truncation explicitly so agents know when a list
 * was cut.
 */

export interface CappedResults<T> {
  results: T[];
  truncated: boolean;
}

/**
 * Cap a row list fetched with limit+1: the sentinel extra row, when present,
 * proves there was more than the cap.
 */
export function capResults<T>(rows: T[], limit: number): CappedResults<T> {
  if (rows.length > limit) {
    return { results: rows.slice(0, limit), truncated: true };
  }
  return { results: rows, truncated: false };
}
