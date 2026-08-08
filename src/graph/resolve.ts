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

  // The file's import map: name N -> specifier S (first import wins).
  const importsByName = new Map<string, string>();
  for (const edge of edges) {
    if (edge.edge_type === "imports" && edge.target_module !== null && !importsByName.has(edge.target_name)) {
      importsByName.set(edge.target_name, edge.target_module);
    }
  }

  const update = db.prepare("UPDATE edges SET target_symbol_id = ? WHERE id = ?");
  let resolved = 0;

  for (const edge of edges) {
    const name = edge.target_name;
    let target: number | null = null;

    const specifier = edge.target_module ?? importsByName.get(name) ?? null;
    if (specifier !== null) {
      // Step 1 — and terminal when the specifier is external or unresolvable.
      const targetFileId = resolveModuleFile(index, file.relativePath, specifier);
      if (targetFileId !== null) target = uniqueInFile(index, targetFileId, name, true);
    } else {
      // Step 2: same-file declaration.
      target = uniqueInFile(index, file.fileId, name, false);
      // Step 3: unique exported name repo-wide.
      if (target === null) {
        const exported = index.exportedByName.get(name);
        if (exported?.length === 1) target = exported[0];
      }
    }

    if (target !== null) {
      update.run(target, edge.id);
      resolved += 1;
    }
  }
  return resolved;
}

/** The pipeline resolution hook (PipelineHooks.resolve). */
export function resolveEdges(db: Database, changedFiles: FileRef[]): void {
  if (changedFiles.length === 0) return;
  const index = buildResolutionIndex(db);
  db.transaction(() => {
    for (const file of changedFiles) {
      resolveFileEdges(db, index, file);
    }
  })();
}
