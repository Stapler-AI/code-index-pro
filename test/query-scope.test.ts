import type { Database } from "better-sqlite3";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { resetAstGrepVersionCheck, searchStructural, structuralCandidates } from "../src/query/structural";
import type { ServerContext } from "../src/server/server";
import { TOOL_CATALOG } from "../src/server/tools";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const searchStructuralTool = TOOL_CATALOG.find((t) => t.name === "search_structural")!;

describe("structural scope control (FR-502)", () => {
  let repo: FixtureRepo;
  let db: Database;
  let ctx: ServerContext;

  beforeAll(() => {
    repo = buildFixtureRepo({ git: false });
    repo.write("src/inside.ts", `export function inside(): void {\n  console.log("in");\n}\n`);
    repo.write("lib/outside.ts", `export function outside(): void {\n  console.log("out");\n}\n`);
    repo.write(
      "src/keyword.ts",
      `export function withKeyword(): void {\n  // scopetoken lives here\n  console.log("kw");\n}\n`,
    );
    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
    ctx = { db, repoRoot: repo.root, recovered: false };
  });
  afterAll(() => {
    db.close();
    repo.cleanup();
  });

  it("paths restricts matches to the given subtree", () => {
    const everywhere = searchStructural(repo.root, { pattern: "console.log($A)", lang: "typescript" });
    expect(everywhere.results.map((r) => r.path).sort()).toEqual([
      "lib/outside.ts",
      "src/inside.ts",
      "src/keyword.ts",
    ]);

    const scoped = searchStructural(repo.root, {
      pattern: "console.log($A)",
      lang: "typescript",
      paths: ["src"],
    });
    expect(scoped.results.map((r) => r.path).sort()).toEqual(["src/inside.ts", "src/keyword.ts"]);
  });

  it("structuralCandidates narrows by language and FTS keyword", () => {
    expect(structuralCandidates(db, { language: "tsx" })).toEqual(["src/component.tsx"]);
    expect(structuralCandidates(db, { ftsQuery: "scopetoken" })).toEqual(["src/keyword.ts"]);
    expect(structuralCandidates(db, { language: "typescript", ftsQuery: "scopetoken" })).toEqual([
      "src/keyword.ts",
    ]);
    expect(structuralCandidates(db, { language: "javascript", ftsQuery: "scopetoken" })).toEqual([]);
  });

  describe("with a recording fake ast-grep on PATH", () => {
    let fakeBinDir: string;
    let recordFile: string;
    let originalPath: string;

    beforeAll(() => {
      fakeBinDir = mkdtempSync(join(tmpdir(), "fake-ast-grep-"));
      recordFile = join(fakeBinDir, "argv.txt");
      writeFileSync(
        join(fakeBinDir, "ast-grep"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "ast-grep 0.99.0"; exit 0; fi
printf '%s\\n' "$@" > "${recordFile}"
echo "[]"
exit 0
`,
      );
      chmodSync(join(fakeBinDir, "ast-grep"), 0o755);
      originalPath = process.env.PATH!;
      process.env.PATH = `${fakeBinDir}:${originalPath}`;
      resetAstGrepVersionCheck(); // force re-probe against the fake
    });
    afterAll(() => {
      process.env.PATH = originalPath;
      resetAstGrepVersionCheck(); // next caller re-probes the real binary
      rmSync(fakeBinDir, { recursive: true, force: true });
    });

    it("prefilter_fts: the invocation receives exactly the candidate file list", () => {
      const payload = searchStructuralTool.handler(
        { pattern: "console.log($A)", lang: "typescript", prefilter_fts: "scopetoken" },
        ctx,
      ) as { results: unknown[] };
      expect(payload.results).toEqual([]);

      const argv = readFileSync(recordFile, "utf8").trim().split("\n");
      expect(argv).toEqual([
        "run",
        "--pattern",
        "console.log($A)",
        "--lang",
        "typescript",
        "--json",
        "src/keyword.ts", // the sole candidate — not "."
      ]);
    });

    it("prefilter_language: candidates are the language's indexed files", () => {
      searchStructuralTool.handler(
        { pattern: "console.log($A)", lang: "tsx", prefilter_language: true },
        ctx,
      );
      const argv = readFileSync(recordFile, "utf8").trim().split("\n");
      expect(argv).toEqual([
        "run",
        "--pattern",
        "console.log($A)",
        "--lang",
        "tsx",
        "--json",
        "src/component.tsx", // the language's only indexed file
      ]);
    });

    it("empty candidate set returns empty without invoking ast-grep", () => {
      rmSync(recordFile, { force: true });
      const payload = searchStructuralTool.handler(
        { pattern: "x()", lang: "typescript", prefilter_fts: "tokenThatMatchesNothing" },
        ctx,
      ) as { results: unknown[]; truncated: boolean };
      expect(payload).toEqual({ results: [], truncated: false });
      expect(() => readFileSync(recordFile, "utf8")).toThrow(); // never spawned
    });
  });

  it("prefilter arg validation: mutual exclusion and lang requirement", () => {
    expect(() =>
      searchStructuralTool.handler(
        { pattern: "x()", lang: "typescript", paths: ["src"], prefilter_fts: "y" },
        ctx,
      ),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      searchStructuralTool.handler({ rule: "id: r", prefilter_language: true }, ctx),
    ).toThrow(/requires lang/);
  });
});
