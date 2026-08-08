import type { Database } from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { classHierarchy, GRAPH_DEFAULT_LIMIT, HIERARCHY_MAX_DEPTH } from "../src/query/graph";
import { SEARCH_CODE_DEFAULT_LIMIT } from "../src/query/search";
import { searchStructural, STRUCTURAL_DEFAULT_LIMIT } from "../src/query/structural";
import type { ServerContext } from "../src/server/server";
import { TOOL_CATALOG } from "../src/server/tools";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

/**
 * QA-802 (DEV-802 audit): every list-returning tool against oversized
 * fixtures — every response bounded, every truncation flagged. Audit
 * conclusions: all query/tool lists ride the DEV-404 sentinel; recursion is
 * depth-capped (impact maxDepth, hierarchy fixed 10); chunk content is capped
 * at extraction; the one gap found and fixed is prefilter candidate lists
 * beyond PREFILTER_ARGV_CAP, which now become a result filter instead of
 * spawn argv.
 */

const OVERSIZED = 120; // > GRAPH_DEFAULT_LIMIT (50) and > PREFILTER_ARGV_CAP (100)

function tool(name: string) {
  return TOOL_CATALOG.find((t) => t.name === name)!;
}

describe("exhaustive cap conformance (DEV-802 / QA-802)", () => {
  let repo: FixtureRepo;
  let db: Database;
  let ctx: ServerContext;

  beforeAll(() => {
    repo = buildFixtureRepo({ git: false });
    repo.write("src/hub.ts", `export function hub(): void {}\n`);
    for (let i = 0; i < OVERSIZED; i++) {
      repo.write(
        `src/dup/d${i}.ts`,
        `import { hub } from '../hub';
export function sharedName(): void {
  // heapmarker lives in every dup body
  hub();
}
`,
      );
    }
    // hub() also appears in a file WITHOUT the marker (prefilter must exclude it).
    repo.write("src/unmarked.ts", `import { hub } from './hub';\nexport function other(): void { hub() }\n`);
    // 55 outbound calls from one function; 56 outline rows.
    const fns = Array.from({ length: 55 }, (_, i) => `function f${i}(): void {}`).join("\n");
    const calls = Array.from({ length: 55 }, (_, i) => `  f${i}();`).join("\n");
    repo.write("src/big.ts", `${fns}\nexport function bigCaller(): void {\n${calls}\n}\n`);
    // An oversized function body (chunk content must stay capped).
    repo.write(
      "src/huge.ts",
      `export function huge(): void {\n${Array.from({ length: 200 }, (_, i) => `  // filler line ${i} padding padding padding`).join("\n")}\n}\n`,
    );
    // A 12-deep class chain: ancestors beyond HIERARCHY_MAX_DEPTH.
    const chain = ["export class C0 {}"]
      .concat(Array.from({ length: 12 }, (_, i) => `export class C${i + 1} extends C${i} {}`))
      .join("\n");
    repo.write("src/chain.ts", `${chain}\n`);

    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
    ctx = { db, repoRoot: repo.root, recovered: false };
  }, 60_000);
  afterAll(() => {
    db.close();
    repo.cleanup();
  });

  function symbolId(path: string, name: string): number {
    return (
      db
        .prepare(
          `SELECT s.id FROM symbols s JOIN indexed_files f ON f.id = s.file_id
           WHERE f.relative_path = ? AND s.name = ?`,
        )
        .get(path, name) as { id: number }
    ).id;
  }

  it("search_code: bounded at the default with truncation flagged", () => {
    const { results, truncated } = tool("search_code").handler({ query: "heapmarker" }, ctx) as {
      results: unknown[];
      truncated: boolean;
    };
    expect(results.length).toBe(SEARCH_CODE_DEFAULT_LIMIT);
    expect(truncated).toBe(true);
  });

  it("find_symbol: 120 same-named symbols cut at 50, flagged", () => {
    const { results, truncated } = tool("find_symbol").handler({ name: "sharedName" }, ctx) as {
      results: unknown[];
      truncated: boolean;
    };
    expect(results.length).toBe(GRAPH_DEFAULT_LIMIT);
    expect(truncated).toBe(true);
  });

  it("who_calls: 120 callers cut at 50, flagged", () => {
    const { results, truncated } = tool("who_calls").handler(
      { symbol_id: symbolId("src/hub.ts", "hub") },
      ctx,
    ) as { results: unknown[]; truncated: boolean };
    expect(results.length).toBe(GRAPH_DEFAULT_LIMIT);
    expect(truncated).toBe(true);
  });

  it("impact_of_change: 120-wide closure cut at 50, flagged", () => {
    const { files, truncated } = tool("impact_of_change").handler(
      { symbol_id: symbolId("src/hub.ts", "hub") },
      ctx,
    ) as { files: { symbols: unknown[] }[]; truncated: boolean };
    expect(files.reduce((n, f) => n + f.symbols.length, 0)).toBe(GRAPH_DEFAULT_LIMIT);
    expect(truncated).toBe(true);
  });

  it("get_dependencies: 55 outbound edges cut at 50, flagged", () => {
    const { results, truncated } = tool("get_dependencies").handler({ name: "bigCaller" }, ctx) as {
      results: unknown[];
      truncated: boolean;
    };
    expect(results.length).toBe(GRAPH_DEFAULT_LIMIT);
    expect(truncated).toBe(true);
  });

  it("module_map: 120+ import edges cut at 50, flagged", () => {
    const { results, truncated } = tool("module_map").handler({}, ctx) as {
      results: unknown[];
      truncated: boolean;
    };
    expect(results.length).toBe(GRAPH_DEFAULT_LIMIT);
    expect(truncated).toBe(true);
  });

  it("file_outline: 56 symbols cut at 50, flagged", () => {
    const { results, truncated } = tool("file_outline").handler({ path: "src/big.ts" }, ctx) as {
      results: unknown[];
      truncated: boolean;
    };
    expect(results.length).toBe(GRAPH_DEFAULT_LIMIT);
    expect(truncated).toBe(true);
  });

  it("search_structural: 120+ matches cut at the default, flagged", () => {
    const { results, truncated } = tool("search_structural").handler(
      { pattern: "hub()", lang: "typescript" },
      ctx,
    ) as { results: unknown[]; truncated: boolean };
    expect(results.length).toBe(STRUCTURAL_DEFAULT_LIMIT);
    expect(truncated).toBe(true);
  });

  it("prefilter beyond PREFILTER_ARGV_CAP still bounds argv and filters results", () => {
    // 120 candidates (> 100): the query runs whole-tree and filters, so the
    // unmarked file's hub() call must NOT appear despite matching the pattern.
    // limit == candidate count pins the filter-BEFORE-cap order: cap-first
    // would see 121 raw matches and wrongly report truncated: true.
    const { results, truncated } = tool("search_structural").handler(
      { pattern: "hub()", lang: "typescript", prefilter_fts: "heapmarker", limit: OVERSIZED },
      ctx,
    ) as { results: { path: string }[]; truncated: boolean };
    expect(results.length).toBe(OVERSIZED);
    expect(results.every((r) => r.path.startsWith("src/dup/"))).toBe(true);
    expect(truncated).toBe(false);
  });

  it("an empty candidates list means nothing qualifies — never the whole tree", () => {
    const { results, truncated } = searchStructural(ctx.repoRoot, {
      pattern: "hub()",
      lang: "typescript",
      candidates: [],
    });
    expect(results).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("class hierarchy recursion stays depth-capped", () => {
    const leafId = symbolId("src/chain.ts", "C12");
    const { results } = classHierarchy(db, leafId, "ancestors");
    expect(results.length).toBe(HIERARCHY_MAX_DEPTH); // 12 ancestors exist; cap wins
  });

  it("get_chunk content honors the extraction cap", () => {
    const chunkId = (
      db
        .prepare(
          `SELECT c.id FROM code_chunks c JOIN indexed_files f ON f.id = c.file_id
           WHERE f.relative_path = 'src/huge.ts' AND c.node_type = 'function_declaration'`,
        )
        .get() as { id: number }
    ).id;
    const chunk = tool("get_chunk").handler({ chunk_id: chunkId }, ctx) as { content: string };
    expect(chunk.content.length).toBeLessThanOrEqual(2003); // 2000 + "..."
  });

  it("index_status and reindex stay scalar-bounded", () => {
    const status = tool("index_status").handler({}, ctx) as {
      languages: unknown[];
      recovery_events: unknown[];
    };
    expect(status.languages.length).toBeLessThanOrEqual(3); // supported languages
    expect(status.recovery_events).toEqual([]);

    const delta = tool("reindex").handler({}, ctx) as Record<string, unknown>;
    expect(Object.keys(delta).sort()).toEqual([
      "duration_ms",
      "files_added",
      "files_removed",
      "files_updated",
    ]);
  });
});
