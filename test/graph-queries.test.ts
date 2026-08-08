import { existsSync } from "node:fs";
import Parser from "tree-sitter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadQuery, queryPath, runQuery } from "../src/graph/queries";
import { parseSource } from "../src/pipeline/chunks";
import type { Language } from "../src/pipeline/language";

const JS_SOURCE = `
import { upsertFile, replaceChunks as rc } from './db';
import def from 'react';
import * as ns from './ns';

function parseFile(path, opts) {
  return upsertFile(path);
}

class Indexer extends Base {
  save(force) {
    return this.db.write(force);
  }
}

export const MAX_SIZE = 1_000_000;

const rows = arr.map(parseRow);

module.exports = { parseFile };
exports.extra = parseFile;
other.thing = 1;

export default parseFile;
`;

const TS_SOURCE = `
import { upsertFile } from './db';

export function parse(path: string): number {
  return upsertFile(path);
}

export class Store extends Base implements Cache {
  save(force: boolean): Promise<void> {
    return this.db.write(force);
  }
}

interface ChunkRow { id: number }
type Alias = string;
enum Color { Red }
export const LIMIT = 50;

abstract class BaseStore {
  abstract flush(): void;
  save(force: boolean): void {}
}
`;

const TSX_SOURCE = `
import { useState } from 'react';

export function Counter(): JSX.Element {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`;

function captureNames(language: Language, name: "symbols" | "edges", source: string): Set<string> {
  const tree = parseSource(language, source);
  const names = new Set<string>();
  for (const match of runQuery(language, name, tree)) {
    for (const capture of match.captures) names.add(capture.name);
  }
  return names;
}

function capturedTexts(language: Language, name: "symbols" | "edges", source: string, captureName: string): string[] {
  const tree = parseSource(language, source);
  const texts: string[] = [];
  for (const match of runQuery(language, name, tree)) {
    for (const capture of match.captures) {
      if (capture.name === captureName) texts.push(capture.node.text);
    }
  }
  return texts;
}

describe("tree-sitter query files (FR-301)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("all four .scm files exist where the loader looks", () => {
    expect(existsSync(queryPath("javascript", "symbols"))).toBe(true);
    expect(existsSync(queryPath("javascript", "edges"))).toBe(true);
    expect(existsSync(queryPath("typescript", "symbols"))).toBe(true);
    expect(existsSync(queryPath("typescript", "edges"))).toBe(true);
    // tsx reuses the typescript files rather than shipping its own set.
    expect(queryPath("tsx", "symbols")).toBe(queryPath("typescript", "symbols"));
  });

  it("compiles every query file against every grammar, including tsx (PRD §8)", () => {
    for (const language of ["javascript", "typescript", "tsx"] as const) {
      expect(loadQuery(language, "symbols")).toBeInstanceOf(Parser.Query);
      expect(loadQuery(language, "edges")).toBeInstanceOf(Parser.Query);
    }
  });

  it("compiles per grammar: tsx gets its own Query even though it shares the files", () => {
    expect(loadQuery("tsx", "symbols")).not.toBe(loadQuery("typescript", "symbols"));
    // Repeated loads hit the cache instead of recompiling.
    expect(loadQuery("typescript", "symbols")).toBe(loadQuery("typescript", "symbols"));
  });

  it("JS symbols.scm captures declarations with their names", () => {
    const names = captureNames("javascript", "symbols", JS_SOURCE);
    expect(names).toContain("definition.function");
    expect(names).toContain("definition.class");
    expect(names).toContain("definition.method");
    expect(names).toContain("definition.variable");
    expect(names).toContain("name");

    expect(capturedTexts("javascript", "symbols", JS_SOURCE, "name")).toEqual(
      expect.arrayContaining(["parseFile", "Indexer", "save", "MAX_SIZE", "rows"]),
    );
  });

  it("JS edges.scm captures calls, imports, exports, extends, references", () => {
    const names = captureNames("javascript", "edges", JS_SOURCE);
    expect(names).toContain("call.callee");
    expect(names).toContain("call.method");
    expect(names).toContain("import.specifier");
    expect(names).toContain("import.default");
    expect(names).toContain("import.namespace");
    expect(names).toContain("import.source");
    expect(names).toContain("export.declaration");
    expect(names).toContain("export.cjs_module");
    expect(names).toContain("export.cjs_name");
    expect(names).toContain("extends.name");
    expect(names).toContain("reference.identifier");

    expect(capturedTexts("javascript", "edges", JS_SOURCE, "call.callee")).toContain("upsertFile");
    expect(capturedTexts("javascript", "edges", JS_SOURCE, "call.method")).toContain("write");
    expect(capturedTexts("javascript", "edges", JS_SOURCE, "extends.name")).toContain("Base");
    expect(capturedTexts("javascript", "edges", JS_SOURCE, "reference.identifier")).toContain("parseRow");
    expect(capturedTexts("javascript", "edges", JS_SOURCE, "export.default")).toContain("parseFile");
    // CJS export forms are anchored to module.exports / exports only:
    // other.thing = 1 must not capture.
    expect(capturedTexts("javascript", "edges", JS_SOURCE, "export.cjs_name")).toContain("extra");
    expect(capturedTexts("javascript", "edges", JS_SOURCE, "export.cjs_name")).not.toContain("thing");
    expect(capturedTexts("javascript", "edges", JS_SOURCE, "export.cjs_module")).toHaveLength(1);
  });

  it("one import match per specifier, each carrying the module string", () => {
    const tree = parseSource("javascript", JS_SOURCE);
    const specifierMatches = runQuery("javascript", "edges", tree).filter((m) =>
      m.captures.some((c) => c.name === "import.specifier"),
    );
    expect(specifierMatches).toHaveLength(2); // upsertFile, replaceChunks-as-rc
    for (const match of specifierMatches) {
      expect(match.captures.find((c) => c.name === "import.source")?.node.text).toBe("'./db'");
    }
  });

  it("TS symbols.scm additionally captures interfaces, type aliases, enums", () => {
    const names = captureNames("typescript", "symbols", TS_SOURCE);
    expect(names).toContain("definition.interface");
    expect(names).toContain("definition.type_alias");
    expect(names).toContain("definition.enum");
    expect(capturedTexts("typescript", "symbols", TS_SOURCE, "name")).toEqual(
      expect.arrayContaining(["parse", "Store", "save", "ChunkRow", "Alias", "Color", "LIMIT"]),
    );
  });

  it("abstract classes capture as definition.class in TS and TSX grammars", () => {
    for (const language of ["typescript", "tsx"] as const) {
      const tree = parseSource(language, TS_SOURCE);
      const classNames = runQuery(language, "symbols", tree)
        .filter((m) => m.captures.some((c) => c.name === "definition.class"))
        .map((m) => m.captures.find((c) => c.name === "name")!.node.text);
      expect(classNames).toContain("BaseStore");
    }
  });

  it("TS edges.scm captures extends and implements through the TS clause nodes", () => {
    expect(capturedTexts("typescript", "edges", TS_SOURCE, "extends.name")).toContain("Base");
    expect(capturedTexts("typescript", "edges", TS_SOURCE, "implements.name")).toContain("Cache");
  });

  it("the shared typescript queries capture from tsx trees (PRD §8 grammar quirk)", () => {
    expect(capturedTexts("tsx", "symbols", TSX_SOURCE, "name")).toContain("Counter");
    const edgeNames = captureNames("tsx", "edges", TSX_SOURCE);
    expect(edgeNames).toContain("call.callee"); // useState(0), setN(...)
    expect(edgeNames).toContain("import.specifier");
  });

  it("runs against an existing tree without a second parse (FR-301)", () => {
    const tree = parseSource("typescript", TS_SOURCE);
    const parseSpy = vi.spyOn(Parser.prototype, "parse");

    const matches = runQuery("typescript", "edges", tree);

    expect(matches.length).toBeGreaterThan(0);
    expect(parseSpy).not.toHaveBeenCalled();
  });
});
