import type { Database } from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GENERATOR_VERSION,
  generateArchitectureTasks,
  generateImpactTasks,
  generateSymbolLookupTasks,
  generateTasks,
  generateWhoCallsTasks,
  grepCrossCheckCallers,
} from "../benchmarks/generate-tasks";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { validateTasks } from "../benchmarks/tasks";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

/**
 * QA-908: on the QA-000 fixture, generated tasks of each shape carry keys
 * that match direct SQL; the grep cross-check agrees on caller keys;
 * generated:<version> tags are present; generated entries pass DEV-901
 * registry validation.
 */

describe("index-driven task generator (DEV-908 / QA-908)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeAll(() => {
    repo = buildFixtureRepo({ git: true });
    // Give `greet` two call sites so it qualifies for who-calls (2+ callers).
    repo.write("src/a.ts", `import { greet } from './greet';\nexport const ga = () => greet('a');\n`);
    repo.write("src/b.ts", `import { greet } from './greet';\nexport const gb = () => greet('b');\n`);
    // Re-commit so git-based discovery sees the new files.
    execFileSync("git", ["add", "-A"], { cwd: repo.root, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "more callers"], { cwd: repo.root, stdio: "pipe" });
    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
  });
  afterAll(() => {
    db.close();
    repo.cleanup();
  });

  it("symbol-lookup keys match direct SQL for a repo-unique exported symbol", () => {
    const tasks = generateSymbolLookupTasks(db, "fixture-ts");
    const greetTask = tasks.find((t) => t.id === "gen-symlookup-fixture-ts-greet");
    expect(greetTask).toBeDefined();
    const truth = db
      .prepare(
        `SELECT f.relative_path AS path, s.start_line FROM symbols s
         JOIN indexed_files f ON f.id=s.file_id WHERE s.name='greet'`,
      )
      .get() as { path: string; start_line: number };
    expect(greetTask!.grader).toEqual({
      kind: "path-line-set",
      key: [`${truth.path}:${truth.start_line}`],
    });
    // Ambiguous names (e.g. duplicated) are excluded — every key is single.
    for (const t of tasks) expect((t.grader as { key: string[] }).key).toHaveLength(1);
  });

  it("who-calls keys match direct SQL and the grep cross-check agrees", () => {
    const tasks = generateWhoCallsTasks(db, "fixture-ts");
    const greetTask = tasks.find((t) => t.id === "gen-whocalls-fixture-ts-greet");
    expect(greetTask, "greet has 2+ callers so it must be generated").toBeDefined();

    const symbolId = (db.prepare("SELECT id FROM symbols WHERE name='greet'").get() as { id: number }).id;
    const truth = (
      db
        .prepare(
          `SELECT f.relative_path AS path, e.line FROM edges e JOIN indexed_files f ON f.id=e.source_file_id
           WHERE e.target_symbol_id=? AND e.edge_type IN ('calls','references') ORDER BY f.relative_path, e.line`,
        )
        .all(symbolId) as { path: string; line: number }[]
    ).map((r) => `${r.path}:${r.line}`);
    const key = (greetTask!.grader as { key: string[] }).key;
    expect(key).toEqual(truth);
    expect(key.length).toBeGreaterThanOrEqual(2);

    // Circularity mitigation: grep independently confirms every claimed call.
    const grepHits = new Set(grepCrossCheckCallers(repo.root, "greet"));
    for (const claimed of key) {
      expect(grepHits.has(claimed), `grep must confirm ${claimed}`).toBe(true);
    }
  });

  it("impact keys match the transitive closure computed by direct SQL", () => {
    const tasks = generateImpactTasks(db, "fixture-ts");
    const greetTask = tasks.find((t) => t.id === "gen-impact-fixture-ts-greet");
    expect(greetTask).toBeDefined();
    const symbolId = (db.prepare("SELECT id FROM symbols WHERE name='greet'").get() as { id: number }).id;
    const truth = (
      db
        .prepare(
          `WITH RECURSIVE impact(id) AS (
             SELECT ? UNION
             SELECT e.source_symbol_id FROM edges e JOIN impact ON e.target_symbol_id=impact.id
             WHERE e.source_symbol_id IS NOT NULL AND e.edge_type IN ('calls','references','extends','implements'))
           SELECT DISTINCT s.name FROM impact JOIN symbols s ON s.id=impact.id WHERE impact.id != ? ORDER BY s.name`,
        )
        .all(symbolId, symbolId) as { name: string }[]
    ).map((r) => r.name);
    expect((greetTask!.grader as { key: string[] }).key).toEqual(truth);
    expect(truth.length).toBeGreaterThan(0);
  });

  it("architecture keys list a file's import specifiers, matching SQL", () => {
    const tasks = generateArchitectureTasks(db, "fixture-ts");
    const compTask = tasks.find((t) => t.prompt.includes("src/component.tsx"));
    expect(compTask).toBeDefined();
    expect((compTask!.grader as { key: string[] }).key).toEqual(["./greet"]);
    // a.ts and b.ts each import greet.
    const aTask = tasks.find((t) => t.prompt.includes("src/a.ts"));
    expect((aTask!.grader as { key: string[] }).key).toEqual(["./greet"]);
  });

  it("every generated shape is present, tagged generated:<version>, and validates", () => {
    const tasks = generateTasks(db, "fixture-ts");
    const categories = new Set(tasks.map((t) => t.category));
    expect(categories).toContain("symbol-lookup");
    expect(categories).toContain("callers-impact");
    expect(categories).toContain("architecture");

    for (const t of tasks) {
      expect(t.tags).toContain(`generated:${GENERATOR_VERSION}`);
    }
    // Generated entries land in the same registry structure and pass DEV-901.
    expect(() => validateTasks(tasks)).not.toThrow();
    // Ids are unique across the whole generated set.
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
  });

  it("grepCrossCheckCallers returns [] for a name with no call sites", () => {
    expect(grepCrossCheckCallers(repo.root, "definitelyNotASymbolHere")).toEqual([]);
  });
});
