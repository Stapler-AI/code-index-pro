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

describe("documented limitations hold as designed (FR-306)", () => {
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

  it("dynamic import(variable) and require(variable) produce no misleading resolved edge", () => {
    // A repo-local exported symbol spelled like the dynamic target must not
    // be linked — the construct is invisible to name-only resolution.
    repo.write("src/plugin.ts", `export function plugin(): void {}\n`);
    repo.write(
      "src/loader.ts",
      `const which = './plugin';
export async function load() {
  const mod = await import(which);
  const legacy = require(which);
  return { mod, legacy };
}
`,
    );
    runPipeline(db, repo.root, graphHooks);

    const edges = edgesFrom(db, "src/loader.ts");
    // No imports edge at all — import(variable) is not an import_statement.
    expect(edges.filter((e) => e.edge_type === "imports")).toEqual([]);
    // Nothing resolves to the plugin symbol.
    const pluginId = symbolId(db, "src/plugin.ts", "plugin");
    expect(edges.some((e) => e.target_symbol_id === pluginId)).toBe(false);
    // require(variable) surfaces only as an unresolved call hint.
    expect(edges.find((e) => e.target_name === "require")).toMatchObject({
      edge_type: "calls",
      target_symbol_id: null,
    });
  });

  it("computed calls (obj[m]()) are invisible — no edge, resolved or not", () => {
    repo.write("src/registry.ts", `export function handler(): void {}\n`);
    repo.write(
      "src/dispatch.ts",
      `import * as registry from './registry';
export function dispatch(name: string) {
  return (registry as any)[name]();
}
`,
    );
    runPipeline(db, repo.root, graphHooks);

    const edges = edgesFrom(db, "src/dispatch.ts");
    // Positive control: the file genuinely indexed (its import edge exists),
    // so the absent call edge is limitation behavior, not a parse failure.
    expect(edges.find((e) => e.edge_type === "imports")).toMatchObject({ target_module: "./registry" });
    const calls = edges.filter((e) => e.edge_type === "calls");
    expect(calls.some((e) => e.target_name === "handler")).toBe(false);
    const handlerId = symbolId(db, "src/registry.ts", "handler");
    expect(edges.some((e) => e.target_symbol_id === handlerId)).toBe(false);
  });

  it("an aliased import resolves one level (tsx consumer)", () => {
    repo.write("src/impl.ts", `export function realName(): number { return 1 }\n`);
    repo.write(
      "src/view.tsx",
      `import { realName as aliased } from './impl';
export function View() {
  return <p>{aliased()}</p>;
}
`,
    );
    runPipeline(db, repo.root, graphHooks);

    const edges = edgesFrom(db, "src/view.tsx");
    // Level one: the imports edge links to the remote declaration.
    expect(edges.find((e) => e.edge_type === "imports")).toMatchObject({
      target_name: "realName",
      target_module: "./impl",
      target_symbol_id: symbolId(db, "src/impl.ts", "realName"),
    });
    // Level two (the aliased call site) is NOT followed: the call stays a
    // visible hint under the local name.
    expect(edges.find((e) => e.edge_type === "calls" && e.target_name === "aliased")).toMatchObject({
      target_symbol_id: null,
    });
  });

  it("re-exports are followed one level, not chained", () => {
    repo.write("src/deep.ts", `export function deepFn(): void {}\n`);
    repo.write("src/barrel.ts", `export { deepFn } from './deep';\n`);
    repo.write("src/user.ts", `import { deepFn } from './barrel';\nexport const go = () => deepFn();\n`);
    runPipeline(db, repo.root, graphHooks);

    // Level one: the barrel's re-export edge resolves into deep.ts.
    expect(edgesFrom(db, "src/barrel.ts").find((e) => e.edge_type === "exports")).toMatchObject({
      target_name: "deepFn",
      target_module: "./deep",
      target_symbol_id: symbolId(db, "src/deep.ts", "deepFn"),
    });
    // The chain through the barrel is not followed: barrel.ts declares no
    // symbol named deepFn, so the user's import stays an unresolved hint
    // with its provenance intact.
    expect(edgesFrom(db, "src/user.ts").find((e) => e.edge_type === "imports")).toMatchObject({
      target_name: "deepFn",
      target_module: "./barrel",
      target_symbol_id: null,
    });
  });

  it("ambiguous names remain present-but-unresolved — visible, not dropped", () => {
    repo.write(
      "src/stores.ts",
      `export class FileStore {
  flush(): void {}
}
export class MemStore {
  flush(): void {}
}
export function sync(store: FileStore) {
  store.flush();
}
`,
    );
    runPipeline(db, repo.root, graphHooks);

    // Positive control: the ambiguity is real — two flush method symbols.
    const flushSymbols = db
      .prepare("SELECT COUNT(*) AS n FROM symbols WHERE name = 'flush' AND kind = 'method'")
      .get() as { n: number };
    expect(flushSymbols.n).toBe(2);

    const flushCalls = edgesFrom(db, "src/stores.ts").filter(
      (e) => e.edge_type === "calls" && e.target_name === "flush",
    );
    // The edge row exists (a hint for caller lists) with the name populated.
    expect(flushCalls).toHaveLength(1);
    expect(flushCalls[0]).toMatchObject({ target_name: "flush", target_symbol_id: null });
  });

  it("repo-local by design: node_modules edges stay unresolved with the package identified", () => {
    runPipeline(db, repo.root, graphHooks);
    // Base fixture component.tsx imports greet locally; add a react consumer.
    repo.write(
      "src/hooked.tsx",
      `import { useEffect } from 'react';
export function Hooked() {
  useEffect(() => {});
  return <s />;
}
`,
    );
    runPipeline(db, repo.root, graphHooks);

    expect(edgesFrom(db, "src/hooked.tsx").find((e) => e.edge_type === "imports")).toMatchObject({
      target_name: "useEffect",
      target_module: "react",
      target_symbol_id: null,
    });
  });
});
