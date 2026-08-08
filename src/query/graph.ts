import type { Database } from "better-sqlite3";
import { capResults, CappedResults } from "./caps";

/**
 * The seven graph queries (FR-402, ast-graph.md#query-use-cases), each
 * implemented from its SQL sketch. Results are token-cheap tuples — ids,
 * names, kinds, signatures, paths, lines — never chunk bodies (a body is one
 * get_chunk call away). Unresolved edges are included as flagged hints, never
 * dropped (src/graph/resolve.ts documents the accepted limitations).
 *
 * Every list-returning query takes options.limit (default 50, FR-404) and
 * reports truncation; queries fetch limit+1 rows as the truncation sentinel.
 */

export const GRAPH_DEFAULT_LIMIT = 50;

export interface LimitOption {
  limit?: number;
}

export interface SymbolTuple {
  id: number;
  name: string;
  kind: string;
  signature: string | null;
  path: string;
  line: number;
}

/** Who calls X (direct): callers via calls/references edges. */
export interface CallerRow extends SymbolTuple {
  /** false when the edge matched by target_name only (unresolved hint). */
  resolved: boolean;
}

export function whoCalls(
  db: Database,
  symbolId: number,
  symbolName: string,
  options: LimitOption = {},
): CappedResults<CallerRow> {
  const limit = options.limit ?? GRAPH_DEFAULT_LIMIT;
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.signature, f.relative_path AS path, e.line,
              (e.target_symbol_id IS NOT NULL) AS resolvedInt
       FROM edges e
       JOIN symbols s       ON s.id = e.source_symbol_id
       JOIN indexed_files f ON f.id = e.source_file_id
       WHERE e.edge_type IN ('calls', 'references')
         AND (e.target_symbol_id = ?
              OR (e.target_symbol_id IS NULL AND e.target_name = ?))
       ORDER BY e.line, s.id
       LIMIT ?`,
    )
    .all(symbolId, symbolName, limit + 1) as (SymbolTuple & { resolvedInt: number })[];
  return capResults(
    rows.map(({ resolvedInt, ...row }) => ({ ...row, resolved: resolvedInt === 1 })),
    limit,
  );
}

/** What does X call / use (outbound). */
export interface DependencyRow {
  edgeType: string;
  targetName: string;
  targetModule: string | null;
  line: number;
  /** Resolved target symbol, when resolution succeeded. */
  target: { id: number; kind: string; signature: string | null; path: string } | null;
}

export function getDependencies(
  db: Database,
  symbolId: number,
  options: LimitOption = {},
): CappedResults<DependencyRow> {
  const limit = options.limit ?? GRAPH_DEFAULT_LIMIT;
  const rows = db
    .prepare(
      `SELECT e.edge_type AS edgeType, e.target_name AS targetName,
              e.target_module AS targetModule, e.line,
              t.id AS targetId, t.kind AS targetKind, t.signature AS targetSignature,
              tf.relative_path AS targetPath
       FROM edges e
       LEFT JOIN symbols t        ON t.id = e.target_symbol_id
       LEFT JOIN indexed_files tf ON tf.id = t.file_id
       WHERE e.source_symbol_id = ?
       ORDER BY e.line, e.id
       LIMIT ?`,
    )
    .all(symbolId, limit + 1) as {
    edgeType: string;
    targetName: string;
    targetModule: string | null;
    line: number;
    targetId: number | null;
    targetKind: string | null;
    targetSignature: string | null;
    targetPath: string | null;
  }[];
  return capResults(
    rows.map((r) => ({
      edgeType: r.edgeType,
      targetName: r.targetName,
      targetModule: r.targetModule,
      line: r.line,
      target:
        r.targetId === null
          ? null
          : { id: r.targetId, kind: r.targetKind!, signature: r.targetSignature, path: r.targetPath! },
    })),
    limit,
  );
}

/** Impact of changing X: transitive inbound closure, cycle-safe, depth-capped. */
export interface ImpactRow extends SymbolTuple {
  distance: number;
}

export const IMPACT_DEFAULT_MAX_DEPTH = 3;

export interface ImpactOptions extends LimitOption {
  maxDepth?: number;
}

export function impactOfChange(
  db: Database,
  symbolId: number,
  options: ImpactOptions = {},
): CappedResults<ImpactRow> {
  const limit = options.limit ?? GRAPH_DEFAULT_LIMIT;
  const maxDepth = options.maxDepth ?? IMPACT_DEFAULT_MAX_DEPTH;
  const rows = db
    .prepare(
      `WITH RECURSIVE impact(id, depth) AS (
         SELECT ?, 0
         UNION
         SELECT e.source_symbol_id, impact.depth + 1
         FROM edges e
         JOIN impact ON e.target_symbol_id = impact.id
         WHERE e.source_symbol_id IS NOT NULL
           AND e.edge_type IN ('calls', 'references', 'extends', 'implements')
           AND impact.depth < ?
       )
       SELECT s.id, s.name, s.kind, s.signature, f.relative_path AS path,
              s.start_line AS line, MIN(impact.depth) AS distance
       FROM impact
       JOIN symbols s       ON s.id = impact.id
       JOIN indexed_files f ON f.id = s.file_id
       WHERE impact.id != ?
       GROUP BY s.id
       ORDER BY distance, f.relative_path
       LIMIT ?`,
    )
    .all(symbolId, maxDepth, symbolId, limit + 1) as ImpactRow[];
  return capResults(rows, limit);
}

/** File / module dependency map, aggregated from imports edges. */
export interface ModuleMapRow {
  fromFile: string;
  toModule: string;
  importCount: number;
}

export function moduleMap(db: Database, options: LimitOption = {}): CappedResults<ModuleMapRow> {
  const limit = options.limit ?? GRAPH_DEFAULT_LIMIT;
  const rows = db
    .prepare(
      `SELECT f.relative_path AS fromFile,
              COALESCE(tf.relative_path, e.target_module) AS toModule,
              COUNT(*) AS importCount
       FROM edges e
       JOIN indexed_files f        ON f.id = e.source_file_id
       LEFT JOIN symbols t         ON t.id = e.target_symbol_id
       LEFT JOIN indexed_files tf  ON tf.id = t.file_id
       WHERE e.edge_type = 'imports'
       GROUP BY fromFile, toModule
       ORDER BY fromFile, toModule
       LIMIT ?`,
    )
    .all(limit + 1) as ModuleMapRow[];
  return capResults(rows, limit);
}

/**
 * Class hierarchy of T: ancestors (extends/implements up) or descendants.
 * Deviation from the sketch: the root class itself is excluded from results
 * (ancestry.id != ?), consistent with the impact query's root exclusion.
 */
export const HIERARCHY_MAX_DEPTH = 10;

export function classHierarchy(
  db: Database,
  classId: number,
  direction: "ancestors" | "descendants",
  options: LimitOption = {},
): CappedResults<SymbolTuple> {
  const limit = options.limit ?? GRAPH_DEFAULT_LIMIT;
  const walk =
    direction === "ancestors"
      ? `SELECT e.target_symbol_id, ancestry.depth + 1
         FROM edges e JOIN ancestry ON e.source_symbol_id = ancestry.id`
      : `SELECT e.source_symbol_id, ancestry.depth + 1
         FROM edges e JOIN ancestry ON e.target_symbol_id = ancestry.id`;
  const nonNull = direction === "ancestors" ? "e.target_symbol_id" : "e.source_symbol_id";
  const rows = db
    .prepare(
      `WITH RECURSIVE ancestry(id, depth) AS (
         SELECT ?, 0
         UNION
         ${walk}
         WHERE e.edge_type IN ('extends', 'implements')
           AND ${nonNull} IS NOT NULL AND ancestry.depth < ${HIERARCHY_MAX_DEPTH}
       )
       SELECT s.id, s.name, s.kind, s.signature, f.relative_path AS path, s.start_line AS line
       FROM ancestry JOIN symbols s ON s.id = ancestry.id
       JOIN indexed_files f ON f.id = s.file_id
       WHERE ancestry.id != ?
       ORDER BY s.id
       LIMIT ?`,
    )
    .all(classId, classId, limit + 1) as SymbolTuple[];
  return capResults(rows, limit);
}

/**
 * Dead exports: exported symbols with no inbound edge, resolved or possible.
 * Deviation from the ast-graph.md sketch: edge_type 'exports' is excluded
 * from "inbound" — in this edge model every exported symbol carries a
 * self-referential exports edge (file → own symbol), which would otherwise
 * shield everything and make the query always empty. Exports edges declare,
 * they don't use.
 */
export function deadExports(db: Database, options: LimitOption = {}): CappedResults<SymbolTuple> {
  const limit = options.limit ?? GRAPH_DEFAULT_LIMIT;
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.signature, f.relative_path AS path, s.start_line AS line
       FROM symbols s
       JOIN indexed_files f ON f.id = s.file_id
       WHERE s.exported = 1
         AND NOT EXISTS (SELECT 1 FROM edges e
                         WHERE e.target_symbol_id = s.id AND e.edge_type != 'exports')
         AND NOT EXISTS (SELECT 1 FROM edges e
                         WHERE e.target_symbol_id IS NULL AND e.target_name = s.name
                           AND e.edge_type != 'exports')
       ORDER BY f.relative_path, s.start_line
       LIMIT ?`,
    )
    .all(limit + 1) as SymbolTuple[];
  return capResults(rows, limit);
}

/** File outline: the skeleton of one file from its symbols. */
export interface OutlineRow {
  id: number;
  name: string;
  kind: string;
  signature: string | null;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export function fileOutline(
  db: Database,
  relativePath: string,
  options: LimitOption = {},
): CappedResults<OutlineRow> {
  const limit = options.limit ?? GRAPH_DEFAULT_LIMIT;
  const rows = db
    .prepare(
      `SELECT id, name, kind, signature, start_line AS startLine, end_line AS endLine, exported
       FROM symbols
       WHERE file_id = (SELECT id FROM indexed_files WHERE relative_path = ?)
       ORDER BY start_line
       LIMIT ?`,
    )
    .all(relativePath, limit + 1) as (Omit<OutlineRow, "exported"> & { exported: number })[];
  return capResults(
    rows.map((r) => ({ ...r, exported: r.exported === 1 })),
    limit,
  );
}

/** Name lookup backing find_symbol ("Where is X defined?" decision-matrix row). */
export function findSymbol(db: Database, name: string, options: LimitOption = {}): CappedResults<SymbolTuple> {
  const limit = options.limit ?? GRAPH_DEFAULT_LIMIT;
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.signature, f.relative_path AS path, s.start_line AS line
       FROM symbols s JOIN indexed_files f ON f.id = s.file_id
       WHERE s.name = ?
       ORDER BY f.relative_path, s.start_line
       LIMIT ?`,
    )
    .all(name, limit + 1) as SymbolTuple[];
  return capResults(rows, limit);
}
