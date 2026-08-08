import type { Database } from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { resetAstGrepVersionCheck } from "../src/query/structural";
import type { ServerContext } from "../src/server/server";
import { executeTool } from "../src/server/server";
import { TOOL_CATALOG } from "../src/server/tools";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

/**
 * QA-503: with ast-grep absent from PATH, search_structural degrades to the
 * named-prerequisite error while every other tool answers normally.
 */

describe("graceful degradation without ast-grep (FR-503)", () => {
  let repo: FixtureRepo;
  let db: Database;
  let ctx: ServerContext;
  let emptyBinDir: string;
  let originalPath: string;

  beforeAll(() => {
    repo = buildFixtureRepo({ git: false });
    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
    ctx = { db, repoRoot: repo.root, recovered: false };

    // A PATH with no ast-grep anywhere.
    emptyBinDir = mkdtempSync(join(tmpdir(), "no-ast-grep-"));
    originalPath = process.env.PATH!;
    process.env.PATH = emptyBinDir;
    resetAstGrepVersionCheck();
  });
  afterAll(() => {
    process.env.PATH = originalPath;
    resetAstGrepVersionCheck();
    rmSync(emptyBinDir, { recursive: true, force: true });
    db.close();
    repo.cleanup();
  });

  it("search_structural names the missing prerequisite and how to install it", () => {
    expect(() =>
      executeTool(
        TOOL_CATALOG.find((t) => t.name === "search_structural")!,
        { pattern: "console.log($A)", lang: "javascript" },
        ctx,
      ),
    ).toThrow(/missing_prerequisite: ast-grep[\s\S]*Install it/);
  });

  it("every other tool still answers normally", () => {
    const chunkId = (db.prepare("SELECT id FROM code_chunks LIMIT 1").get() as { id: number }).id;
    const greetId = (db.prepare("SELECT id FROM symbols WHERE name = 'greet'").get() as { id: number }).id;
    const calls: [string, Record<string, unknown>][] = [
      ["index_status", {}],
      ["search_code", { query: "greet" }],
      ["get_chunk", { chunk_id: chunkId }],
      ["file_outline", { path: "src/greet.ts" }],
      ["find_symbol", { name: "greet" }],
      ["who_calls", { symbol_id: greetId }],
      ["get_dependencies", { name: "Hello" }],
      ["impact_of_change", { name: "greet" }],
      ["module_map", {}],
      ["reindex", {}],
    ];
    for (const [name, args] of calls) {
      const tool = TOOL_CATALOG.find((t) => t.name === name)!;
      const payload = executeTool(tool, args, ctx) as Record<string, unknown>;
      expect(payload, `${name} should answer without ast-grep`).toBeTruthy();
      expect(typeof payload.index_age_seconds).toBe("number");
    }
    // "Answers normally" means real answers, not just no-throw.
    const search = executeTool(TOOL_CATALOG.find((t) => t.name === "search_code")!, { query: "greet" }, ctx) as {
      results: unknown[];
    };
    expect(search.results.length).toBeGreaterThan(0);
  });

  it("ast-grep is a runtime prerequisite only — never an install dependency", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(allDeps.some((d) => d.includes("ast-grep"))).toBe(false);
  });
});
