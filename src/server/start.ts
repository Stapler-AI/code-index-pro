import { resolve } from "node:path";
import { startServer } from "./server";

/**
 * Spawnable server entry: `node dist/server/start.js [repoRoot]`. The CLI's
 * `serve` command (FR-704) dispatches here.
 */
const repoRoot = resolve(process.argv[2] ?? process.cwd());
startServer(repoRoot).catch((error) => {
  console.error(`code-index server failed to start: ${(error as Error).message}`);
  process.exit(1);
});
