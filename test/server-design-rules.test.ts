import type { Database } from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import type { ServerContext } from "../src/server/server";
import { TOOL_CATALOG } from "../src/server/tools";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

/**
 * FR-603 conformance, parametrized over every list-returning tool. Handlers
 * are exercised directly (the stdio transport is QA-601/602's subject).
 */

function tool(name: string) {
  const found = TOOL_CATALOG.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not in catalog`);
  return found;
}

/** Recursively collect all object keys in a payload. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      allKeys(child, into);
    }
  }
  return into;
}

interface LocationRow {
  id?: number | null;
  path?: string;
  lines?: number[];
}

function expectLocationRow(row: LocationRow, options: { pathAtGroupLevel?: boolean } = {}): void {
  expect(typeof row.id).toBe("number");
  expect(Array.isArray(row.lines)).toBe(true);
  expect(row.lines!.length).toBe(2);
  expect(row.lines![0]).toBeLessThanOrEqual(row.lines![1]);
  if (!options.pathAtGroupLevel) expect(typeof row.path).toBe("string");
}

describe("MCP design rules (FR-603)", () => {
  let repo: FixtureRepo;
  let db: Database;
  let ctx: ServerContext;

  // Each list tool has at least 2 rows so limit: 1 forces truncation.
  const LIST_CALLS: { name: string; full: Record<string, unknown>; rows: (p: any) => unknown[] }[] = [
    { name: "search_code", full: { query: "capme" }, rows: (p) => p.results },
    { name: "file_outline", full: { path: "src/outline.ts" }, rows: (p) => p.results },
    { name: "find_symbol", full: { name: "shared" }, rows: (p) => p.results },
    { name: "who_calls", full: { name: "hub" }, rows: (p) => p.results },
    { name: "get_dependencies", full: { name: "c1" }, rows: (p) => p.results },
    { name: "impact_of_change", full: { name: "hub" }, rows: (p) => p.files },
    { name: "module_map", full: {}, rows: (p) => p.results },
  ];

  beforeAll(() => {
    repo = buildFixtureRepo({ git: false });
    repo.write("src/hub.ts", `export function hub(): void {}\n`);
    repo.write(
      "src/c1.ts",
      `import { hub } from './hub';
function localHelper(): void {}
export function c1(): void {
  hub();
  localHelper();
}
`,
    );
    repo.write("src/c2.tsx", `import { hub } from './hub';\nexport function c2() { hub(); return <b />; }\n`);
    repo.write(
      "src/outline.ts",
      `function first(): void {
  // capme marker one
}
function second(): void {
  // capme marker two
}
`,
    );
    repo.write("src/s1.ts", `export function shared(): void {}\n`);
    repo.write("src/s2.ts", `export function shared(): void {}\n`);
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

  it.each(LIST_CALLS)("$name: capped with a truncated flag, both states", ({ name, full, rows }) => {
    const uncapped = tool(name).handler(full, ctx) as { truncated: boolean };
    expect(uncapped.truncated).toBe(false);
    expect(rows(uncapped).length).toBeGreaterThanOrEqual(2);

    const capped = tool(name).handler({ ...full, limit: 1 }, ctx) as { truncated: boolean };
    expect(capped.truncated).toBe(true);
    expect(rows(capped).length).toBe(1);
  });

  const SOURCE_KEYS = ["content", "body", "source_code", "code", "text"];

  it.each(LIST_CALLS)("$name: no full-source fields anywhere in the payload", ({ name, full }) => {
    const keys = allKeys(tool(name).handler(full, ctx));
    for (const forbidden of SOURCE_KEYS) {
      expect(keys.has(forbidden), `${name} leaked a ${forbidden} field`).toBe(false);
    }
  });

  it("index_status carries no source either", () => {
    const keys = allKeys(tool("index_status").handler({}, ctx));
    expect(keys.has("content")).toBe(false);
  });

  it("get_chunk is the single drill-down primitive that DOES return content", () => {
    const search = tool("search_code").handler({ query: "capme" }, ctx) as {
      results: { id: number }[];
    };
    const chunk = tool("get_chunk").handler({ chunk_id: search.results[0].id }, ctx) as {
      id: number;
      path: string;
      lines: number[];
      content: string;
    };
    expect(chunk.content).toContain("capme");
    expectLocationRow(chunk);
  });

  it("search_code results carry id/path/lines", () => {
    const { results } = tool("search_code").handler({ query: "capme" }, ctx) as {
      results: LocationRow[];
    };
    for (const row of results) expectLocationRow(row);
  });

  it("find_symbol results carry id/path/lines with true spans", () => {
    const { results } = tool("find_symbol").handler({ name: "c1" }, ctx) as { results: LocationRow[] };
    for (const row of results) expectLocationRow(row);
    expect(results[0].lines![1]).toBeGreaterThan(results[0].lines![0]); // multi-line fn
  });

  it("who_calls results carry id/path/lines", () => {
    const { results } = tool("who_calls").handler({ name: "hub" }, ctx) as { results: LocationRow[] };
    expect(results.length).toBe(2);
    for (const row of results) expectLocationRow(row);
  });

  it("file_outline rows carry id/lines; the shared path sits at payload level", () => {
    const payload = tool("file_outline").handler({ path: "src/outline.ts" }, ctx) as {
      path: string;
      results: LocationRow[];
    };
    expect(payload.path).toBe("src/outline.ts");
    for (const row of payload.results) expectLocationRow(row, { pathAtGroupLevel: true });
  });

  it("impact_of_change symbols carry id/lines; path sits at the file group", () => {
    const payload = tool("impact_of_change").handler({ name: "hub" }, ctx) as {
      files: { path: string; symbols: LocationRow[] }[];
    };
    expect(payload.files.length).toBe(2);
    for (const group of payload.files) {
      expect(typeof group.path).toBe("string");
      for (const row of group.symbols) expectLocationRow(row, { pathAtGroupLevel: true });
    }
  });

  it("get_dependencies rows carry line + target id when resolved; unresolved are flagged hints", () => {
    const payload = tool("get_dependencies").handler({ name: "c1" }, ctx) as {
      source: { id: number; path: string };
      results: { line: number; target: { id: number; path: string } | null; target_name: string }[];
    };
    expect(typeof payload.source.id).toBe("number");
    expect(payload.results.length).toBe(2); // hub + localHelper calls
    for (const row of payload.results) {
      expect(typeof row.line).toBe("number");
      expect(typeof row.target_name).toBe("string");
      // Both fixture calls resolve; resolved targets carry id + path.
      expect(row.target).not.toBeNull();
      expect(typeof row.target!.id).toBe("number");
      expect(typeof row.target!.path).toBe("string");
    }
  });

  it("unresolved dependency rows are id-less flagged hints, not dropped (documented exemption)", () => {
    const payload = tool("get_dependencies").handler({ name: "useIt" }, ctx) as {
      results: { target_name: string; target: unknown; target_module: string | null }[];
    };
    const external = payload.results.find((r) => r.target_name === "useState");
    expect(external).toBeDefined();
    expect(external!.target).toBeNull();
  });

  it("module_map rows are documented aggregates: from_file is their path", () => {
    const { results } = tool("module_map").handler({}, ctx) as {
      results: { from_file: string; to_module: string; import_count: number }[];
    };
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const row of results) {
      expect(typeof row.from_file).toBe("string");
      expect(typeof row.to_module).toBe("string");
      expect(typeof row.import_count).toBe("number");
    }
  });
});
