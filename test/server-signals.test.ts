import type { Database } from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import type { ServerContext, ToolDefinition } from "../src/server/server";
import { executeTool, indexAgeSeconds } from "../src/server/server";
import { TOOL_CATALOG } from "../src/server/tools";
import { openDatabase } from "../src/storage/database";
import { openHealthy } from "../src/storage/health";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

function tool(name: string): ToolDefinition {
  const found = TOOL_CATALOG.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not in catalog`);
  return found;
}

function run(name: string, args: Record<string, unknown>, ctx: ServerContext): Record<string, unknown> {
  return executeTool(tool(name), args, ctx) as Record<string, unknown>;
}

function sqlCount(db: Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

describe("staleness & confidence signals (FR-604)", () => {
  let repo: FixtureRepo;
  let db: Database;
  let ctx: ServerContext;

  beforeAll(() => {
    repo = buildFixtureRepo({ git: false });
    repo.write("src/h1.ts", `export function hub(): void {}\n`);
    repo.write("src/h2.ts", `export function hub(): void {}\n`); // duplicate → ambiguity
    repo.write("src/caller.ts", `import { hub } from './h1';\nexport function caller(): void { hub() }\n`);
    // No import: calls to the duplicated name stay unresolved.
    repo.write("src/loose.tsx", `export function Loose() { hub(); return <i />; }\n`);
    repo.write("src/ext.ts", `import { useState } from 'react';\nexport function useIt(): void { useState(); }\n`);
    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
    ctx = { db, repoRoot: repo.root, recovered: false };
  });
  afterAll(() => {
    db.close();
    repo.cleanup();
  });

  it("every index-backed tool response carries index_age_seconds", () => {
    const chunkId = (db.prepare("SELECT id FROM code_chunks LIMIT 1").get() as { id: number }).id;
    const calls: [string, Record<string, unknown>][] = [
      ["index_status", {}],
      ["search_code", { query: "hub" }],
      ["get_chunk", { chunk_id: chunkId }],
      ["file_outline", { path: "src/caller.ts" }],
      ["find_symbol", { name: "caller" }],
      ["who_calls", { name: "caller" }],
      ["get_dependencies", { name: "useIt" }],
      ["impact_of_change", { name: "caller" }],
      ["module_map", {}],
      ["reindex", {}],
    ];
    for (const [name, args] of calls) {
      const payload = run(name, args, ctx);
      expect(typeof payload.index_age_seconds, `${name} missing index_age_seconds`).toBe("number");
      expect(payload.index_age_seconds as number).toBeGreaterThanOrEqual(0);
      expect(payload.index_age_seconds as number).toBeLessThan(3600); // freshly indexed
    }
  });

  it("search_structural is exempt: flagged live-tree, never stamped", () => {
    expect(tool("search_structural").indexBacked).toBe(false);
    // The exemption mechanism itself: a non-index-backed handler's payload
    // passes through executeTool unstamped.
    const live: ToolDefinition = {
      name: "live_probe",
      description: "",
      inputSchema: {},
      indexBacked: false,
      handler: () => ({ ok: true }),
    };
    expect(executeTool(live, {}, ctx)).toEqual({ ok: true });
  });

  it("index_age_seconds is null before any indexing", () => {
    const emptyRepo = buildFixtureRepo({ git: false });
    const emptyDb = openDatabase(emptyRepo.root);
    runMigrations(emptyDb);
    try {
      expect(indexAgeSeconds(emptyDb)).toBeNull();
      const payload = run("index_status", {}, { db: emptyDb, repoRoot: emptyRepo.root, recovered: false });
      expect(payload.index_age_seconds).toBeNull();
    } finally {
      emptyDb.close();
      emptyRepo.cleanup();
    }
  });

  it("who_calls reports unresolved inbound name-matches, matching ground truth", () => {
    const h1Hub = db
      .prepare(
        `SELECT s.id FROM symbols s JOIN indexed_files f ON f.id = s.file_id
         WHERE s.name = 'hub' AND f.relative_path = 'src/h1.ts'`,
      )
      .get() as { id: number };
    const payload = run("who_calls", { symbol_id: h1Hub.id }, ctx);
    const truth = sqlCount(
      db,
      `SELECT COUNT(*) AS n FROM edges
       WHERE edge_type IN ('calls', 'references') AND target_symbol_id IS NULL AND target_name = 'hub'`,
    );
    expect(truth).toBeGreaterThan(0); // Loose's ambiguous call
    expect(payload.unresolved_edges).toBe(truth);
  });

  it("get_dependencies reports unresolved outbound counts for symbol and path forms", () => {
    const bySymbol = run("get_dependencies", { name: "useIt" }, ctx);
    expect(bySymbol.unresolved_edges).toBe(1); // useState() — external

    const byPath = run("get_dependencies", { path: "src/ext.ts" }, ctx);
    expect(byPath.unresolved_edges).toBe(1); // import { useState } from 'react'
  });

  it("impact_of_change counts unresolved edges naming the traversed closure", () => {
    const h1Hub = db
      .prepare(
        `SELECT s.id FROM symbols s JOIN indexed_files f ON f.id = s.file_id
         WHERE s.name = 'hub' AND f.relative_path = 'src/h1.ts'`,
      )
      .get() as { id: number };
    const payload = run("impact_of_change", { symbol_id: h1Hub.id }, ctx) as {
      files: { symbols: { name: string }[] }[];
      unresolved_edges: number;
    };
    // Closure: caller (resolved inbound). Unresolved edges naming hub or
    // caller: Loose's hub() call.
    expect(payload.files.flatMap((f) => f.symbols.map((s) => s.name))).toEqual(["caller"]);
    expect(payload.unresolved_edges).toBe(1);
  });

  it("module_map counts unresolved imports, honoring path_prefix", () => {
    const all = run("module_map", {}, ctx);
    const truth = sqlCount(
      db,
      "SELECT COUNT(*) AS n FROM edges WHERE edge_type = 'imports' AND target_symbol_id IS NULL",
    );
    expect(truth).toBeGreaterThan(0); // the react import
    expect(all.unresolved_edges).toBe(truth);

    const elsewhere = run("module_map", { path_prefix: "lib/" }, ctx);
    expect(elsewhere.unresolved_edges).toBe(0);
  });

  it("after a forced quarantine, index_status reports the recovery event", () => {
    const brokenRepo = buildFixtureRepo({ git: false });
    const setup = openDatabase(brokenRepo.root);
    runMigrations(setup);
    runPipeline(setup, brokenRepo.root, graphHooks);
    setup.prepare("UPDATE meta SET value = '/somewhere/else' WHERE key = 'repo_root'").run();
    setup.close();

    const { db: recoveredDb, recovered } = openHealthy(brokenRepo.root);
    try {
      expect(recovered).toBe(true);
      const payload = run("index_status", {}, {
        db: recoveredDb,
        repoRoot: brokenRepo.root,
        recovered,
      }) as { recovery_events: { reason: string }[] };
      expect(payload.recovery_events.length).toBe(1);
      expect(payload.recovery_events[0].reason).toContain("repo_root");
    } finally {
      recoveredDb.close();
      brokenRepo.cleanup();
    }
  });
});
