import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openHealthy } from "../storage/health";
import { toolVersion } from "../storage/meta";
import { TOOL_CATALOG } from "./tools";

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
  /**
   * false exempts the tool from the index_age_seconds stamp (FR-604) —
   * search_structural reads the live working tree, not the index.
   */
  indexBacked?: boolean;
}

/** The 11-tool catalog lives in tools.ts (FR-602). */
const TOOLS: ToolDefinition[] = TOOL_CATALOG;

/** Seconds since the newest last_indexed row; null before any indexing. */
export function indexAgeSeconds(db: Database): number | null {
  const row = db.prepare("SELECT MAX(last_indexed) AS t FROM indexed_files").get() as { t: string | null };
  if (row.t === null) return null;
  return Math.max(0, Math.round((Date.now() - Date.parse(row.t)) / 1000));
}

/**
 * Run one tool and stamp index-backed responses with index_age_seconds
 * (FR-604) — the agent's staleness signal. search_structural (live working
 * tree) is exempt via indexBacked: false.
 */
export function executeTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: ServerContext,
): unknown {
  const payload = tool.handler(args, context);
  if (tool.indexBacked === false) return payload;
  return { ...(payload as Record<string, unknown>), index_age_seconds: indexAgeSeconds(context.db) };
}

export interface CodeIndexServer {
  server: Server;
  context: ServerContext;
  /** The background incremental reindex child, for lifecycle management. */
  reindexChild: ChildProcess | null;
  close(): Promise<void>;
}

export function createCodeIndexServer(repoRoot: string): CodeIndexServer {
  const { db, recovered } = openHealthy(repoRoot);
  // The background reindex child writes while this connection serves; WAL
  // permits one writer, so waits (e.g. the reindex tool during child writes)
  // must block briefly instead of throwing SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
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
      const payload = executeTool(tool, request.params.arguments ?? {}, context);
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
