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
}

export interface PipelineHooks {
  /** Symbol & edge extraction (M3). Default: no symbols, no edges. */
  extract?: (input: ExtractionInput) => Extraction;
  /** Edge resolution (M3), run once per run after persist and prune complete. */
  resolve?: (db: Database, changedFiles: ChangedFileRecord[]) => void;
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

  const hasRow = db.prepare("SELECT 1 FROM indexed_files WHERE relative_path = ?");

  for (const relativePath of discovered) {
    const language = detectLanguage(relativePath);
    if (language === null) continue;

    const decision = evaluateFile(db, repoRoot, relativePath);
    if (decision.action === "skip") continue;

    const tree = parseSource(language, decision.content);
    const chunks = extractChunks(tree, decision.content, language);
    const { symbols, edges } = extract({ relativePath, language, content: decision.content, tree, chunks });

    const isNew = hasRow.get(relativePath) === undefined;
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

    changedFiles.push({ fileId, relativePath, language });
    if (isNew) filesAdded += 1;
    else filesUpdated += 1;
  }

  // Prune before resolving so resolution sees the run's final symbol
  // universe — a deleted file's exports must not create phantom ambiguity in
  // the unique-name fallback or attract edges that would cascade-null.
  const filesRemoved = pruneUnseenFiles(db, discovered).length;

  hooks.resolve?.(db, changedFiles);

  return { filesAdded, filesUpdated, filesRemoved, durationMs: Date.now() - startedAt };
}
