import type { Database } from "better-sqlite3";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import type { ServerContext } from "../src/server/server";
import { TOOL_CATALOG } from "../src/server/tools";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";

/**
 * QA-803 (PRD §4 dogfood): index THIS repository with its own tool and answer
 * every index-backed decision-matrix row (search.md#decision-matrix) against
 * the result. The repo's src/ and test/ trees are copied to a temp root so
 * indexing stays hermetic (no .code-index/ in the working repo).
 */

const PACKAGE_ROOT = resolve(__dirname, "..");

function tool(name: string) {
  return TOOL_CATALOG.find((t) => t.name === name)!;
}

describe("dogfood: the tool answers the decision matrix about itself", () => {
  let root: string;
  let db: Database;
  let ctx: ServerContext;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "code-index-self-")));
    cpSync(join(PACKAGE_ROOT, "src"), join(root, "src"), { recursive: true });
    cpSync(join(PACKAGE_ROOT, "test"), join(root, "test"), { recursive: true });
    db = openDatabase(root);
    runMigrations(db);
    runPipeline(db, root, graphHooks);
    ctx = { db, repoRoot: root, recovered: false };
  }, 60_000);
  afterAll(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('"Where is upsertFile defined?" -> find_symbol', () => {
    const { results } = tool("find_symbol").handler({ name: "upsertFile", path_prefix: "src/" }, ctx) as {
      results: { path: string; kind: string; signature: string }[];
    };
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: "src/storage/writes.ts",
      kind: "function",
    });
    expect(results[0].signature).toContain("upsertFile(db");
  });

  it('"What calls replaceChunks?" -> who_calls', () => {
    const target = (
      tool("find_symbol").handler({ name: "replaceChunks", path_prefix: "src/" }, ctx) as {
        results: { id: number }[];
      }
    ).results[0];
    const { results } = tool("who_calls").handler({ symbol_id: target.id }, ctx) as {
      results: { name: string; path: string; resolved?: boolean }[];
    };
    const writeFileCaller = results.find((r) => r.name === "writeFile");
    expect(writeFileCaller).toMatchObject({ path: "src/storage/writes.ts" });
    expect(writeFileCaller!.resolved).toBeUndefined(); // resolved callers carry no flag
  });

  it('"What breaks if I change it?" -> impact_of_change', () => {
    const target = (
      tool("find_symbol").handler({ name: "replaceChunks", path_prefix: "src/" }, ctx) as {
        results: { id: number }[];
      }
    ).results[0];
    const impact = tool("impact_of_change").handler({ symbol_id: target.id }, ctx) as {
      files: { path: string; symbols: { name: string; distance: number }[] }[];
    };
    // writeFile calls replaceChunks; runPipeline's file loop calls writeFile.
    const names = impact.files.flatMap((f) => f.symbols.map((s) => s.name));
    expect(names).toContain("writeFile");
  });

  it('"What\'s in this file?" -> file_outline', () => {
    const { results } = tool("file_outline").handler({ path: "src/storage/writes.ts" }, ctx) as {
      results: { name: string; kind: string; exported: boolean }[];
    };
    const names = results.map((r) => r.name);
    for (const expected of ["upsertFile", "replaceChunks", "replaceGraphRows", "writeFile", "pruneStale"]) {
      expect(names).toContain(expected);
    }
  });

  it('"Where do we handle cache corruption?" -> search_code', () => {
    const { results } = tool("search_code").handler({ query: "quarantine", path_prefix: "src/" }, ctx) as {
      results: { path: string }[];
    };
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path === "src/storage/health.ts")).toBe(true);
  });

  it('"Which async functions lack error handling?" -> search_structural (rule)', () => {
    const rule = `id: async-no-trycatch
language: typescript
rule:
  all:
    - kind: function_declaration
    - has: { pattern: "await $EXPR", stopBy: end }
    - not:
        has: { pattern: "try { $$$A } catch ($E) { $$$B }", stopBy: end }
`;
    const { results } = tool("search_structural").handler({ rule, paths: ["src"] }, ctx) as {
      results: { path: string; preview: string }[];
    };
    // startServer awaits the transport connect with no try/catch.
    expect(results.some((r) => r.path === "src/server/server.ts" && r.preview.includes("startServer"))).toBe(
      true,
    );
  });

  it('"Find calls with a specific argument shape" -> search_structural (pattern)', () => {
    const { results } = tool("search_structural").handler(
      { pattern: "join(__dirname, $$$REST)", lang: "typescript", paths: ["src"] },
      ctx,
    ) as { results: { path: string }[] };
    // The server resolves its CLI sibling this way.
    expect(results.some((r) => r.path === "src/server/server.ts")).toBe(true);
  });

  it('"Anything about a file edited moments ago" -> search_structural sees it, the index does not', () => {
    // Built dynamically: the indexed copy includes THIS test file, so a
    // literal token in our own source would be a (stale) FTS hit.
    const token = ["unique", "Dogfood", "Token"].join("");
    writeFileSync(
      join(root, "src", "fresh-dogfood.ts"),
      `export function dogfoodFreshness(): void {\n  console.debug("${token}");\n}\n`,
    );
    const live = tool("search_structural").handler(
      { pattern: "console.debug($A)", lang: "typescript" },
      ctx,
    ) as { results: { path: string }[] };
    expect(live.results.some((r) => r.path === "src/fresh-dogfood.ts")).toBe(true);

    const stale = tool("search_code").handler({ query: token }, ctx) as { results: unknown[] };
    expect(stale.results).toEqual([]);
  });

  it('"How is this repo organized?" -> index_status + module_map', () => {
    const status = tool("index_status").handler({}, ctx) as {
      languages: { language: string; files: number; symbols: number }[];
    };
    const ts = status.languages.find((l) => l.language === "typescript");
    expect(ts).toBeDefined();
    expect(ts!.files).toBeGreaterThan(40); // src + test trees
    expect(ts!.symbols).toBeGreaterThan(100);

    const map = tool("module_map").handler({ path_prefix: "src/", limit: 200 }, ctx) as {
      results: { from_file: string; to_module: string }[];
    };
    // The CLI depends on the pipeline; the pipeline on storage.
    expect(map.results).toContainEqual(
      expect.objectContaining({ from_file: "src/cli.ts", to_module: "src/pipeline/run.ts" }),
    );
    expect(map.results).toContainEqual(
      expect.objectContaining({ from_file: "src/pipeline/run.ts", to_module: "src/storage/writes.ts" }),
    );
  });

  it("drill-down closes the loop: get_chunk on a self symbol", () => {
    const search = tool("search_code").handler({ query: "quarantineDatabase" }, ctx) as {
      results: { id: number; path: string }[];
    };
    // Anchored to the definition file rather than bm25 rank ordering.
    const hit = search.results.find((r) => r.path === "src/storage/health.ts");
    expect(hit).toBeDefined();
    const chunk = tool("get_chunk").handler({ chunk_id: hit!.id }, ctx) as {
      path: string;
      content: string;
    };
    expect(chunk.path).toBe("src/storage/health.ts");
    expect(chunk.content).toContain("quarantine");
  });
});
