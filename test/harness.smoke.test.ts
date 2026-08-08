import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { countRows, indexDbExists, indexDbPath, openIndexDb, totalChanges } from "./helpers/db";
import { BASE_FILES, buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

describe("shared test harness (QA-000)", () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
  });

  function build(git: boolean): FixtureRepo {
    const repo = buildFixtureRepo({ git });
    repos.push(repo);
    return repo;
  }

  describe.each([{ variant: "git", git: true }, { variant: "non-git", git: false }])(
    "$variant fixture variant",
    ({ git }) => {
      it("contains the base file layout", () => {
        const repo = build(git);
        for (const relPath of Object.keys(BASE_FILES)) {
          expect(existsSync(join(repo.root, relPath)), relPath).toBe(true);
        }
        expect(existsSync(join(repo.root, ".git"))).toBe(git);
      });

      it("supports write / edit / delete mid-test", () => {
        const repo = build(git);
        repo.write("src/extra.ts", "export const extra = 1;\n");
        expect(repo.read("src/extra.ts")).toContain("extra = 1");

        repo.edit("src/extra.ts", (c) => c.replace("1", "2"));
        expect(repo.read("src/extra.ts")).toContain("extra = 2");

        repo.remove("src/extra.ts");
        expect(existsSync(join(repo.root, "src/extra.ts"))).toBe(false);
      });
    },
  );

  it("base layout covers all three v1 languages", () => {
    const files = Object.keys(BASE_FILES);
    expect(files.some((f) => f.endsWith(".js"))).toBe(true);
    expect(files.some((f) => f.endsWith(".ts") && !f.endsWith(".tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith(".tsx"))).toBe(true);
  });

  it("db helpers open .code-index/index.db, count rows, and count writes", () => {
    const repo = build(false);
    expect(indexDbExists(repo.root)).toBe(false);
    expect(() => openIndexDb(repo.root)).toThrow();

    // Simulate what the indexer will do once DEV-101 lands.
    mkdirSync(join(repo.root, ".code-index"), { recursive: true });
    const created = new Database(indexDbPath(repo.root));
    created.exec("CREATE TABLE t (x INTEGER)");
    created.prepare("INSERT INTO t (x) VALUES (?)").run(42);
    created.close();

    expect(indexDbExists(repo.root)).toBe(true);
    const db = openIndexDb(repo.root);
    expect(countRows(db, "t")).toBe(1);

    const before = totalChanges(db);
    db.prepare("INSERT INTO t (x) VALUES (?)").run(7);
    expect(totalChanges(db) - before).toBe(1);
    db.close();
  });
});
