import type { Database } from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateFile, MAX_FILE_SIZE_BYTES } from "../src/pipeline/changes";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { upsertFile } from "../src/storage/writes";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

describe("change detection (FR-203 / FR-200)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    db = openDatabase(repo.root);
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
    repo.cleanup();
  });

  it("skips a file larger than 1 MB", () => {
    repo.write("src/bundle.js", "x".repeat(MAX_FILE_SIZE_BYTES + 1));
    expect(evaluateFile(db, repo.root, "src/bundle.js")).toEqual({
      action: "skip",
      reason: "too_large",
    });
  });

  it("indexes a file at exactly the 1 MB boundary", () => {
    repo.write("src/exact.js", "x".repeat(MAX_FILE_SIZE_BYTES));
    expect(evaluateFile(db, repo.root, "src/exact.js")).toMatchObject({ action: "index" });
  });

  it("skips a binary (invalid UTF-8) file", () => {
    // 0xFF 0xFE is an invalid UTF-8 sequence.
    writeFileSync(join(repo.root, "src/blob.js"), Buffer.from([0xff, 0xfe, 0x00, 0x48, 0x69]));
    expect(evaluateFile(db, repo.root, "src/blob.js")).toEqual({
      action: "skip",
      reason: "binary",
    });
  });

  it("skips an unchanged file whose (relative_path, file_hash) row matches", () => {
    const first = evaluateFile(db, repo.root, "src/math.js");
    expect(first.action).toBe("index");
    if (first.action !== "index") throw new Error("unreachable");

    upsertFile(db, {
      relativePath: "src/math.js",
      language: "javascript",
      fileHash: first.fileHash,
      lastIndexed: "2026-08-07T00:00:00.000Z",
    });

    expect(evaluateFile(db, repo.root, "src/math.js")).toEqual({
      action: "skip",
      reason: "unchanged",
    });
  });

  it("selects a changed file (new hash) for re-index", () => {
    const first = evaluateFile(db, repo.root, "src/math.js");
    if (first.action !== "index") throw new Error("expected index decision");
    upsertFile(db, {
      relativePath: "src/math.js",
      language: "javascript",
      fileHash: first.fileHash,
      lastIndexed: "2026-08-07T00:00:00.000Z",
    });

    repo.edit("src/math.js", (c) => c.replace("add", "sum"));

    const second = evaluateFile(db, repo.root, "src/math.js");
    expect(second.action).toBe("index");
    if (second.action !== "index") throw new Error("unreachable");
    expect(second.fileHash).not.toBe(first.fileHash);
    expect(second.content).toContain("sum");
  });

  it("returns decoded content and a sha256 hex hash for indexable files", () => {
    const decision = evaluateFile(db, repo.root, "src/greet.ts");
    if (decision.action !== "index") throw new Error("expected index decision");
    expect(decision.content).toBe(repo.read("src/greet.ts"));
    expect(decision.fileHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
