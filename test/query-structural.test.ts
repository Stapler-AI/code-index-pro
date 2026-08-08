import type { Database } from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { searchStructural, StructuralSearchError } from "../src/query/structural";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

/**
 * QA-501: requires the ast-grep binary in the test environment (it is a
 * runtime prerequisite for this one feature — DEV-503 covers its absence).
 */

const ASYNC_NO_TRY_RULE = `id: async-no-trycatch
language: typescript
rule:
  all:
    - kind: function_declaration
    - has: { pattern: "await $EXPR", stopBy: end }
    - not:
        has: { pattern: "try { $$$A } catch ($E) { $$$B }", stopBy: end }
`;

describe("structural search (FR-501)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeAll(() => {
    repo = buildFixtureRepo({ git: false });
    repo.write(
      "src/net.ts",
      `export async function fetchData(url: string) {
  const res = await fetch(url);
  return res.json();
}

export async function fetchSafe(url: string) {
  try {
    return await fetch(url);
  } catch (e) {
    return null;
  }
}
`,
    );
    repo.write("src/log.tsx", `export function Log() {\n  console.log("render", 1);\n  return <s />;\n}\n`);
    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
  });
  afterAll(() => {
    db.close();
    repo.cleanup();
  });

  it("a --pattern query returns normalized envelope results (no id)", () => {
    const { results, truncated } = searchStructural(repo.root, {
      pattern: "console.log($$$ARGS)",
      lang: "tsx",
    });
    expect(truncated).toBe(false);
    expect(results).toEqual([
      {
        path: "src/log.tsx",
        lines: [2, 2],
        preview: 'console.log("render", 1)',
      },
    ]);
    expect("id" in results[0]).toBe(false);
  });

  it("an --inline-rules query answers a contextual shape question", () => {
    const { results } = searchStructural(repo.root, { rule: ASYNC_NO_TRY_RULE });
    // fetchData awaits without try/catch; fetchSafe is guarded.
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("src/net.ts");
    expect(results[0].lines).toEqual([1, 4]);
    expect(results[0].preview).toContain("fetchData");
  });

  it("freshness drill: an edit after the last index run is found live, invisible to FTS", () => {
    // Indexed already in beforeAll; now edit WITHOUT reindexing.
    repo.write(
      "src/fresh.ts",
      `export function brandNewThing(): void {
  console.warn("freshEditMarker");
}
`,
    );

    const live = searchStructural(repo.root, { pattern: "console.warn($MSG)", lang: "typescript" });
    expect(live.results).toEqual([
      { path: "src/fresh.ts", lines: [2, 2], preview: 'console.warn("freshEditMarker")' },
    ]);

    // The index has not absorbed the edit: FTS finds nothing.
    const stale = db
      .prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'freshEditMarker'")
      .get() as { n: number };
    expect(stale.n).toBe(0);
  });

  it("zero matches is an empty result, not an error (grep-style exit 1)", () => {
    const { results, truncated } = searchStructural(repo.root, {
      pattern: "neverEverCalled($X)",
      lang: "typescript",
    });
    expect(results).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("limit caps matches with truncated: true", () => {
    // Two console.* fixtures exist? Only one console.log — use await matches.
    const { results, truncated } = searchStructural(repo.root, {
      pattern: "await $EXPR",
      lang: "typescript",
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(truncated).toBe(true); // fetchData + fetchSafe both await
  });

  it("input validation: exactly one of pattern/rule; lang required with pattern", () => {
    expect(() => searchStructural(repo.root, {})).toThrow(StructuralSearchError);
    expect(() =>
      searchStructural(repo.root, { pattern: "x", rule: "id: y" }),
    ).toThrow(/exactly one/);
    expect(() => searchStructural(repo.root, { pattern: "x" })).toThrow(/lang is required/);
  });

  it("a genuinely invalid invocation surfaces as a structural error", () => {
    expect(() =>
      searchStructural(repo.root, { pattern: "x", lang: "not-a-language" }),
    ).toThrow(StructuralSearchError);
  });
});
