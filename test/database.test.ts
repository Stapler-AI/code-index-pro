import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, indexDbPath } from "../src/storage/database";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

describe("database location & lifecycle (FR-101)", () => {
  let repo: FixtureRepo;
  afterEach(() => repo?.cleanup());

  it("opening a fixture repo creates .code-index/index.db", () => {
    repo = buildFixtureRepo({ git: false });
    expect(existsSync(indexDbPath(repo.root))).toBe(false);

    const db = openDatabase(repo.root);
    expect(existsSync(indexDbPath(repo.root))).toBe(true);
    db.close();
  });

  it("applies the three spec'd pragmas on open", () => {
    repo = buildFixtureRepo({ git: false });
    const db = openDatabase(repo.root);

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    // synchronous: 1 = NORMAL
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    db.close();
  });

  it("reopening an existing database succeeds without recreating it", () => {
    repo = buildFixtureRepo({ git: false });

    const first = openDatabase(repo.root);
    first.exec("CREATE TABLE marker (x INTEGER)");
    first.prepare("INSERT INTO marker (x) VALUES (1)").run();
    first.close();

    const second = openDatabase(repo.root);
    const row = second.prepare("SELECT x FROM marker").get() as { x: number };
    expect(row.x).toBe(1);
    second.close();
  });
});
