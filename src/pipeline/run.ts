import type { Database } from "better-sqlite3";
import type Parser from "tree-sitter";
import type { ChunkInput, EdgeInput, SymbolInput } from "../storage/writes";
import { writeFile } from "../storage/writes";
import { evaluateFile } from "./changes";
import { extractChunks, parseSource } from "./chunks";
import { discoverFiles } from "./discovery";
import { detectLanguage, Language } from "./language";
import { pruneUnseenFiles } from "./prune";

/**
 * Pipeline orchestration (FR-206, indexing.md#pipeline-overview):
 * discover -> filter -> hash/diff -> parse -> chunk -> (extraction hook) ->
 * persist -> prune -> (resolution hook). The resolution hook runs once per
 * run after all changed files are written AND stale files are pruned, so it
 * sees the run's final symbol universe. Parse->persist is one transaction per
 * file (writeFile). The two hooks are filled by M3; defaults are no-ops.
 */

export interface ExtractionInput {
  relativePath: string;
  language: Language;
  content: string;
  /** The parse tree already built for chunking — extraction must not re-parse. */
  tree: Parser.Tree;
  chunks: ChunkInput[];
}

export interface Extraction {
  symbols: SymbolInput[];
  edges: EdgeInput[];
}

export interface ChangedFileRecord {
  fileId: number;
  relativePath: string;
  language: Language;
  /**
   * Distinct symbol names the file's previous index rows had (empty for new
   * files). Captured before the delete-then-insert rewrite because inbound
   * edges are SET NULL even when a symbol keeps its name — incremental
   * re-resolution (FR-305) needs the union of before/after names.
   */
  previousSymbolNames: string[];
}

export interface PipelineHooks {
  /** Symbol & edge extraction (M3). Default: no symbols, no edges. */
  extract?: (input: ExtractionInput) => Extraction;
  /**
   * Edge resolution (M3), run once per run after persist and prune complete.
   * prunedSymbolNames are the distinct symbol names of files removed by the
   * prune — their inbound edges were nulled (or their departure may break a
   * unique-name ambiguity), so they join the re-resolution set.
   */
  resolve?: (db: Database, changedFiles: ChangedFileRecord[], prunedSymbolNames: string[]) => void;
}

export interface RunDelta {
  filesAdded: number;
  filesUpdated: number;
  filesRemoved: number;
  durationMs: number;
}

/** One incremental indexing run over repoRoot. */
export function runPipeline(db: Database, repoRoot: string, hooks: PipelineHooks = {}): RunDelta {
  const startedAt = Date.now();
  const extract = hooks.extract ?? (() => ({ symbols: [], edges: [] }));

  const discovered = discoverFiles(repoRoot);
  const changedFiles: ChangedFileRecord[] = [];
  let filesAdded = 0;
  let filesUpdated = 0;

  const hasRow = db.prepare("SELECT id FROM indexed_files WHERE relative_path = ?");
  const symbolNames = db.prepare("SELECT DISTINCT name FROM symbols WHERE file_id = ?");
  const namesOf = (fileId: number): string[] =>
    (symbolNames.all(fileId) as { name: string }[]).map((r) => r.name);

  for (const relativePath of discovered) {
    const language = detectLanguage(relativePath);
    if (language === null) continue;

    const decision = evaluateFile(db, repoRoot, relativePath);
    if (decision.action === "skip") continue;

    const tree = parseSource(language, decision.content);
    const chunks = extractChunks(tree, decision.content, language);
    const { symbols, edges } = extract({ relativePath, language, content: decision.content, tree, chunks });

    const existing = hasRow.get(relativePath) as { id: number } | undefined;
    const isNew = existing === undefined;
    const previousSymbolNames = existing ? namesOf(existing.id) : [];
    const fileId = writeFile(db, {
      file: {
        relativePath,
        language,
        fileHash: decision.fileHash,
        lastIndexed: new Date().toISOString(),
      },
      chunks,
      symbols,
      edges,
    });

    changedFiles.push({ fileId, relativePath, language, previousSymbolNames });
    if (isNew) filesAdded += 1;
    else filesUpdated += 1;
  }

  // Capture doomed files' symbol names before the prune deletes their rows.
  const seen = new Set(discovered);
  const doomed = (
    db.prepare("SELECT id, relative_path FROM indexed_files").all() as { id: number; relative_path: string }[]
  ).filter((row) => !seen.has(row.relative_path));
  const prunedSymbolNames = [...new Set(doomed.flatMap((row) => namesOf(row.id)))];

  // Prune before resolving so resolution sees the run's final symbol
  // universe — a deleted file's exports must not create phantom ambiguity in
  // the unique-name fallback or attract edges that would cascade-null.
  const filesRemoved = pruneUnseenFiles(db, discovered).length;

  hooks.resolve?.(db, changedFiles, prunedSymbolNames);

  return { filesAdded, filesUpdated, filesRemoved, durationMs: Date.now() - startedAt };
}
