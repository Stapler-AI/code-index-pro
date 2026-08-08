import type { Database } from "better-sqlite3";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database";
import { checkMeta, populateMeta, SCHEMA_VERSION, toolVersion } from "../src/storage/meta";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

describe("meta table (FR-105)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    db = openDatabase(repo.root);
    runMigrations(db);
    populateMeta(db, repo.root);
  });
  afterEach(() => {
    db.close();
    repo.cleanup();
  });

  it("a fresh database contains the three rows with correct values", () => {
    const rows = db.prepare("SELECT key, value FROM meta ORDER BY key").all() as {
      key: string;
      value: string;
    }[];
    expect(rows).toEqual([
      { key: "repo_root", value: resolve(repo.root) },
      { key: "schema_version", value: SCHEMA_VERSION },
      { key: "tool_version", value: toolVersion() },
    ]);
    expect(toolVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("a matching database reports no mismatches", () => {
    expect(checkMeta(db, repo.root)).toEqual([]);
  });

  it("flags a copied database (repo_root differs)", () => {
    const otherRepo = buildFixtureRepo({ git: false });
    try {
      // Simulate a copy: check this database against a different repo root.
      const mismatches = checkMeta(db, otherRepo.root);
      expect(mismatches).toEqual([
        {
          key: "repo_root",
          expected: resolve(otherRepo.root),
          actual: resolve(repo.root),
        },
      ]);
    } finally {
      otherRepo.cleanup();
    }
  });

  it("flags a schema_version mismatch", () => {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run("999");
    const mismatches = checkMeta(db, repo.root);
    expect(mismatches).toEqual([
      { key: "schema_version", expected: SCHEMA_VERSION, actual: "999" },
    ]);
  });

  it("flags missing meta rows as mismatches (actual: null)", () => {
    db.prepare("DELETE FROM meta WHERE key = 'schema_version'").run();
    const mismatches = checkMeta(db, repo.root);
    expect(mismatches).toEqual([
      { key: "schema_version", expected: SCHEMA_VERSION, actual: null },
    ]);
  });
});
