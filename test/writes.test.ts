import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import {
  ChunkInput,
  EdgeInput,
  FileWrite,
  pruneStale,
  replaceChunks,
  replaceGraphRows,
  SymbolInput,
  upsertFile,
  writeFile,
} from "../src/storage/writes";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

function chunk(overrides: Partial<ChunkInput> = {}): ChunkInput {
  return {
    startLine: 1,
    endLine: 3,
    startByte: 0,
    endByte: 42,
    nodeType: "function_declaration",
    nodeName: "f",
    parentNodeType: "program",
    content: "function f() { return 1; }",
    contextPath: "function_declaration",
    depth: 0,
    ...overrides,
  };
}

function symbol(overrides: Partial<SymbolInput> = {}): SymbolInput {
  return {
    chunkIndex: 0,
    name: "f",
    kind: "function",
    signature: "f() → number",
    startLine: 1,
    endLine: 3,
    exported: true,
    ...overrides,
  };
}

function edge(overrides: Partial<EdgeInput> = {}): EdgeInput {
  return {
    sourceSymbolIndex: 0,
    edgeType: "calls",
    targetName: "g",
    targetModule: null,
    line: 2,
    ...overrides,
  };
}

function fileWrite(overrides: Partial<FileWrite["file"]> = {}): FileWrite {
  return {
    file: {
      relativePath: "src/a.js",
      language: "javascript",
      fileHash: "hash-1",
      lastIndexed: "2026-08-07T00:00:00.000Z",
      ...overrides,
    },
    chunks: [chunk()],
    symbols: [symbol()],
    edges: [edge()],
  };
}

describe("write patterns (FR-108)", () => {
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

  it("upsertFile with the same path twice returns the same id with updated fields", () => {
    const id1 = upsertFile(db, {
      relativePath: "src/a.js",
      language: "javascript",
      fileHash: "hash-1",
      lastIndexed: "2026-08-07T00:00:00.000Z",
    });
    const id2 = upsertFile(db, {
      relativePath: "src/a.js",
      language: "javascript",
      fileHash: "hash-2",
      lastIndexed: "2026-08-07T01:00:00.000Z",
    });

    expect(id2).toBe(id1);
    const row = db.prepare("SELECT * FROM indexed_files WHERE id = ?").get(id1) as Record<string, unknown>;
    expect(row.file_hash).toBe("hash-2");
    expect(row.last_indexed).toBe("2026-08-07T01:00:00.000Z");
    expect(db.prepare("SELECT COUNT(*) AS n FROM indexed_files").get()).toEqual({ n: 1 });
  });

  it("replaceChunks keeps chunk_count and the FTS mirror consistent", () => {
    const fileId = writeFile(db, fileWrite());

    replaceChunks(db, fileId, [
      chunk({ nodeName: "alpha", content: "function alpha() { return 'aardvark'; }" }),
      chunk({ nodeName: "beta", content: "function beta() { return 'bumblebee'; }", startLine: 5, endLine: 7 }),
    ]);

    const fileRow = db.prepare("SELECT chunk_count FROM indexed_files WHERE id = ?").get(fileId) as {
      chunk_count: number;
    };
    expect(fileRow.chunk_count).toBe(2);

    const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n;
    expect(ftsCount).toBe(2);
    const oldContent = db
      .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'return'")
      .all() as { rowid: number }[];
    expect(oldContent).toHaveLength(2); // only the two new chunks
    expect(
      db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'aardvark'").all(),
    ).toHaveLength(1);
  });

  it("graph-row replacement removes old rows and inserts fresh ones", () => {
    const fileId = writeFile(db, fileWrite());

    const chunkIds = replaceChunks(db, fileId, [chunk({ nodeName: "renamed" })]);
    const newSymbolIds = replaceGraphRows(
      db,
      fileId,
      [symbol({ name: "renamed" })],
      [edge({ targetName: "helper" })],
      chunkIds,
    );

    const symbols = db.prepare("SELECT id, name, chunk_id FROM symbols").all() as {
      id: number;
      name: string;
      chunk_id: number;
    }[];
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("renamed");
    expect(symbols[0].id).toBe(newSymbolIds[0]);
    expect(symbols[0].chunk_id).toBe(chunkIds[0]);

    const edges = db.prepare("SELECT target_name, source_symbol_id, target_symbol_id FROM edges").all() as {
      target_name: string;
      source_symbol_id: number;
      target_symbol_id: number | null;
    }[];
    expect(edges).toHaveLength(1);
    expect(edges[0].target_name).toBe("helper");
    expect(edges[0].source_symbol_id).toBe(newSymbolIds[0]);
    expect(edges[0].target_symbol_id).toBeNull();
  });

  it("a failure mid-write rolls back the whole file (no half-indexed state)", () => {
    writeFile(db, fileWrite());

    const bad = fileWrite({ fileHash: "hash-2" });
    bad.chunks = [chunk({ nodeName: "newChunk", content: "function newChunk() {}" })];
    // NOT NULL violation on symbols.name fires after file + chunks are written.
    bad.symbols = [symbol({ name: null as unknown as string })];

    expect(() => writeFile(db, bad)).toThrow(/NOT NULL/);

    // Everything from the failed write must be gone; the old state intact.
    const fileRow = db.prepare("SELECT file_hash, chunk_count FROM indexed_files").get() as {
      file_hash: string;
      chunk_count: number;
    };
    expect(fileRow.file_hash).toBe("hash-1");
    expect(fileRow.chunk_count).toBe(1);

    const chunks = db.prepare("SELECT node_name FROM code_chunks").all() as { node_name: string }[];
    expect(chunks).toEqual([{ node_name: "f" }]);
    expect(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'newChunk'").all()).toEqual([]);
    expect(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'return'").all()).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM symbols").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges").get()).toEqual({ n: 1 });
  });

  it("pruneStale deletes unseen files and cascades to all their rows", () => {
    writeFile(db, fileWrite({ relativePath: "src/keep.js" }));
    writeFile(db, fileWrite({ relativePath: "src/stale.js" }));

    const pruned = pruneStale(db, ["src/keep.js"]);

    expect(pruned).toEqual(["src/stale.js"]);
    const paths = db.prepare("SELECT relative_path FROM indexed_files").all() as {
      relative_path: string;
    }[];
    expect(paths).toEqual([{ relative_path: "src/keep.js" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM code_chunks").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM symbols").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get()).toEqual({ n: 1 });
  });
});
