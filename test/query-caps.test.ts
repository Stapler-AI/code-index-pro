import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { findSymbol, impactOfChange, moduleMap, whoCalls } from "../src/query/graph";
import { searchCode, SEARCH_CODE_DEFAULT_LIMIT } from "../src/query/search";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

describe("caps & truncation (FR-404)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    // 25 functions all mentioning "capme": beyond search_code's default 20.
    const many = Array.from(
      { length: 25 },
      (_, i) => `function fn${i}(): void {\n  // capme marker ${i}\n}\n`,
    ).join("");
    repo.write("src/many.ts", many);
    // Call chain e -> d -> c -> b -> a: fnE sits at distance 4 so the
    // default max_depth of 3 demonstrably excludes something.
    repo.write(
      "src/chain.ts",
      `export function fnA(): void {}
export function fnB(): void { fnA() }
export function fnC(): void { fnB() }
export function fnD(): void { fnC() }
export function fnE(): void { fnD() }
`,
    );
    // Three same-named exports across files for small-limit cuts.
    repo.write("src/s1.ts", `export function shared(): void {}\n`);
    repo.write("src/s2.ts", `export function shared(): void {}\n`);
    repo.write("src/s3.ts", `export function shared(): void {}\n`);
    // Two import rows so module_map has something to truncate (the base
    // fixture's component.tsx -> greet.ts is the third).
    repo.write("src/importer.ts", `import { fnA } from './chain';\nimport { useState } from 'react';\nexport const wired = [fnA, useState];\n`);
    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
  });
  afterEach(() => {
    db.close();
    repo.cleanup();
  });

  it("search_code cuts at the default limit and says so", () => {
    const { results, truncated } = searchCode(db, "capme");
    expect(results).toHaveLength(SEARCH_CODE_DEFAULT_LIMIT);
    expect(truncated).toBe(true);
  });

  it("under-limit results report no truncation", () => {
    const search = searchCode(db, "capme", { limit: 30 });
    expect(search.results).toHaveLength(25);
    expect(search.truncated).toBe(false);

    const lookup = findSymbol(db, "shared");
    expect(lookup.results).toHaveLength(3);
    expect(lookup.truncated).toBe(false);
  });

  it("an exact-limit result is not marked truncated", () => {
    const { results, truncated } = searchCode(db, "capme", { limit: 25 });
    expect(results).toHaveLength(25);
    expect(truncated).toBe(false);
  });

  it("explicit limits cut graph queries with truncated: true", () => {
    const lookup = findSymbol(db, "shared", { limit: 2 });
    expect(lookup.results).toHaveLength(2);
    expect(lookup.truncated).toBe(true);

    const map = moduleMap(db, { limit: 1 });
    expect(map.results).toHaveLength(1);
    expect(map.truncated).toBe(true);
  });

  it("max_depth bounds the impact closure (default 3, tighter cut reported)", () => {
    const fnAId = findSymbol(db, "fnA").results[0].id;

    // fnE (distance 4) is excluded by the default depth of 3.
    const full = impactOfChange(db, fnAId);
    expect(full.results.map((r) => [r.name, r.distance])).toEqual([
      ["fnB", 1],
      ["fnC", 2],
      ["fnD", 3],
    ]);
    expect(full.truncated).toBe(false);

    const shallow = impactOfChange(db, fnAId, { maxDepth: 2 });
    expect(shallow.results.map((r) => r.name)).toEqual(["fnB", "fnC"]);

    // A row limit inside a deep closure reports truncation.
    const limited = impactOfChange(db, fnAId, { limit: 1 });
    expect(limited.results.map((r) => r.name)).toEqual(["fnB"]);
    expect(limited.truncated).toBe(true);
  });

  it("who_calls respects limit with truncation reported", () => {
    const fnAId = findSymbol(db, "fnA").results[0].id;
    const callers = whoCalls(db, fnAId, "fnA", { limit: 0 });
    expect(callers.results).toEqual([]);
    expect(callers.truncated).toBe(true); // fnB exists beyond the cut
  });
});
