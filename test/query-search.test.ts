import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { searchCode as searchCodeCapped, SearchCodeOptions } from "../src/query/search";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

describe("search_code / FTS5 (FR-401)", () => {
  let repo: FixtureRepo;
  let db: Database;
  // Row-content assertions live here; truncation reporting is QA-404's.
  const searchCode = (database: Database, query: string, options?: SearchCodeOptions) =>
    searchCodeCapped(database, query, options).results;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    // Plain (unexported) functions so each body is exactly one chunk.
    // mentionOnce comes FIRST so the denser match (recoverCache) gets the
    // higher chunk id — the bm25-ordering test must not be satisfiable by
    // the ORDER BY's id tiebreak alone.
    repo.write(
      "src/cache.ts",
      `function mentionOnce(): number {
  // the cache appears here a single time
  return 1;
}
function recoverCache(): string {
  // cache corruption detected: quarantine the cache, rebuild the cache
  return 'cache cache';
}
`,
    );
    repo.write(
      "src/write.ts",
      `function writeStuff(): void {
  // we replace chunks atomically on every write
}
function reversed(): void {
  // chunks whose rows we never replace stay put
}
function parserHelper(): void {
  // parsing happens before persisting
}
`,
    );
    repo.write(
      "src/detect.ts",
      `function nearCase(): void {
  // the hash mismatch will detect stale content quickly
}
function farCase(): void {
  // hash one two three four five six seven eight nine ten eleven twelve thirteen fourteen detect
}
`,
    );
    repo.write(
      "lib/outside.ts",
      `function outsider(): void {
  // corruption lives outside the src tree too
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

  it("term query: both terms, any order", () => {
    const hits = searchCode(db, "chunks replace");
    const names = hits.map((h) => h.nodeName);
    expect(names).toContain("writeStuff");
    expect(names).toContain("reversed"); // order-free term match
  });

  it("phrase query matches only adjacent words in order", () => {
    const hits = searchCode(db, '"replace chunks"');
    expect(hits.map((h) => h.nodeName)).toEqual(["writeStuff"]);
  });

  it("prefix query", () => {
    const hits = searchCode(db, "pars*");
    expect(hits.map((h) => h.nodeName)).toEqual(["parserHelper"]);
  });

  it("NEAR proximity: within the window matches, beyond it does not", () => {
    const names = searchCode(db, "NEAR(hash detect, 10)").map((h) => h.nodeName);
    expect(names).toContain("nearCase");
    expect(names).not.toContain("farCase");
    // Sanity: a wider window catches both.
    expect(searchCode(db, "NEAR(hash detect, 20)").map((h) => h.nodeName)).toEqual(
      expect.arrayContaining(["nearCase", "farCase"]),
    );
  });

  it("column filters distinguish node_name from content", () => {
    // "corruption" exists only in body text.
    expect(searchCode(db, "content: corruption").length).toBeGreaterThan(0);
    expect(searchCode(db, "node_name: corruption")).toEqual([]);
    // Function names live in the node_name column.
    expect(searchCode(db, "node_name: nearCase").map((h) => h.nodeName)).toEqual(["nearCase"]);
  });

  it("bm25 ranks the denser match first", () => {
    const hits = searchCode(db, "cache");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].nodeName).toBe("recoverCache"); // many mentions beat one
    expect(hits.map((h) => h.nodeName)).toContain("mentionOnce");
  });

  it("snippet excerpts mark the match", () => {
    const [hit] = searchCode(db, "corruption", { pathPrefix: "src/" });
    expect(hit.excerpt).toContain("[corruption]");
  });

  it("hits carry the documented shape", () => {
    const [hit] = searchCode(db, '"replace chunks"');
    expect(hit).toMatchObject({
      path: "src/write.ts",
      nodeType: "function_declaration",
      nodeName: "writeStuff",
      contextPath: "function_declaration",
    });
    expect(hit.chunkId).toBeGreaterThan(0);
    expect(hit.startLine).toBe(1);
    expect(hit.endLine).toBe(3);
  });

  it("path_prefix restricts hits to the subtree", () => {
    const all = searchCode(db, "corruption");
    expect(all.map((h) => h.path)).toEqual(expect.arrayContaining(["src/cache.ts", "lib/outside.ts"]));

    const srcOnly = searchCode(db, "corruption", { pathPrefix: "src/" });
    expect(srcOnly.map((h) => h.path)).toEqual(["src/cache.ts"]);
  });

  it("limit caps the hit count", () => {
    const capped = searchCode(db, "cache", { limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0].nodeName).toBe("recoverCache"); // still best-ranked first
  });

  it("an invalid FTS query throws (caller surfaces it as a bad request)", () => {
    expect(() => searchCode(db, 'AND "')).toThrow();
  });
});
