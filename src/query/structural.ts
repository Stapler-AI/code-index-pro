import { execFileSync } from "node:child_process";
import type { Database } from "better-sqlite3";
import { capResults, CappedResults } from "./caps";

/**
 * Structural search (FR-501, search.md#structural-search-ast-grep): shell out
 * to the ast-grep CLI with --json and normalize matches into the shared
 * envelope (no id — ast-grep results are live-working-tree, not index rows;
 * agents fall back to the line range). ALWAYS parses the working tree, never
 * the database — this is the freshness-guaranteed path.
 *
 * Minimum ast-grep version (PRD §8 output-drift risk): the --json match
 * shape used here (text / range.start.line 0-based / file) is verified
 * against 0.42.0; older CLIs may emit different shapes, so anything below
 * the pin is rejected at runtime with a clear message.
 */

export const MIN_AST_GREP_VERSION = "0.42.0";

export const STRUCTURAL_DEFAULT_LIMIT = 20;

/** Matched text is a preview, not a body: one line, capped. */
const PREVIEW_CAP_CHARS = 200;

export class StructuralSearchError extends Error {}

export interface StructuralQuery {
  /** Single-node pattern (ast-grep run). Mutually exclusive with rule. */
  pattern?: string;
  /** Inline YAML rule (ast-grep scan). Mutually exclusive with pattern. */
  rule?: string;
  /** Required with pattern; a rule's YAML names its own language. */
  lang?: string;
  /** Paths relative to the repo root; defaults to the whole tree. */
  paths?: string[];
  limit?: number;
}

/** Envelope-shaped match: no id (live working tree, not an index row). */
export interface StructuralMatch {
  path: string;
  lines: [number, number];
  preview: string;
}

interface AstGrepJsonMatch {
  text: string;
  file: string;
  range: { start: { line: number }; end: { line: number } };
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_CAP_CHARS ? `${collapsed.slice(0, PREVIEW_CAP_CHARS)}...` : collapsed;
}

function parseVersion(output: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(found: number[], min: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (found[i] !== min[i]) return found[i] > min[i];
  }
  return true;
}

let versionChecked = false;

/** Verify the binary meets the pin; cached after the first success. */
export function checkAstGrepVersion(): void {
  if (versionChecked) return;
  const output = execFileSync("ast-grep", ["--version"], { encoding: "utf8" });
  const found = parseVersion(output);
  const min = parseVersion(MIN_AST_GREP_VERSION)!;
  if (!found || !versionAtLeast(found, min)) {
    throw new StructuralSearchError(
      `ast-grep ${output.trim() || "(unknown version)"} is older than the minimum ${MIN_AST_GREP_VERSION}; ` +
        "its --json output may differ. Upgrade with `npm install -g @ast-grep/cli` or `brew upgrade ast-grep`.",
    );
  }
  versionChecked = true;
}

/** Test seam: force the next call to re-probe the binary version. */
export function resetAstGrepVersionCheck(): void {
  versionChecked = false;
}

export interface PrefilterOptions {
  /** Restrict candidates to indexed files of this language. */
  language?: string;
  /** Restrict candidates to files with chunks matching this FTS query. */
  ftsQuery?: string;
}

/**
 * Index-backed candidate pre-filtering (FR-502, search.md#scope-control):
 * turn a whole-repo parse into a candidate-list parse. Only the FILE LIST
 * comes from the index — the matching itself still parses the live working
 * tree. Deliberately opt-in: a prefiltered search cannot see files created
 * after the last index run, trading the freshness guarantee for speed.
 */
export function structuralCandidates(db: Database, options: PrefilterOptions): string[] {
  const language = options.language ?? null;
  const ftsQuery = options.ftsQuery ?? null;
  const rows = db
    .prepare(
      `SELECT f.relative_path FROM indexed_files f
       WHERE (? IS NULL OR f.language = ?)
         AND (? IS NULL OR f.id IN
           (SELECT c.file_id FROM chunks_fts
            JOIN code_chunks c ON c.id = chunks_fts.rowid
            WHERE chunks_fts MATCH ?))
       ORDER BY f.relative_path`,
    )
    .all(language, language, ftsQuery, ftsQuery) as { relative_path: string }[];
  return rows.map((r) => r.relative_path);
}

/**
 * Run one structural query against the live working tree under repoRoot.
 * Throws StructuralSearchError for invalid input or an ast-grep failure.
 */
export function searchStructural(repoRoot: string, query: StructuralQuery): CappedResults<StructuralMatch> {
  const { pattern, rule, lang, paths } = query;
  const limit = query.limit ?? STRUCTURAL_DEFAULT_LIMIT;
  if ((pattern === undefined) === (rule === undefined)) {
    throw new StructuralSearchError("provide exactly one of pattern or rule");
  }
  if (pattern !== undefined && !lang) {
    throw new StructuralSearchError("lang is required with pattern");
  }

  checkAstGrepVersion();

  const targets = paths && paths.length > 0 ? paths : ["."];
  const args =
    pattern !== undefined
      ? ["run", "--pattern", pattern, "--lang", lang!, "--json", ...targets]
      : ["scan", "--inline-rules", rule!, "--json", ...targets];

  let stdout: string;
  try {
    stdout = execFileSync("ast-grep", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // Capture stderr for error reporting instead of leaking it to ours.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // `run` exits 1 grep-style when nothing matched, still printing "[]" —
    // valid JSON on stdout means a completed (empty) search, not a failure.
    const failedStdout = (error as { stdout?: string }).stdout?.toString() ?? "";
    if (failedStdout.trimStart().startsWith("[")) {
      stdout = failedStdout;
    } else {
      const stderr = (error as { stderr?: string }).stderr?.toString().trim();
      throw new StructuralSearchError(`ast-grep failed: ${stderr || (error as Error).message}`);
    }
  }

  const matches = JSON.parse(stdout) as AstGrepJsonMatch[];
  return capResults(
    matches.map((m) => ({
      path: m.file,
      // ast-grep lines are 0-based; the envelope is 1-based.
      lines: [m.range.start.line + 1, m.range.end.line + 1] as [number, number],
      preview: oneLine(m.text),
    })),
    limit,
  );
}
