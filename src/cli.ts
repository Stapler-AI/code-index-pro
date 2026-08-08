#!/usr/bin/env node

import { resolve } from "node:path";
import { runPipeline } from "./pipeline/run";
import { clearReindexRequired, isReindexRequired, openHealthy } from "./storage/health";

const USAGE = `code-index — code indexing tools for AI agents

Usage: code-index <command> [options]

Commands:
  index [path]   Index a repository incrementally (path defaults to cwd)
                 --full  clear all indexed rows first, then re-index
  stats          Show index statistics (not yet implemented)
  clear          Delete the index (not yet implemented)
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
    const delta = runPipeline(db, repoRoot);
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

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (command) {
    case "index":
      return commandIndex(rest);
    default:
      process.stderr.write(`code-index: unknown or not-yet-implemented command: ${command}\n\n`);
      process.stderr.write(USAGE);
      return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
