import type { Database } from "better-sqlite3";
import { posix } from "node:path";

/**
 * Edge resolution pass (FR-304, indexing.md#edge-resolution). Runs in the
 * pipeline's resolution hook after all changed files persist and stale files
 * are pruned. For every unresolved edge from a changed file, the ladder is:
 *
 *   1. Import-based (preferred): if the edge itself carries a module
 *      specifier (imports / one-level re-exports) or the source file imports
 *      the target name, resolve the specifier via simplified Node resolution
 *      and link the unique exported symbol of that name in the target file.
 *      A specifier we can't resolve to a repo file (external package like
 *      'react', or a missing path) is terminal: we know where the name comes
 *      from, so the later steps must not guess — the edge stays NULL with
 *      target_module populated.
 *   2. Same-file declaration: the unique symbol of that name in the source
 *      file (ambiguity falls through).
 *   3. Unique-name fallback: exactly one exported symbol of that name
 *      repo-wide.
 *   4. Otherwise leave target_symbol_id NULL.
 *
 * package.json exports maps and tsconfig path aliases are out of scope (v1).
 * Default exports carry no marker in the schema, so a default import links
 * only when the local and exported names coincide (name-only philosophy,
 * indexing.md#known-limitations); otherwise the edge stays NULL.
 */

/** Simplified Node resolution: relative path + extension guessing. */
const EXTENSION_CANDIDATES = ["", ".js", ".ts", ".tsx"];
const INDEX_CANDIDATES = ["/index.js", "/index.ts", "/index.tsx"];

interface EdgeRow {
  id: number;
  edge_type: string;
  target_name: string;
  target_module: string | null;
}

interface FileRef {
  fileId: number;
  relativePath: string;
}

/** Repo-wide lookup tables, built once per resolution pass. */
export interface ResolutionIndex {
  fileIdByPath: Map<string, number>;
  /** `${fileId}\n${name}` -> symbol ids in that file. */
  symbolsByFileAndName: Map<string, number[]>;
  /** name -> exported symbol ids repo-wide. */
  exportedByName: Map<string, number[]>;
}

export function buildResolutionIndex(db: Database): ResolutionIndex {
  const fileIdByPath = new Map<string, number>();
  for (const row of db.prepare("SELECT id, relative_path FROM indexed_files").all() as {
    id: number;
    relative_path: string;
  }[]) {
    fileIdByPath.set(row.relative_path, row.id);
  }

  const symbolsByFileAndName = new Map<string, number[]>();
  const exportedByName = new Map<string, number[]>();
  for (const row of db.prepare("SELECT id, file_id, name, exported FROM symbols").all() as {
    id: number;
    file_id: number;
    name: string;
    exported: number;
  }[]) {
    const fileKey = `${row.file_id}\n${row.name}`;
    (symbolsByFileAndName.get(fileKey) ?? symbolsByFileAndName.set(fileKey, []).get(fileKey)!).push(row.id);
    if (row.exported) {
      (exportedByName.get(row.name) ?? exportedByName.set(row.name, []).get(row.name)!).push(row.id);
    }
  }
  return { fileIdByPath, symbolsByFileAndName, exportedByName };
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** './db' from 'src/a.ts' -> file id of src/db.ts (etc.), or null. */
function resolveModuleFile(index: ResolutionIndex, fromPath: string, specifier: string): number | null {
  if (!isRelative(specifier)) return null; // external package — repo-local by design
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  for (const suffix of [...EXTENSION_CANDIDATES.map((e) => base + e), ...INDEX_CANDIDATES.map((i) => base + i)]) {
    const fileId = index.fileIdByPath.get(suffix);
    if (fileId !== undefined) return fileId;
  }
  return null;
}

/** The unique symbol named `name` in a file; ambiguity -> null. */
function uniqueInFile(index: ResolutionIndex, fileId: number, name: string, exportedOnly: boolean): number | null {
  let candidates = index.symbolsByFileAndName.get(`${fileId}\n${name}`) ?? [];
  if (exportedOnly) {
    candidates = candidates.filter((id) => index.exportedByName.get(name)?.includes(id));
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** One edge through the ladder; returns the target symbol id or null. */
function runLadder(
  index: ResolutionIndex,
  file: FileRef,
  edge: EdgeRow,
  importsByName: Map<string, string>,
): number | null {
  const name = edge.target_name;
  const specifier = edge.target_module ?? importsByName.get(name) ?? null;
  if (specifier !== null) {
    // Step 1 — and terminal when the specifier is external or unresolvable.
    const targetFileId = resolveModuleFile(index, file.relativePath, specifier);
    return targetFileId === null ? null : uniqueInFile(index, targetFileId, name, true);
  }
  // Step 2: same-file declaration.
  const sameFile = uniqueInFile(index, file.fileId, name, false);
  if (sameFile !== null) return sameFile;
  // Step 3: unique exported name repo-wide.
  const exported = index.exportedByName.get(name);
  return exported?.length === 1 ? exported[0] : null;
}

/** The file's import map: name N -> specifier S (first import wins). */
function importMapOf(db: Database, fileId: number): Map<string, string> {
  const importsByName = new Map<string, string>();
  for (const row of db
    .prepare(
      "SELECT target_name, target_module FROM edges WHERE source_file_id = ? AND edge_type = 'imports' AND target_module IS NOT NULL ORDER BY id",
    )
    .all(fileId) as { target_name: string; target_module: string }[]) {
    if (!importsByName.has(row.target_name)) importsByName.set(row.target_name, row.target_module);
  }
  return importsByName;
}

/**
 * Resolve all unresolved edges originating from `file`, using the ladder
 * above. Returns the number of edges resolved.
 */
export function resolveFileEdges(db: Database, index: ResolutionIndex, file: FileRef): number {
  const edges = db
    .prepare(
      "SELECT id, edge_type, target_name, target_module FROM edges WHERE source_file_id = ? AND target_symbol_id IS NULL",
    )
    .all(file.fileId) as EdgeRow[];
  if (edges.length === 0) return 0;

  const importsByName = importMapOf(db, file.fileId);
  const update = db.prepare("UPDATE edges SET target_symbol_id = ? WHERE id = ?");
  let resolved = 0;

  for (const edge of edges) {
    const target = runLadder(index, file, edge, importsByName);
    if (target !== null) {
      update.run(target, edge.id);
      resolved += 1;
    }
  }
  return resolved;
}

interface TargetedEdgeRow extends EdgeRow {
  target_symbol_id: number | null;
  source_file_id: number;
  relative_path: string;
}

/**
 * Incremental re-resolution (FR-305): re-run the ladder for edges OUTSIDE the
 * changed set whose target_name is in `names` (looked up one name at a time
 * via idx_edges_target_name). Both directions apply — a nulled edge may now
 * resolve, and a previously-resolved edge may drop to NULL when a new
 * duplicate breaks uniqueness. No other edges are touched.
 */
function reresolveByNames(
  db: Database,
  index: ResolutionIndex,
  names: Set<string>,
  excludeFileIds: Set<number>,
): void {
  if (names.size === 0) return;
  const selectByName = db.prepare(
    `SELECT e.id, e.edge_type, e.target_name, e.target_module, e.target_symbol_id,
            e.source_file_id, f.relative_path
     FROM edges e JOIN indexed_files f ON f.id = e.source_file_id
     WHERE e.target_name = ?`,
  );
  const update = db.prepare("UPDATE edges SET target_symbol_id = ? WHERE id = ?");
  const importMaps = new Map<number, Map<string, string>>();

  for (const name of names) {
    for (const edge of selectByName.all(name) as TargetedEdgeRow[]) {
      if (excludeFileIds.has(edge.source_file_id)) continue;
      let importsByName = importMaps.get(edge.source_file_id);
      if (!importsByName) {
        importsByName = importMapOf(db, edge.source_file_id);
        importMaps.set(edge.source_file_id, importsByName);
      }
      const file: FileRef = { fileId: edge.source_file_id, relativePath: edge.relative_path };
      const target = runLadder(index, file, edge, importsByName);
      if (target !== edge.target_symbol_id) update.run(target, edge.id);
    }
  }
}

/**
 * The pipeline resolution hook (PipelineHooks.resolve). Phase 1 resolves the
 * changed files' own (freshly NULL) edges; phase 2 re-resolves edges
 * elsewhere targeting any name a changed file had before or has now (the
 * UNION — delete-then-insert nulls inbound edges even for unchanged names) or
 * a pruned file lost. Feeding pruned names in is a deliberate extension the
 * spec is silent on: without it, inbound edges of deleted symbols would stay
 * stale-NULL and deletion-broken ambiguities would never re-link.
 */
export function resolveEdges(
  db: Database,
  changedFiles: (FileRef & { previousSymbolNames?: string[] })[],
  prunedSymbolNames: string[] = [],
): void {
  if (changedFiles.length === 0 && prunedSymbolNames.length === 0) return;
  const index = buildResolutionIndex(db);
  const currentNames = db.prepare("SELECT DISTINCT name FROM symbols WHERE file_id = ?");

  db.transaction(() => {
    const affectedNames = new Set<string>(prunedSymbolNames);
    const changedIds = new Set<number>();
    for (const file of changedFiles) {
      resolveFileEdges(db, index, file);
      changedIds.add(file.fileId);
      for (const name of file.previousSymbolNames ?? []) affectedNames.add(name);
      for (const row of currentNames.all(file.fileId) as { name: string }[]) affectedNames.add(row.name);
    }
    reresolveByNames(db, index, affectedNames, changedIds);
  })();
}
