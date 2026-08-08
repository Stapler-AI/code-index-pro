import type { Database } from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import type { ServerContext } from "../src/server/server";
import { executeTool } from "../src/server/server";
import { TOOL_CATALOG } from "../src/server/tools";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

/**
 * QA-804 (PRD §4 token efficiency): the worked rename session
 * (mcp-server.md#example-agent-session) budgets ≈400 tokens of tool
 * responses; this guard asserts the real responses stay within a
 * headroomed 600 so shape regressions (verbose payloads, leaked bodies)
 * fail loudly. Tokens are approximated as ceil(chars / 4) — the standard
 * heuristic; no tokenizer dependency.
 */

const BUDGET_TOKENS = 600;

function approxTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

describe("worked-example token budget (PRD §4)", () => {
  let repo: FixtureRepo;
  let db: Database;
  let ctx: ServerContext;

  beforeAll(() => {
    repo = buildFixtureRepo({ git: false });
    // Mirrors the doc's session shape, including a ~26-line call-site body
    // for the get_chunk step (the doc budgets ~250 tokens for it).
    repo.write(
      "src/writer.ts",
      `export class Writer {
  replaceChunks(fileId: number, chunks: string[]): void {
    // replace chunks atomically
  }
}
`,
    );
    const bodyLines = Array.from({ length: 20 }, (_, i) => `  const step${i} = ${i}; // processing step`).join(
      "\n",
    );
    repo.write(
      "src/runner.ts",
      `import { Writer } from './writer';

export function indexFile(writer: Writer): void {
${bodyLines}
  writer.replaceChunks(1, []);
}

export function rebuild(writer: Writer): void {
  writer.replaceChunks(2, []);
}
`,
    );
    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
    ctx = { db, repoRoot: repo.root, recovered: false };
  });
  afterAll(() => {
    db.close();
    repo.cleanup();
  });

  function run(name: string, args: Record<string, unknown>): unknown {
    return executeTool(TOOL_CATALOG.find((t) => t.name === name)!, args, ctx);
  }

  it("the rename session's total responses stay within the headroomed budget", () => {
    const spent: Record<string, number> = {};

    // → find_symbol { name: "replaceChunks" }
    const found = run("find_symbol", { name: "replaceChunks" }) as {
      results: { id: number }[];
    };
    spent.find_symbol = approxTokens(found);

    // → who_calls { symbol_id }
    const callers = run("who_calls", { symbol_id: found.results[0].id }) as {
      results: unknown[];
    };
    spent.who_calls = approxTokens(callers);
    expect(callers.results.length).toBeGreaterThan(0);

    // → get_chunk (the indexFile call-site body, id via its chunk)
    const chunkId = (
      db
        .prepare(
          `SELECT c.id FROM code_chunks c JOIN indexed_files f ON f.id = c.file_id
           WHERE f.relative_path = 'src/runner.ts' AND c.node_name = 'indexFile'
             AND c.node_type = 'function_declaration'`,
        )
        .get() as { id: number }
    ).id;
    const chunk = run("get_chunk", { chunk_id: chunkId }) as { content: string };
    spent.get_chunk = approxTokens(chunk);
    expect(chunk.content).toContain("replaceChunks");

    // (edits happen) → reindex {}
    repo.edit("src/writer.ts", (c) => c.replace("replaceChunks", "replaceFileChunks"));
    repo.edit("src/runner.ts", (c) => c.replaceAll("replaceChunks", "replaceFileChunks"));
    const delta = run("reindex", {}) as { files_updated: number };
    spent.reindex = approxTokens(delta);
    expect(delta.files_updated).toBe(2);

    const total = Object.values(spent).reduce((a, b) => a + b, 0);
    // Diagnostic on failure: which step blew the budget.
    expect(total, `per-step tokens: ${JSON.stringify(spent)}`).toBeLessThanOrEqual(BUDGET_TOKENS);
  });

  it("each step is individually lean (no single response dominates the budget)", () => {
    const found = run("find_symbol", { name: "replaceFileChunks" }) as { results: { id: number }[] };
    expect(approxTokens(found)).toBeLessThanOrEqual(100);

    const callers = run("who_calls", { symbol_id: found.results[0].id });
    expect(approxTokens(callers)).toBeLessThanOrEqual(200);

    const delta = run("reindex", {});
    expect(approxTokens(delta)).toBeLessThanOrEqual(50);
  });
});
