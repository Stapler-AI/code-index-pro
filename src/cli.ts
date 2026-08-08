#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { graphHooks } from "./graph/hooks";
import { runPipeline } from "./pipeline/run";
import { CODE_INDEX_DIR } from "./storage/database";
import { clearReindexRequired, isReindexRequired, openHealthy } from "./storage/health";

const USAGE = `code-index — code indexing tools for AI agents

Usage: code-index <command> [options]

Commands:
  index [path]   Index a repository incrementally (path defaults to cwd)
                 --full  clear all indexed rows first, then re-index
  stats          Show index statistics for the current directory's repo
  clear          Delete the current directory's index (.code-index/)
  serve [path]   Start the MCP server (not yet implemented)
`;

/** `code-index index [path] [--full]` (FR-701). */
function commandIndex(args: string[]): number {
  const full = args.includes("--full");
  const positional = args.filter((a) => !a.startsWith("-"));
  const repoRoot = resolve(positional[0] ?? process.cwd());

  const { db, recovered } = openHealthy(repoRoot);
  try {
    if (recovered) {
      process.stdout.write("Previous index was unhealthy — quarantined and rebuilt; running a full re-index.\n");
    }
    if (full) {
      db.exec("DELETE FROM indexed_files"); // cascades clear chunks (+FTS), symbols, edges
    }
    const delta = runPipeline(db, repoRoot, graphHooks);
    // A successful run over a rebuilt (empty) database IS the full re-index
    // the recovery flagged, so the flag can come down.
    if (isReindexRequired(db)) clearReindexRequired(db);
    process.stdout.write(
      `Indexed ${repoRoot}: ${delta.filesAdded} added, ${delta.filesUpdated} updated, ` +
        `${delta.filesRemoved} removed in ${delta.durationMs} ms\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

/** `code-index stats` (FR-702). */
function commandStats(): number {
  const repoRoot = process.cwd();
  const { db, recovered } = openHealthy(repoRoot);
  try {
    if (recovered) {
      process.stdout.write(
        "Previous index was unhealthy — quarantined and rebuilt; stats below reflect the empty rebuilt index. Run `code-index index` to repopulate.\n",
      );
    }
    const perLanguage = db
      .prepare(
        `SELECT f.language,
                COUNT(DISTINCT f.id) AS files,
                (SELECT COUNT(*) FROM code_chunks c WHERE c.file_id IN
                   (SELECT id FROM indexed_files WHERE language = f.language)) AS chunks,
                (SELECT COUNT(*) FROM symbols s WHERE s.file_id IN
                   (SELECT id FROM indexed_files WHERE language = f.language)) AS symbols
         FROM indexed_files f GROUP BY f.language ORDER BY f.language`,
      )
      .all() as { language: string; files: number; chunks: number; symbols: number }[];
    const unresolvedEdges = (
      db.prepare("SELECT COUNT(*) AS n FROM edges WHERE target_symbol_id IS NULL").get() as { n: number }
    ).n;
    const lastRun = (
      db.prepare("SELECT MAX(last_indexed) AS t FROM indexed_files").get() as { t: string | null }
    ).t;

    process.stdout.write(`Index stats for ${repoRoot}\n`);
    for (const row of perLanguage) {
      process.stdout.write(`  ${row.language}: ${row.files} files, ${row.chunks} chunks, ${row.symbols} symbols\n`);
    }
    if (perLanguage.length === 0) {
      process.stdout.write("  (empty index)\n");
    }
    process.stdout.write(`  unresolved edges: ${unresolvedEdges}\n`);
    process.stdout.write(`  last run: ${lastRun ?? "never"}\n`);
    return 0;
  } finally {
    db.close();
  }
}

/** `code-index clear` (FR-703): removes the whole .code-index/ directory. */
function commandClear(): number {
  const codeIndexDir = join(process.cwd(), CODE_INDEX_DIR);
  if (!existsSync(codeIndexDir)) {
    process.stdout.write("No index to clear.\n");
    return 0;
  }
  rmSync(codeIndexDir, { recursive: true, force: true });
  process.stdout.write(`Removed ${codeIndexDir}\n`);
  return 0;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (command) {
    case "index":
      return commandIndex(rest);
    case "stats":
      return commandStats();
    case "clear":
      return commandClear();
    default:
      process.stderr.write(`code-index: unknown or not-yet-implemented command: ${command}\n\n`);
      process.stderr.write(USAGE);
      return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
