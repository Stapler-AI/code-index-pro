import type { Database } from "better-sqlite3";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexDbPath, openDatabase } from "../src/storage/database";
import {
  checkHealth,
  getRecoveryEvents,
  isReindexRequired,
  openHealthy,
} from "../src/storage/health";
import { CURRENT_USER_VERSION, runMigrations } from "../src/storage/migrations";
import { populateMeta } from "../src/storage/meta";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const QUARANTINE_ISO_RE = /index\.db\.quarantine-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("health check & quarantine-and-rebuild (FR-107)", () => {
  let repo: FixtureRepo;
  let db: Database | undefined;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
  });
  afterEach(() => {
    db?.close();
    db = undefined;
    repo.cleanup();
  });

  function quarantineFiles(): string[] {
    return readdirSync(dirname(indexDbPath(repo.root))).filter((f) => f.includes("quarantine"));
  }

  it("a fresh database passes the health check", () => {
    const result = openHealthy(repo.root);
    db = result.db;
    expect(result.recovered).toBe(false);
    expect(result.fullReindexRequired).toBe(false);
    expect(checkHealth(db, repo.root)).toEqual([]);
    expect(getRecoveryEvents(db)).toEqual([]);
    expect(isReindexRequired(db)).toBe(false);
  });

  it("quarantines a corrupted file (with sidecars) and rebuilds healthy", () => {
    // Create a real database, then trash it and plant sidecars.
    openHealthy(repo.root).db.close();
    const dbPath = indexDbPath(repo.root);
    writeFileSync(dbPath, "this is not a sqlite database, not even close");
    writeFileSync(`${dbPath}-wal`, "garbage wal");
    writeFileSync(`${dbPath}-shm`, "garbage shm");

    const result = openHealthy(repo.root);
    db = result.db;

    expect(result.recovered).toBe(true);
    expect(result.fullReindexRequired).toBe(true);
    expect(result.recoveryEvent).toBeDefined();
    expect(result.recoveryEvent!.quarantinePath).toMatch(QUARANTINE_ISO_RE);

    // Quarantine artifacts: main file plus both sidecars, ISO-stamped.
    const quarantined = quarantineFiles();
    expect(quarantined.some((f) => QUARANTINE_ISO_RE.test(f))).toBe(true);
    expect(quarantined.some((f) => f.endsWith("-wal"))).toBe(true);
    expect(quarantined.some((f) => f.endsWith("-shm"))).toBe(true);

    // New database is healthy and carries the recovery record.
    expect(checkHealth(db, repo.root)).toEqual([]);
    const events = getRecoveryEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].quarantinePath).toBe(result.recoveryEvent!.quarantinePath);
    expect(events[0].reason).toContain("open failed");
    expect(isReindexRequired(db)).toBe(true);
  });

  it("quarantines and rebuilds a database with a higher user_version", () => {
    const seeded = openHealthy(repo.root).db;
    seeded.pragma(`user_version = ${CURRENT_USER_VERSION + 1}`);
    seeded.close();

    const result = openHealthy(repo.root);
    db = result.db;

    expect(result.recovered).toBe(true);
    expect(result.recoveryEvent!.reason).toContain("foreign database");
    expect(quarantineFiles().length).toBeGreaterThan(0);
    expect(checkHealth(db, repo.root)).toEqual([]);
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_USER_VERSION);
  });

  it("rebuilds a copied database (wrong repo_root)", () => {
    // Build a database whose meta points at a different repo root.
    const otherRepo = buildFixtureRepo({ git: false });
    try {
      const copied = openDatabase(repo.root);
      runMigrations(copied);
      populateMeta(copied, otherRepo.root);
      copied.close();

      const result = openHealthy(repo.root);
      db = result.db;

      expect(result.recovered).toBe(true);
      expect(result.recoveryEvent!.reason).toContain("meta mismatch: repo_root");
      expect(checkHealth(db, repo.root)).toEqual([]);
      expect(isReindexRequired(db)).toBe(true);
    } finally {
      otherRepo.cleanup();
    }
  });

  it("flags a database missing required tables", () => {
    const bare = openDatabase(repo.root);
    // No migrations run — tables absent.
    const failures = checkHealth(bare, repo.root);
    bare.close();
    expect(failures.some((f) => f.includes("missing required table"))).toBe(true);

    const result = openHealthy(repo.root);
    db = result.db;
    expect(result.recovered).toBe(true);
    expect(checkHealth(db, repo.root)).toEqual([]);
  });
});
