#!/usr/bin/env node

const USAGE = `code-index — code indexing tools for AI agents

Usage: code-index <command> [options]

Commands:
  index [path]   Index a repository (not yet implemented)
  stats          Show index statistics (not yet implemented)
  clear          Delete the index (not yet implemented)
  serve [path]   Start the MCP server (not yet implemented)
`;

export function main(argv: string[]): number {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`code-index: unknown or not-yet-implemented command: ${command}\n\n`);
  process.stderr.write(USAGE);
  return 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
