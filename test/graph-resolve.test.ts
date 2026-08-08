import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

interface EdgeRow {
  edge_type: string;
  target_name: string;
  target_module: string | null;
  target_symbol_id: number | null;
}

function edgesFrom(db: Database, relativePath: string): EdgeRow[] {
  return db
    .prepare(
      `SELECT e.edge_type, e.target_name, e.target_module, e.target_symbol_id
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

describe("edge resolution ladder (FR-304)", () => {
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

  it("resolves a cross-file call through its import (extensionless ./x -> x.ts)", () => {
    repo.write("src/util.ts", `export function helper(x: string): string { return x }\n`);
    repo.write(
      "src/caller.ts",
      `import { helper } from './util';\nexport function callHelper() { return helper('hi') }\n`,
    );
    runPipeline(db, repo.root, graphHooks);

    const helperId = symbolId(db, "src/util.ts", "helper");
    const edges = edgesFrom(db, "src/caller.ts");
    expect(edges.find((e) => e.edge_type === "calls" && e.target_name === "helper")).toMatchObject({
      target_symbol_id: helperId,
    });
    // The imports edge itself resolves too.
    expect(edges.find((e) => e.edge_type === "imports")).toMatchObject({
      target_module: "./util",
      target_symbol_id: helperId,
    });
  });

  it("resolves ./dir to dir/index.ts", () => {
    repo.write("src/dir/index.ts", `export function fromIndex(): void {}\n`);
    repo.write("src/user.ts", `import { fromIndex } from './dir';\nexport const go = () => fromIndex();\n`);
    runPipeline(db, repo.root, graphHooks);

    const target = symbolId(db, "src/dir/index.ts", "fromIndex");
    const call = edgesFrom(db, "src/user.ts").find((e) => e.edge_type === "calls");
    expect(call).toMatchObject({ target_name: "fromIndex", target_symbol_id: target });
  });

  it("resolves a same-file call to the local declaration", () => {
    repo.write("src/same.ts", `function local(): void {}\nexport function run() { local() }\n`);
    runPipeline(db, repo.root, graphHooks);

    const call = edgesFrom(db, "src/same.ts").find((e) => e.edge_type === "calls");
    expect(call).toMatchObject({
      target_name: "local",
      target_symbol_id: symbolId(db, "src/same.ts", "local"),
    });
  });

  it("resolves a uniquely-named exported symbol via the repo-wide fallback (tsx caller)", () => {
    repo.write("src/global-util.ts", `export function uniqueHelper(): number { return 1 }\n`);
    // No import: the tsx component uses the name directly (PRD §8 coverage).
    repo.write(
      "src/widget.tsx",
      `export function Widget() {\n  return <span>{uniqueHelper()}</span>;\n}\n`,
    );
    runPipeline(db, repo.root, graphHooks);

    const call = edgesFrom(db, "src/widget.tsx").find((e) => e.edge_type === "calls");
    expect(call).toMatchObject({
      target_name: "uniqueHelper",
      target_symbol_id: symbolId(db, "src/global-util.ts", "uniqueHelper"),
    });
  });

  it("leaves an ambiguous method name unresolved (two classes with save())", () => {
    repo.write(
      "src/stores.ts",
      `export class FileStore {\n  save(): void {}\n}\nexport class MemStore {\n  save(): void {}\n}\nexport function persist(store: FileStore) {\n  store.save();\n}\n`,
    );
    runPipeline(db, repo.root, graphHooks);

    const call = edgesFrom(db, "src/stores.ts").find(
      (e) => e.edge_type === "calls" && e.target_name === "save",
    );
    expect(call).toMatchObject({ target_symbol_id: null });
  });

  it("leaves external imports unresolved with target_module populated, and does not guess", () => {
    // A repo-local exported symbol named like the react import must NOT
    // attract the edge via the unique-name fallback — external is terminal.
    repo.write("src/fake-react.ts", `export function useState(): void {}\n`);
    repo.write(
      "src/comp2.tsx",
      `import { useState } from 'react';\nexport function Comp() {\n  const [n] = useState();\n  return <i>{n}</i>;\n}\n`,
    );
    runPipeline(db, repo.root, graphHooks);

    const edges = edgesFrom(db, "src/comp2.tsx");
    expect(edges.find((e) => e.edge_type === "imports")).toMatchObject({
      target_name: "useState",
      target_module: "react",
      target_symbol_id: null,
    });
    expect(edges.find((e) => e.edge_type === "calls" && e.target_name === "useState")).toMatchObject({
      target_symbol_id: null,
    });
  });

  it("resolves exports edges to the file's own symbols", () => {
    runPipeline(db, repo.root, graphHooks);

    // Fixture base: math.js CJS-exports add/multiply; greet.ts exports both.
    const mathExports = edgesFrom(db, "src/math.js").filter((e) => e.edge_type === "exports");
    expect(mathExports.map((e) => [e.target_name, e.target_symbol_id])).toEqual([
      ["add", symbolId(db, "src/math.js", "add")],
      ["multiply", symbolId(db, "src/math.js", "multiply")],
    ]);
  });

  it("base fixture ends fully resolved (no dangling NULLs to skew stats)", () => {
    runPipeline(db, repo.root, graphHooks);
    const unresolved = (
      db.prepare("SELECT COUNT(*) AS n FROM edges WHERE target_symbol_id IS NULL").get() as { n: number }
    ).n;
    expect(unresolved).toBe(0);
  });
});
