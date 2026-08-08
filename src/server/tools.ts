import { graphHooks } from "../graph/hooks";
import { runPipeline } from "../pipeline/run";
import {
  fileOutline,
  findSymbol,
  getDependencies,
  getFileDependencies,
  impactOfChange,
  moduleMap,
  whoCalls,
} from "../query/graph";
import { searchCode } from "../query/search";
import { getRecoveryEvents } from "../storage/health";
import type { ServerContext, ToolDefinition } from "./server";

/**
 * The 11-tool catalog (FR-602, mcp-server.md#tool-catalog). Tools delegate
 * to the M4 query layer and the DEV-206 pipeline; payloads are JSON in a
 * single text content block. search_structural is a stub until M6 lands
 * (FR-503 missing-prerequisite error).
 *
 * Design rules (FR-603, mcp-server.md#design-rules), enforced by
 * test/server-design-rules.test.ts:
 * - Summaries by default: no tool payload outside get_chunk carries a
 *   content/body field; previews are snippets or one-line signatures.
 * - Every list is capped (DEV-404 limits) and reports truncated.
 * - Every location result carries an id plus path + [start, end] lines —
 *   the path may sit one level up when it is shared by the whole group
 *   (file_outline's file, impact_of_change's per-file groups,
 *   get_dependencies' source).
 * Documented exemptions: module_map rows are aggregates (from_file is their
 * path; no single id/lines exists); unresolved edge/dependency rows have no
 * target id by nature (they are flagged hints); index_status's per-language
 * list is a bounded aggregate, not a search result, and its recovery_events
 * list grows only one entry per quarantine (practically bounded).
 */

/** Bad input / unavailable prerequisite: surfaced as an isError result. */
export class ToolError extends Error {}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolError(`${name} is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolError(`${name} must be a string`);
  return value;
}

/** limit / max_depth / ids: positive integers only (carried REV-401 note). */
function optionalPositiveInt(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolError(`${name} must be a positive integer`);
  }
  return value;
}

interface SymbolRef {
  id: number;
  name: string;
  path: string;
}

/** Resolve a who_calls/get_dependencies target from symbol_id or name. */
function resolveSymbolRef(args: Record<string, unknown>, ctx: ServerContext): SymbolRef {
  const symbolId = optionalPositiveInt(args, "symbol_id");
  if (symbolId !== undefined) {
    const row = ctx.db
      .prepare(
        `SELECT s.id, s.name, f.relative_path AS path
         FROM symbols s JOIN indexed_files f ON f.id = s.file_id WHERE s.id = ?`,
      )
      .get(symbolId) as SymbolRef | undefined;
    if (!row) throw new ToolError(`no symbol with id ${symbolId}`);
    return row;
  }
  const name = optionalString(args, "name");
  if (name === undefined) throw new ToolError("provide symbol_id or name");
  const matches = findSymbol(ctx.db, name).results;
  if (matches.length === 0) throw new ToolError(`no symbol named ${name}`);
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.id}: ${m.kind} ${m.path}:${m.line}`).join("; ");
    throw new ToolError(`symbol name ${name} is ambiguous — pass symbol_id. Candidates: ${candidates}`);
  }
  return { id: matches[0].id, name: matches[0].name, path: matches[0].path };
}

const indexStatus: ToolDefinition = {
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

const reindex: ToolDefinition = {
  name: "reindex",
  description: "Run an incremental reindex (full?: true clears and re-indexes everything). Returns the delta.",
  inputSchema: {
    type: "object",
    properties: { full: { type: "boolean" } },
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    if (args.full !== undefined && typeof args.full !== "boolean") {
      throw new ToolError("full must be a boolean");
    }
    if (args.full === true) {
      ctx.db.exec("DELETE FROM indexed_files"); // cascades clear chunks (+FTS), symbols, edges
    }
    const delta = runPipeline(ctx.db, ctx.repoRoot, graphHooks);
    return {
      files_added: delta.filesAdded,
      files_updated: delta.filesUpdated,
      files_removed: delta.filesRemoved,
      duration_ms: delta.durationMs,
    };
  },
};

const searchCodeTool: ToolDefinition = {
  name: "search_code",
  description:
    "Full-text search over indexed chunks (FTS5: terms, \"phrases\", prefix*, NEAR(a b, n), content:/node_name: filters). Ranked, with snippets.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1 },
      path_prefix: { type: "string" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const query = requireString(args, "query");
    try {
      const { results, truncated } = searchCode(ctx.db, query, {
        limit: optionalPositiveInt(args, "limit"),
        pathPrefix: optionalString(args, "path_prefix"),
      });
      // (SqliteError from a bad MATCH is caught below; anything else rethrows.)
      return {
        results: results.map((h) => ({
          id: h.chunkId,
          path: h.path,
          lines: [h.startLine, h.endLine],
          preview: h.excerpt,
          node_type: h.nodeType,
          node_name: h.nodeName,
          context_path: h.contextPath,
        })),
        truncated,
      };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (typeof (error as { code?: string }).code === "string" && (error as { code: string }).code.startsWith("SQLITE")) {
        throw new ToolError(`invalid FTS query: ${(error as Error).message}`);
      }
      throw error;
    }
  },
};

const searchStructural: ToolDefinition = {
  name: "search_structural",
  description:
    "Structural (AST-shape) search over the live working tree via ast-grep. Not yet available in this build.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      rule: { type: "string" },
      lang: { type: "string" },
      paths: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
  handler: () => {
    // FR-503 stub until DEV-501 lands: distinguishable missing-prerequisite
    // error naming the prerequisite and how to install it.
    throw new ToolError(
      "missing_prerequisite: ast-grep — search_structural requires the ast-grep binary, which is not available. " +
        "Install it with `npm install -g @ast-grep/cli` or `brew install ast-grep`, then retry.",
    );
  },
};

const getChunk: ToolDefinition = {
  name: "get_chunk",
  description: "Fetch one chunk's stored content and metadata by chunk_id — the drill-down primitive.",
  inputSchema: {
    type: "object",
    properties: { chunk_id: { type: "integer", minimum: 1 } },
    required: ["chunk_id"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const chunkId = optionalPositiveInt(args, "chunk_id");
    if (chunkId === undefined) throw new ToolError("chunk_id is required");
    const row = ctx.db
      .prepare(
        `SELECT c.id, f.relative_path AS path, f.language, c.start_line, c.end_line,
                c.node_type, c.node_name, c.context_path, c.content
         FROM code_chunks c JOIN indexed_files f ON f.id = c.file_id WHERE c.id = ?`,
      )
      .get(chunkId) as Record<string, unknown> | undefined;
    if (!row) throw new ToolError(`no chunk with id ${chunkId}`);
    return {
      id: row.id,
      path: row.path,
      language: row.language,
      lines: [row.start_line, row.end_line],
      node_type: row.node_type,
      node_name: row.node_name,
      context_path: row.context_path,
      content: row.content,
    };
  },
};

const fileOutlineTool: ToolDefinition = {
  name: "file_outline",
  description: "Ordered symbol skeleton of one file: names, kinds, signatures, line ranges, exported flags.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1 } },
    required: ["path"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const path = requireString(args, "path");
    const known = ctx.db.prepare("SELECT 1 FROM indexed_files WHERE relative_path = ?").get(path);
    if (!known) throw new ToolError(`file not in index: ${path}`);
    const { results, truncated } = fileOutline(ctx.db, path, { limit: optionalPositiveInt(args, "limit") });
    return {
      path,
      results: results.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        signature: r.signature,
        lines: [r.startLine, r.endLine],
        exported: r.exported,
      })),
      truncated,
    };
  },
};

const findSymbolTool: ToolDefinition = {
  name: "find_symbol",
  description: "Find symbol definitions by exact name; optional kind and path_prefix filters.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      kind: { type: "string" },
      path_prefix: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const { results, truncated } = findSymbol(ctx.db, requireString(args, "name"), {
      kind: optionalString(args, "kind"),
      pathPrefix: optionalString(args, "path_prefix"),
      limit: optionalPositiveInt(args, "limit"),
    });
    return {
      results: results.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        signature: s.signature,
        path: s.path,
        lines: [s.line, s.endLine],
      })),
      truncated,
    };
  },
};

const whoCallsTool: ToolDefinition = {
  name: "who_calls",
  description:
    "Inbound calls/references to a symbol (by symbol_id or unambiguous name); unresolved name-matches included, flagged resolved: false.",
  inputSchema: {
    type: "object",
    properties: {
      symbol_id: { type: "integer", minimum: 1 },
      name: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const symbol = resolveSymbolRef(args, ctx);
    const { results, truncated } = whoCalls(ctx.db, symbol.id, symbol.name, {
      limit: optionalPositiveInt(args, "limit"),
    });
    return {
      symbol,
      results: results.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        signature: c.signature,
        path: c.path,
        lines: [c.line, c.line],
        ...(c.resolved ? {} : { resolved: false }),
      })),
      truncated,
    };
  },
};

const getDependenciesTool: ToolDefinition = {
  name: "get_dependencies",
  description:
    "Outbound edges of a symbol (symbol_id or name) or a file (path): calls, imports with target_module, etc.",
  inputSchema: {
    type: "object",
    properties: {
      symbol_id: { type: "integer", minimum: 1 },
      name: { type: "string" },
      path: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const limit = optionalPositiveInt(args, "limit");
    const path = optionalString(args, "path");
    // Catalog field names are snake_case (target_module etc.).
    const toRow = (r: import("../query/graph").DependencyRow) => ({
      edge_type: r.edgeType,
      target_name: r.targetName,
      target_module: r.targetModule,
      line: r.line,
      target: r.target,
    });
    if (path !== undefined) {
      const known = ctx.db.prepare("SELECT 1 FROM indexed_files WHERE relative_path = ?").get(path);
      if (!known) throw new ToolError(`file not in index: ${path}`);
      const { results, truncated } = getFileDependencies(ctx.db, path, { limit });
      return { source: { path }, results: results.map(toRow), truncated };
    }
    const symbol = resolveSymbolRef(args, ctx);
    const { results, truncated } = getDependencies(ctx.db, symbol.id, { limit });
    return { source: symbol, results: results.map(toRow), truncated };
  },
};

const impactOfChangeTool: ToolDefinition = {
  name: "impact_of_change",
  description:
    "Transitive inbound closure (blast radius) of a symbol, grouped by file with minimum distances. max_depth defaults to 3.",
  inputSchema: {
    type: "object",
    properties: {
      symbol_id: { type: "integer", minimum: 1 },
      name: { type: "string" },
      max_depth: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const symbol = resolveSymbolRef(args, ctx);
    const { results, truncated } = impactOfChange(ctx.db, symbol.id, {
      maxDepth: optionalPositiveInt(args, "max_depth"),
      limit: optionalPositiveInt(args, "limit"),
    });
    const byFile = new Map<string, { path: string; symbols: Record<string, unknown>[] }>();
    for (const row of results) {
      const group = byFile.get(row.path) ?? { path: row.path, symbols: [] };
      group.symbols.push({
        id: row.id,
        name: row.name,
        kind: row.kind,
        signature: row.signature,
        lines: [row.line, row.endLine],
        distance: row.distance,
      });
      byFile.set(row.path, group);
    }
    return { symbol, files: [...byFile.values()], truncated };
  },
};

const moduleMapTool: ToolDefinition = {
  name: "module_map",
  description: "File-level import graph as an edge list (from file, to module/file, import count).",
  inputSchema: {
    type: "object",
    properties: {
      path_prefix: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    const { results, truncated } = moduleMap(ctx.db, {
      pathPrefix: optionalString(args, "path_prefix"),
      limit: optionalPositiveInt(args, "limit"),
    });
    return {
      results: results.map((r) => ({
        from_file: r.fromFile,
        to_module: r.toModule,
        import_count: r.importCount,
      })),
      truncated,
    };
  },
};

export const TOOL_CATALOG: ToolDefinition[] = [
  indexStatus,
  reindex,
  searchCodeTool,
  searchStructural,
  getChunk,
  fileOutlineTool,
  findSymbolTool,
  whoCallsTool,
  getDependenciesTool,
  impactOfChangeTool,
  moduleMapTool,
];
