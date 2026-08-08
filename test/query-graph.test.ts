import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import {
  classHierarchy,
  deadExports,
  fileOutline,
  findSymbol,
  getDependencies,
  impactOfChange,
  moduleMap,
  whoCalls,
} from "../src/query/graph";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

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

describe("seven graph queries (FR-402)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    // Hierarchy: Contract (interface), Base, Mid extends Base implements
    // Contract, Leaf (tsx) extends Mid — PRD §8 tsx participant.
    repo.write(
      "src/hier.ts",
      `export interface Contract {
  go(): void;
}
export class Base {}
export class Mid extends Base implements Contract {
  go(): void {}
}
`,
    );
    repo.write(
      "src/leaf.tsx",
      `import { Mid } from './hier';
export class Leaf extends Mid {
  render() {
    return <b />;
  }
}
`,
    );
    // Call cycle: f1 -> f2 -> f3 -> f1.
    repo.write(
      "src/cycle.ts",
      `export function f1(): void { f2() }
export function f2(): void { f3() }
export function f3(): void { f1() }
`,
    );
    // who-calls: one resolved caller; one ambiguous (duplicate export) whose
    // edge stays NULL but must still surface as a flagged hint.
    repo.write("src/who.ts", `export function targetFn(): void {}\nexport function caller1() { targetFn() }\n`);
    repo.write("src/dup.ts", `export function targetFn(): void {}\n`);
    repo.write("src/user2.ts", `export function caller2() { targetFn() }\n`);
    // Dead export: exported, never referenced anywhere.
    repo.write("src/dead.ts", `export function neverUsed(): void {}\n`);
    // Module map externals + unresolved outbound calls.
    repo.write(
      "src/ext.ts",
      `import { useState } from 'react';
import { useEffect } from 'react';
export function useHooks(): void {
  useState();
  useEffect();
}
`,
    );
    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
  });
  afterEach(() => {
    db.close();
    repo.cleanup();
  });

  it("who_calls returns resolved callers and flags unresolved name-matches", () => {
    const rows = whoCalls(db, symbolId(db, "src/who.ts", "targetFn"), "targetFn");
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("caller1")).toMatchObject({ path: "src/who.ts", resolved: true });
    // caller2's edge is NULL (two exported targetFn) — included but flagged.
    expect(byName.get("caller2")).toMatchObject({ path: "src/user2.ts", resolved: false });
  });

  it("get_dependencies lists outbound edges with resolved targets when available", () => {
    const rows = getDependencies(db, symbolId(db, "src/cycle.ts", "f1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      edgeType: "calls",
      targetName: "f2",
      target: { path: "src/cycle.ts", kind: "function" },
    });

    // External calls stay unresolved: name kept, target null.
    const external = getDependencies(db, symbolId(db, "src/ext.ts", "useHooks"));
    expect(external.map((r) => [r.targetName, r.target])).toEqual([
      ["useState", null],
      ["useEffect", null],
    ]);
  });

  it("impact_of_change terminates on a cycle with correct minimum distances", () => {
    const rows = impactOfChange(db, symbolId(db, "src/cycle.ts", "f1"));
    expect(rows.map((r) => [r.name, r.distance])).toEqual([
      ["f3", 1],
      ["f2", 2],
    ]);
  });

  it("impact closure includes subclass chains (extends/implements edges)", () => {
    const rows = impactOfChange(db, symbolId(db, "src/hier.ts", "Base"));
    expect(rows.map((r) => [r.name, r.distance])).toEqual([
      ["Mid", 1],
      ["Leaf", 2],
    ]);
  });

  it("max_depth bounds the impact closure", () => {
    const rows = impactOfChange(db, symbolId(db, "src/cycle.ts", "f1"), 1);
    expect(rows.map((r) => r.name)).toEqual(["f3"]);
  });

  it("class hierarchy walks both directions, depth-capped", () => {
    const ancestors = classHierarchy(db, symbolId(db, "src/leaf.tsx", "Leaf"), "ancestors");
    expect(new Set(ancestors.map((r) => r.name))).toEqual(new Set(["Mid", "Base", "Contract"]));

    const descendants = classHierarchy(db, symbolId(db, "src/hier.ts", "Base"), "descendants");
    expect(new Set(descendants.map((r) => r.name))).toEqual(new Set(["Mid", "Leaf"]));
  });

  it("dead_exports flags the never-used export only", () => {
    const dead = deadExports(db);
    const names = dead.map((r) => r.name);
    expect(names).toContain("neverUsed");
    // Both targetFn exports are shielded by caller2's unresolved name-match.
    expect(names).not.toContain("targetFn");
    // Resolved-inbound symbols are naturally excluded.
    expect(names).not.toContain("f1");
  });

  it("module_map aggregates imports, keeping node_modules via target_module", () => {
    const rows = moduleMap(db);
    expect(rows).toContainEqual({ fromFile: "src/ext.ts", toModule: "react", importCount: 2 });
    // Resolved local imports surface as the target file's path.
    expect(rows).toContainEqual({ fromFile: "src/leaf.tsx", toModule: "src/hier.ts", importCount: 1 });
    expect(rows).toContainEqual({ fromFile: "src/component.tsx", toModule: "src/greet.ts", importCount: 1 });
  });

  it("file_outline returns the ordered skeleton with exported flags", () => {
    // Interface method *signatures* are not declarations — only Mid's
    // concrete go() appears.
    const outline = fileOutline(db, "src/hier.ts");
    expect(outline.map((r) => [r.name, r.kind, r.exported])).toEqual([
      ["Contract", "interface", true],
      ["Base", "class", true],
      ["Mid", "class", true],
      ["go", "method", false],
    ]);
    expect(outline[0].startLine).toBe(1);
  });

  it("find_symbol answers 'where is X defined?'", () => {
    const rows = findSymbol(db, "Mid");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Mid", kind: "class", path: "src/hier.ts" });

    // Duplicates return every definition site.
    expect(findSymbol(db, "targetFn").map((r) => r.path)).toEqual(["src/dup.ts", "src/who.ts"]);
  });

  it("graph results never include chunk bodies", () => {
    for (const row of [
      ...whoCalls(db, symbolId(db, "src/who.ts", "targetFn"), "targetFn"),
      ...impactOfChange(db, symbolId(db, "src/cycle.ts", "f1")),
      ...deadExports(db),
      ...findSymbol(db, "Mid"),
    ]) {
      expect(row).not.toHaveProperty("content");
      expect(row).not.toHaveProperty("body");
    }
  });
});
