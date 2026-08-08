import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

interface EdgeRow {
  id: number;
  edge_type: string;
  target_name: string;
  target_symbol_id: number | null;
}

function edgesFrom(db: Database, relativePath: string): EdgeRow[] {
  return db
    .prepare(
      `SELECT e.id, e.edge_type, e.target_name, e.target_symbol_id
       FROM edges e JOIN indexed_files f ON f.id = e.source_file_id
       WHERE f.relative_path = ? ORDER BY e.id`,
    )
    .all(relativePath) as EdgeRow[];
}

function symbolId(db: Database, relativePath: string, name: string): number {
  const row = db
    .prepare(
      `SELECT s.id FROM symbols s JOIN indexed_files f ON f.id = s.file_id
       WHERE f.relative_path = ? AND s.name = ?`,
    )
    .get(relativePath, name) as { id: number } | undefined;
  if (!row) throw new Error(`symbol ${name} not found in ${relativePath}`);
  return row.id;
}

function lastIndexed(db: Database, relativePath: string): string {
  return (
    db.prepare("SELECT last_indexed FROM indexed_files WHERE relative_path = ?").get(relativePath) as {
      last_indexed: string;
    }
  ).last_indexed;
}

describe("incremental re-resolution (FR-305)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    db = openDatabase(repo.root);
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
    repo.cleanup();
  });

  it("rename in F: inbound edges elsewhere drop to NULL without re-indexing their files", () => {
    repo.write("src/util.ts", `export function helper(): number { return 1 }\n`);
    repo.write("src/caller.ts", `import { helper } from './util';\nexport const use = () => helper();\n`);
    runPipeline(db, repo.root, graphHooks);

    const before = edgesFrom(db, "src/caller.ts");
    expect(before.every((e) => e.target_symbol_id !== null)).toBe(true);
    const stampBefore = lastIndexed(db, "src/caller.ts");

    repo.write("src/util.ts", `export function helper2(): number { return 2 }\n`);
    runPipeline(db, repo.root, graphHooks);

    const after = edgesFrom(db, "src/caller.ts");
    // caller.ts was not re-indexed: same edge ids, same last_indexed.
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(lastIndexed(db, "src/caller.ts")).toBe(stampBefore);
    // The old name resolves nowhere anymore (imports + calls edges).
    const helperEdges = after.filter((e) => e.target_name === "helper");
    expect(helperEdges.length).toBeGreaterThanOrEqual(2);
    for (const edge of helperEdges) {
      expect(edge.target_symbol_id).toBeNull();
    }
  });

  it("unchanged-name symbol: inbound edges re-link to the new symbol row (union hazard)", () => {
    // Delete-then-insert nulls inbound edges even when the name survives; a
    // symmetric-difference implementation would leave them NULL forever.
    repo.write("src/util.ts", `export function helper(): number { return 1 }\n`);
    repo.write("src/caller.ts", `import { helper } from './util';\nexport const use = () => helper();\n`);
    runPipeline(db, repo.root, graphHooks);
    const stampBefore = lastIndexed(db, "src/caller.ts");

    // Body-only edit: helper keeps its name but gets a new symbol row id.
    repo.write("src/util.ts", `export function helper(): number { return 42 }\n`);
    runPipeline(db, repo.root, graphHooks);

    const newId = symbolId(db, "src/util.ts", "helper");
    const helperEdges = edgesFrom(db, "src/caller.ts").filter((e) => e.target_name === "helper");
    expect(lastIndexed(db, "src/caller.ts")).toBe(stampBefore);
    expect(helperEdges.length).toBeGreaterThanOrEqual(2);
    for (const edge of helperEdges) {
      expect(edge.target_symbol_id).toBe(newId);
    }
  });

  it("a gained export resolves previously-unresolved inbound edges (tsx caller)", () => {
    repo.write("src/widget.tsx", `export function Widget() {\n  return <b>{futureFn()}</b>;\n}\n`);
    runPipeline(db, repo.root, graphHooks);
    expect(edgesFrom(db, "src/widget.tsx").find((e) => e.target_name === "futureFn")).toMatchObject({
      target_symbol_id: null,
    });
    const stampBefore = lastIndexed(db, "src/widget.tsx");

    repo.write("src/future.ts", `export function futureFn(): string { return 'now' }\n`);
    runPipeline(db, repo.root, graphHooks);

    expect(edgesFrom(db, "src/widget.tsx").find((e) => e.target_name === "futureFn")).toMatchObject({
      target_symbol_id: symbolId(db, "src/future.ts", "futureFn"),
    });
    expect(lastIndexed(db, "src/widget.tsx")).toBe(stampBefore);
  });

  it("a gained duplicate un-resolves a fallback-linked edge (both directions apply)", () => {
    repo.write("src/one.ts", `export function dupe(): number { return 1 }\n`);
    repo.write("src/caller.ts", `export const use = () => dupe();\n`);
    runPipeline(db, repo.root, graphHooks);
    expect(edgesFrom(db, "src/caller.ts").find((e) => e.target_name === "dupe")).toMatchObject({
      target_symbol_id: symbolId(db, "src/one.ts", "dupe"),
    });

    repo.write("src/two.ts", `export function dupe(): number { return 2 }\n`);
    runPipeline(db, repo.root, graphHooks);

    expect(edgesFrom(db, "src/caller.ts").find((e) => e.target_name === "dupe")).toMatchObject({
      target_symbol_id: null,
    });
  });

  it("a pruned file's departure re-resolves: ambiguity broken by deletion", () => {
    repo.write("src/one.ts", `export function dupe(): number { return 1 }\n`);
    repo.write("src/two.ts", `export function dupe(): number { return 2 }\n`);
    repo.write("src/caller.ts", `export const use = () => dupe();\n`);
    runPipeline(db, repo.root, graphHooks);
    expect(edgesFrom(db, "src/caller.ts").find((e) => e.target_name === "dupe")).toMatchObject({
      target_symbol_id: null, // two exported candidates
    });
    const stampBefore = lastIndexed(db, "src/caller.ts");

    repo.remove("src/two.ts");
    runPipeline(db, repo.root, graphHooks);

    expect(edgesFrom(db, "src/caller.ts").find((e) => e.target_name === "dupe")).toMatchObject({
      target_symbol_id: symbolId(db, "src/one.ts", "dupe"),
    });
    expect(lastIndexed(db, "src/caller.ts")).toBe(stampBefore);
  });

  it("unrelated edges keep their ids and values across a re-resolution run", () => {
    repo.write("src/util.ts", `export function helper(): number { return 1 }\n`);
    repo.write("src/caller.ts", `import { helper } from './util';\nexport const use = () => helper();\n`);
    runPipeline(db, repo.root, graphHooks);

    // component.tsx (base fixture) imports/calls greet — unrelated to helper.
    const unrelatedBefore = edgesFrom(db, "src/component.tsx");
    expect(unrelatedBefore.length).toBeGreaterThan(0);

    repo.write("src/util.ts", `export function helper(): number { return 99 }\n`);
    runPipeline(db, repo.root, graphHooks);

    expect(edgesFrom(db, "src/component.tsx")).toEqual(unrelatedBefore);
  });
});
