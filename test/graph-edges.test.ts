import { describe, expect, it } from "vitest";
import { extractEdges } from "../src/graph/edges";
import { extractSymbolsWithNodes } from "../src/graph/symbols";
import { extractChunks, parseSource } from "../src/pipeline/chunks";
import type { Language } from "../src/pipeline/language";
import type { EdgeInput } from "../src/storage/writes";

function extract(language: Language, source: string) {
  const tree = parseSource(language, source);
  const symbols = extractSymbolsWithNodes(language, source, tree, extractChunks(tree, source, language));
  return { symbols, edges: extractEdges(language, tree, symbols) };
}

function ofType(edges: EdgeInput[], edgeType: string): EdgeInput[] {
  return edges.filter((e) => e.edgeType === edgeType);
}

// TS fixture exercising all six edge types (QA-303).
const SIX_TYPES_TS = `import { upsertFile, replaceChunks as rc } from './db';
import Base from './base';

export function indexFile(row) {
  return upsertFile(row);
}

export class Store extends Base implements Cache {
  save(force: boolean): void {
    this.db.write(force);
  }
}

const handler = arr.map(indexFile);
`;

describe("edge extraction (FR-303)", () => {
  it.each(["typescript", "tsx"] as const)("one fixture yields all six edge types (%s)", (language) => {
    const { edges } = extract(language, SIX_TYPES_TS);
    const types = new Set(edges.map((e) => e.edgeType));
    expect(types).toEqual(new Set(["calls", "imports", "exports", "references", "extends", "implements"]));
  });

  it("golden rows for the six-type fixture", () => {
    const { symbols, edges } = extract("typescript", SIX_TYPES_TS);
    const names = symbols.map((s) => s.input.name);

    expect(ofType(edges, "imports")).toEqual([
      { sourceSymbolIndex: null, edgeType: "imports", targetName: "upsertFile", targetModule: "./db", line: 1 },
      { sourceSymbolIndex: null, edgeType: "imports", targetName: "replaceChunks", targetModule: "./db", line: 1 },
      { sourceSymbolIndex: null, edgeType: "imports", targetName: "Base", targetModule: "./base", line: 2 },
    ]);

    // upsertFile(row) attributes to the innermost enclosing symbol indexFile.
    expect(ofType(edges, "calls")).toEqual([
      {
        sourceSymbolIndex: names.indexOf("indexFile"),
        edgeType: "calls",
        targetName: "upsertFile",
        targetModule: null,
        line: 5,
      },
      // this.db.write(force) records the property name, attributed to save.
      {
        sourceSymbolIndex: names.indexOf("save"),
        edgeType: "calls",
        targetName: "write",
        targetModule: null,
        line: 10,
      },
      // arr.map(indexFile) is itself a method call.
      {
        sourceSymbolIndex: names.indexOf("handler"),
        edgeType: "calls",
        targetName: "map",
        targetModule: null,
        line: 14,
      },
    ]);

    expect(ofType(edges, "exports")).toEqual([
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "indexFile", targetModule: null, line: 4 },
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "Store", targetModule: null, line: 8 },
    ]);

    // extends/implements attribute to the class symbol.
    expect(ofType(edges, "extends")).toEqual([
      {
        sourceSymbolIndex: names.indexOf("Store"),
        edgeType: "extends",
        targetName: "Base",
        targetModule: null,
        line: 8,
      },
    ]);
    expect(ofType(edges, "implements")).toEqual([
      {
        sourceSymbolIndex: names.indexOf("Store"),
        edgeType: "implements",
        targetName: "Cache",
        targetModule: null,
        line: 8,
      },
    ]);

    // arr.map(indexFile) — non-call identifier use of a known symbol name,
    // attributed to the enclosing declarator symbol.
    expect(ofType(edges, "references")).toEqual([
      {
        sourceSymbolIndex: names.indexOf("handler"),
        edgeType: "references",
        targetName: "indexFile",
        targetModule: null,
        line: 14,
      },
    ]);
  });

  it("JS grammar: calls, CJS exports, extends, references", () => {
    const { symbols, edges } = extract(
      "javascript",
      `const { helper } = require('./util');

function add(a, b) { return a + b }
function sub(a, b) { return a - b }

class List extends Array {}

const mapped = rows.map(add);

module.exports = { add, alias: sub };
module.exports.list = List;
exports.extra = add;
other.thing = add;
`,
    );
    const names = symbols.map((s) => s.input.name);

    // require('./util') is a plain call — target_name "require" (resolution
    // leaves it NULL; dynamic constructs are a documented limitation).
    expect(ofType(edges, "calls").map((e) => e.targetName)).toEqual(["require", "map"]);

    // All CJS forms produce exports edges at file scope; other.thing does not.
    expect(ofType(edges, "exports")).toEqual([
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "add", targetModule: null, line: 10 },
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "sub", targetModule: null, line: 10 },
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "List", targetModule: null, line: 11 },
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "add", targetModule: null, line: 12 },
    ]);

    expect(ofType(edges, "extends")).toEqual([
      {
        sourceSymbolIndex: names.indexOf("List"),
        edgeType: "extends",
        targetName: "Array",
        targetModule: null,
        line: 6,
      },
    ]);

    expect(ofType(edges, "references").map((e) => e.targetName)).toEqual(["add"]);
  });

  it("ESM export forms: wrapped declarations, specifiers, default, re-export", () => {
    const { edges } = extract(
      "javascript",
      `function a() {}
function b() {}
function c() {}
export const X = 1, Y = 2;
export { a, b as renamed };
export default c;
export { z } from './other';
`,
    );
    expect(ofType(edges, "exports")).toEqual([
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "X", targetModule: null, line: 4 },
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "Y", targetModule: null, line: 4 },
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "a", targetModule: null, line: 5 },
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "b", targetModule: null, line: 5 },
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "c", targetModule: null, line: 6 },
      // One-level re-export carries the source module.
      { sourceSymbolIndex: null, edgeType: "exports", targetName: "z", targetModule: "./other", line: 7 },
    ]);
  });

  it("import edges carry remote names (alias resolves one level) and skip inline type keywords", () => {
    const { edges } = extract(
      "typescript",
      `import { real as local, type Row } from './db';
import * as ns from './ns';
`,
    );
    expect(ofType(edges, "imports")).toEqual([
      { sourceSymbolIndex: null, edgeType: "imports", targetName: "real", targetModule: "./db", line: 1 },
      { sourceSymbolIndex: null, edgeType: "imports", targetName: "Row", targetModule: "./db", line: 1 },
      { sourceSymbolIndex: null, edgeType: "imports", targetName: "ns", targetModule: "./ns", line: 2 },
    ]);
  });

  it("references include identifiers known only through imports", () => {
    const { edges } = extract(
      "javascript",
      `import parseRow from './rows';
const mapped = arr.map(parseRow);
`,
    );
    expect(ofType(edges, "references").map((e) => e.targetName)).toEqual(["parseRow"]);
    // Unknown identifiers stay out.
    const { edges: none } = extract("javascript", `const mapped = arr.map(unknownFn);\n`);
    expect(ofType(none, "references")).toEqual([]);
  });

  it("nested calls attribute to the innermost symbol, file-scope calls to null", () => {
    const { symbols, edges } = extract(
      "javascript",
      `function outer() {
  function inner() {
    target();
  }
}
topLevel();
`,
    );
    const names = symbols.map((s) => s.input.name);
    const calls = ofType(edges, "calls");
    expect(calls).toEqual([
      {
        sourceSymbolIndex: names.indexOf("inner"),
        edgeType: "calls",
        targetName: "target",
        targetModule: null,
        line: 3,
      },
      { sourceSymbolIndex: null, edgeType: "calls", targetName: "topLevel", targetModule: null, line: 6 },
    ]);
  });

  it("side-effect imports and export * produce no edges (documented v1 gap)", () => {
    const { edges } = extract("javascript", `import './polyfill';\nexport * from './other';\n`);
    expect(edges).toEqual([]);
  });

  it("tsx: edges extract from JSX-bearing sources (PRD §8)", () => {
    const { symbols, edges } = extract(
      "tsx",
      `import { useState } from 'react';
export function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`,
    );
    const names = symbols.map((s) => s.input.name);
    expect(ofType(edges, "imports")).toEqual([
      { sourceSymbolIndex: null, edgeType: "imports", targetName: "useState", targetModule: "react", line: 1 },
    ]);
    expect(ofType(edges, "calls").map((e) => [e.targetName, e.sourceSymbolIndex])).toContainEqual([
      "useState",
      names.indexOf("Counter"),
    ]);
    expect(ofType(edges, "exports").map((e) => e.targetName)).toEqual(["Counter"]);
  });
});
