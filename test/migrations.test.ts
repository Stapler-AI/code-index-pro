import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database";
import {
  CURRENT_USER_VERSION,
  ForeignDatabaseError,
  isForeignDatabase,
  runMigrations,
  userVersion,
} from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const REQUIRED_TABLES = ["indexed_files", "code_chunks", "symbols", "edges", "chunks_fts", "meta"];

function tableNames(db: Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("migration runner (FR-106)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    db = openDatabase(repo.root);
  });
  afterEach(() => {
    db.close();
    repo.cleanup();
  });

  it("migrates a fresh database from 0 to the current version", () => {
    expect(userVersion(db)).toBe(0);
    runMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_USER_VERSION);
    const names = tableNames(db);
    for (const table of REQUIRED_TABLES) {
      expect(names, table).toContain(table);
    }
  });

  it("reopening an up-to-date database is a no-op (no DDL re-runs)", () => {
    runMigrations(db);
    db.close();

    // A re-run of migration 1's CREATE TABLE statements would throw
    // "table ... already exists" — completing silently proves the no-op —
    // and the schema catalog must come out byte-identical.
    db = openDatabase(repo.root);
    const before = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    expect(() => runMigrations(db)).not.toThrow();
    const after = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    expect(after).toEqual(before);
    expect(userVersion(db)).toBe(CURRENT_USER_VERSION);
  });

  it("reports a database with user_version = current+1 as foreign", () => {
    runMigrations(db);
    db.pragma(`user_version = ${CURRENT_USER_VERSION + 1}`);
    db.close();

    db = openDatabase(repo.root);
    expect(isForeignDatabase(db)).toBe(true);
    expect(() => runMigrations(db)).toThrow(ForeignDatabaseError);
    try {
      runMigrations(db);
    } catch (err) {
      expect((err as ForeignDatabaseError).foundVersion).toBe(CURRENT_USER_VERSION + 1);
    }
  });

  it("does not treat an up-to-date or fresh database as foreign", () => {
    expect(isForeignDatabase(db)).toBe(false);
    runMigrations(db);
    expect(isForeignDatabase(db)).toBe(false);
  });
});
