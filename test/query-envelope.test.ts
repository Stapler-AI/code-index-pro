import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { envelopeFromOutline, envelopeFromSearchHit, envelopeFromSymbol } from "../src/query/envelope";
import * as graph from "../src/query/graph";
import { SymbolTuple } from "../src/query/graph";
import { searchCode as searchCodeCapped } from "../src/query/search";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

// Row-content assertions live here; truncation reporting is QA-404's.
const searchCode = (db: Database, query: string) => searchCodeCapped(db, query).results;
const whoCalls = (db: Database, id: number, name: string) => graph.whoCalls(db, id, name).results;
const getDependencies = (db: Database, id: number) => graph.getDependencies(db, id).results;
const impactOfChange = (db: Database, id: number) => graph.impactOfChange(db, id).results;
const moduleMap = (db: Database) => graph.moduleMap(db).results;
const classHierarchy = (db: Database, id: number, direction: "ancestors" | "descendants") =>
  graph.classHierarchy(db, id, direction).results;
const deadExports = (db: Database) => graph.deadExports(db).results;
const fileOutline = (db: Database, path: string) => graph.fileOutline(db, path).results;
const findSymbol = (db: Database, name: string) => graph.findSymbol(db, name).results;

const ENVELOPE_KEYS = new Set(["path", "lines", "preview", "id", "resolved"]);

function expectEnvelope(input: object): void {
  const envelope = input as Record<string, unknown>;
  for (const key of Object.keys(envelope)) {
    expect(ENVELOPE_KEYS).toContain(key);
  }
  expect(typeof envelope.path).toBe("string");
  const lines = envelope.lines as number[];
  expect(Array.isArray(lines)).toBe(true);
  expect(lines.length).toBe(2);
  expect(typeof lines[0]).toBe("number");
  expect(typeof lines[1]).toBe("number");
  expect(lines[0]).toBeLessThanOrEqual(lines[1]);
  expect(typeof envelope.preview).toBe("string");
}

describe("result envelope (FR-403)", () => {
  let repo: FixtureRepo;
  let db: Database;

  beforeEach(() => {
    repo = buildFixtureRepo({ git: false });
    repo.write("src/who.ts", `export function targetFn(): void {}\nexport function caller1() { targetFn() }\n`);
    repo.write("src/dup.ts", `export function targetFn(): void {}\n`);
    repo.write("src/user2.tsx", `export function Caller2() { targetFn(); return <i />; }\n`);
    repo.write("src/classes.ts", `export class Base {}\nexport class Leaf extends Base {}\n`);
    db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
  });
  afterEach(() => {
    db.close();
    repo.cleanup();
  });

  it("FTS hits normalize with the snippet as preview and the chunk id", () => {
    const [hit] = searchCode(db, "greet");
    const envelope = envelopeFromSearchHit(hit);
    expectEnvelope(envelope);
    expect(envelope.id).toBe(hit.chunkId);
    expect(envelope.preview).toBe(hit.excerpt);
    expect(envelope.lines).toEqual([hit.startLine, hit.endLine]);
    expect(envelope.resolved).toBeUndefined();
  });

  it("lookup results normalize with the signature as preview and the symbol id", () => {
    const [tuple] = findSymbol(db, "greet");
    const envelope = envelopeFromSymbol(tuple);
    expectEnvelope(envelope);
    expect(envelope).toMatchObject({
      path: "src/greet.ts",
      preview: "greet(name: string): Greeting",
      id: tuple.id,
    });
  });

  it("resolved: false appears exactly on unresolved matches", () => {
    const targetId = findSymbol(db, "targetFn").find((t) => t.path === "src/who.ts")!.id;
    const callers = whoCalls(db, targetId, "targetFn").map(envelopeFromSymbol);

    const resolvedCaller = callers.find((c) => c.path === "src/who.ts")!;
    const unresolvedCaller = callers.find((c) => c.path === "src/user2.tsx")!;
    expect("resolved" in resolvedCaller).toBe(false);
    expect(unresolvedCaller.resolved).toBe(false);
  });

  it("outline rows normalize spanning their full line range", () => {
    const rows = fileOutline(db, "src/greet.ts");
    for (const row of rows) {
      const envelope = envelopeFromOutline("src/greet.ts", row);
      expectEnvelope(envelope);
      expect(envelope.lines).toEqual([row.startLine, row.endLine]);
    }
  });

  it("every graph query's rows normalize cleanly and carry no bodies", () => {
    const targetId = findSymbol(db, "targetFn").find((t) => t.path === "src/who.ts")!.id;
    const leafId = findSymbol(db, "Leaf")[0].id;
    const legs: Record<string, (SymbolTuple & { resolved?: boolean })[]> = {
      findSymbol: findSymbol(db, "targetFn"),
      whoCalls: whoCalls(db, targetId, "targetFn"),
      impactOfChange: impactOfChange(db, targetId),
      classHierarchy: classHierarchy(db, leafId, "ancestors"),
      deadExports: deadExports(db),
    };
    for (const [leg, tuples] of Object.entries(legs)) {
      // Guard against vacuous coverage: every leg must produce rows.
      expect(tuples.length, `${leg} returned no rows`).toBeGreaterThan(0);
      for (const tuple of tuples) {
        expect(tuple).not.toHaveProperty("content");
        expect(tuple).not.toHaveProperty("body");
        expectEnvelope(envelopeFromSymbol(tuple));
      }
    }
  });

  it("edge-centric and aggregate rows also carry no bodies and only their own keys", () => {
    // getDependencies and moduleMap are not location results (no envelope
    // conversion), but the never-bodies rule binds every graph query.
    const caller1Id = findSymbol(db, "caller1")[0].id;
    const deps = getDependencies(db, caller1Id);
    expect(deps.length).toBeGreaterThan(0);
    for (const dep of deps) {
      expect(Object.keys(dep).sort()).toEqual(["edgeType", "line", "target", "targetModule", "targetName"]);
      if (dep.target !== null) {
        expect(Object.keys(dep.target).sort()).toEqual(["id", "kind", "path", "signature"]);
      }
    }

    const map = moduleMap(db);
    expect(map.length).toBeGreaterThan(0);
    for (const row of map) {
      expect(Object.keys(row).sort()).toEqual(["fromFile", "importCount", "toModule"]);
    }
  });

  it("envelopes never leak extra keys (id stays optional for future ast-grep results)", () => {
    const [tuple] = findSymbol(db, "greet");
    const envelope = envelopeFromSymbol(tuple);
    expect(Object.keys(envelope).sort()).toEqual(["id", "lines", "path", "preview"]);
  });
});
