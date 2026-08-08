import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getRecoveryEvents, openHealthy } from "../storage/health";
import { toolVersion } from "../storage/meta";

/**
 * MCP server shell (FR-601, mcp-server.md). Stdio transport; one instance
 * per repository, repo root as the startup argument. Startup: open the
 * database with health-check/recovery, then kick off an incremental reindex
 * in a CHILD PROCESS — the pipeline is synchronous, so running it in-process
 * would block the event loop and stall the first tool call. The child is the
 * already-tested `code-index index` CLI; WAL mode lets it write while this
 * process serves reads.
 *
 * Protocol discipline: stdout belongs to the MCP transport — nothing here
 * may print to it; diagnostics go to stderr.
 */

export interface ServerContext {
  db: Database;
  repoRoot: string;
  /** True when startup health-check quarantined and rebuilt the database. */
  recovered: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ServerContext) => unknown;
}

/** index_status (FR-602 catalog row): repo orientation in ~50 tokens. */
const indexStatusTool: ToolDefinition = {
  name: "index_status",
  description:
    "Index statistics: files/chunks/symbols per language, unresolved-edge count, last index time, recovery notices.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => {
    const languages = ctx.db
      .prepare(
        `SELECT f.language,
                COUNT(DISTINCT f.id) AS files,
                (SELECT COUNT(*) FROM code_chunks c WHERE c.file_id IN
                   (SELECT id FROM indexed_files WHERE language = f.language)) AS chunks,
                (SELECT COUNT(*) FROM symbols s WHERE s.file_id IN
                   (SELECT id FROM indexed_files WHERE language = f.language)) AS symbols
         FROM indexed_files f GROUP BY f.language ORDER BY f.language`,
      )
      .all();
    const unresolvedEdges = (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE target_symbol_id IS NULL").get() as { n: number }
    ).n;
    const lastIndexTime = (
      ctx.db.prepare("SELECT MAX(last_indexed) AS t FROM indexed_files").get() as { t: string | null }
    ).t;
    return {
      languages,
      unresolved_edges: unresolvedEdges,
      last_index_time: lastIndexTime,
      recovery_events: getRecoveryEvents(ctx.db),
    };
  },
};

/** The tool catalog; DEV-602 grows this to the full 11. */
export const TOOLS: ToolDefinition[] = [indexStatusTool];

export interface CodeIndexServer {
  server: Server;
  context: ServerContext;
  /** The background incremental reindex child, for lifecycle management. */
  reindexChild: ChildProcess | null;
  close(): Promise<void>;
}

export function createCodeIndexServer(repoRoot: string): CodeIndexServer {
  const { db, recovered } = openHealthy(repoRoot);
  const context: ServerContext = { db, repoRoot, recovered };

  const server = new Server(
    { name: "code-index", version: toolVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const payload = tool.handler(request.params.arguments ?? {}, context);
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `${tool.name} failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  });

  const app: CodeIndexServer = {
    server,
    context,
    reindexChild: null,
    close: async () => {
      if (app.reindexChild && app.reindexChild.exitCode === null) {
        app.reindexChild.kill();
      }
      await server.close();
      db.close();
    },
  };
  return app;
}

/**
 * Incremental reindex in a child process (the tested CLI), so the first tool
 * call is served while indexing runs. The CLI clears reindex_required after
 * a successful run, completing the recovery contract.
 */
export function startBackgroundReindex(repoRoot: string): ChildProcess {
  const cliPath = join(__dirname, "..", "cli.js");
  const child = spawn(process.execPath, [cliPath, "index", repoRoot], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  // A spawn failure must degrade to a log line, not crash the server.
  child.on("error", (error) => console.error(`background reindex failed to spawn: ${error.message}`));
  return child;
}

/** Wire the server to stdio and start the background reindex. */
export async function startServer(repoRoot: string): Promise<CodeIndexServer> {
  const app = createCodeIndexServer(repoRoot);
  const transport = new StdioServerTransport();
  await app.server.connect(transport);
  app.reindexChild = startBackgroundReindex(repoRoot);
  return app;
}
