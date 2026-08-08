import { describe, expect, it } from "vitest";
import { extractSymbols } from "../src/graph/symbols";
import { extractChunks, parseSource } from "../src/pipeline/chunks";
import type { Language } from "../src/pipeline/language";
import type { SymbolInput } from "../src/storage/writes";

function extract(language: Language, source: string) {
  const tree = parseSource(language, source);
  const chunks = extractChunks(tree, source, language);
  return { chunks, symbols: extractSymbols(language, source, tree, chunks) };
}

function byName(symbols: SymbolInput[], name: string, kind?: string): SymbolInput {
  const found = symbols.find((s) => s.name === name && (kind === undefined || s.kind === kind));
  if (!found) throw new Error(`symbol ${name} not extracted`);
  return found;
}

describe("symbol extraction (FR-302)", () => {
  it("maps the ast-graph.md mapping-table examples verbatim", () => {
    const js = extract(
      "javascript",
      `function parseFile(path, opts) { return null }
class Indexer extends Base {}
export const MAX_SIZE = 1_000_000;
`,
    );
    expect(byName(js.symbols, "parseFile")).toMatchObject({
      kind: "function",
      signature: "parseFile(path, opts)",
      exported: false,
      startLine: 1,
      endLine: 1,
    });
    expect(byName(js.symbols, "Indexer")).toMatchObject({
      kind: "class",
      signature: "class Indexer extends Base",
    });
    expect(byName(js.symbols, "MAX_SIZE")).toMatchObject({
      kind: "variable",
      signature: "MAX_SIZE = 1_000_000",
      exported: true,
    });

    const ts = extract(
      "typescript",
      `class Repo {
  save(force: boolean): Promise<void> { return this.db.write(force) }
}
interface ChunkRow { id: number }
`,
    );
    expect(byName(ts.symbols, "save")).toMatchObject({
      kind: "method",
      signature: "save(force: boolean): Promise<void>",
    });
    expect(byName(ts.symbols, "ChunkRow")).toMatchObject({
      kind: "interface",
      signature: "interface ChunkRow",
    });
  });

  it.each(["typescript", "tsx"] as const)("covers every kind under the %s grammar (PRD §8)", (language) => {
    const { symbols } = extract(
      language,
      `export function parse(path: string): number { return 1 }
export class Store extends Base implements Cache {
  flush(): void {}
}
export interface Row { id: number }
export type Alias = string | null;
export enum Color { Red, Green }
export const LIMIT = 50;
abstract class BaseStore {}
`,
    );
    expect(byName(symbols, "parse")).toMatchObject({
      kind: "function",
      signature: "parse(path: string): number",
      exported: true,
    });
    expect(byName(symbols, "Store")).toMatchObject({
      kind: "class",
      signature: "class Store extends Base implements Cache",
      exported: true,
    });
    expect(byName(symbols, "flush")).toMatchObject({ kind: "method", signature: "flush(): void" });
    expect(byName(symbols, "Row")).toMatchObject({ kind: "interface", exported: true });
    expect(byName(symbols, "Alias")).toMatchObject({
      kind: "type_alias",
      signature: "type Alias = string | null",
      exported: true,
    });
    expect(byName(symbols, "Color")).toMatchObject({ kind: "enum", signature: "enum Color", exported: true });
    expect(byName(symbols, "LIMIT")).toMatchObject({ kind: "variable", exported: true });
    expect(byName(symbols, "BaseStore")).toMatchObject({ kind: "class", exported: false });
  });

  it("marks ESM exports: wrapped declarations, specifiers, default", () => {
    const { symbols } = extract(
      "javascript",
      `function pub() {}
function alias() {}
function dflt() {}
function priv() {}
export { pub, alias as renamed };
export default dflt;
`,
    );
    expect(byName(symbols, "pub").exported).toBe(true);
    expect(byName(symbols, "alias").exported).toBe(true);
    expect(byName(symbols, "dflt").exported).toBe(true);
    expect(byName(symbols, "priv").exported).toBe(false);
  });

  it("marks CJS exports through all module.exports forms", () => {
    const { symbols } = extract(
      "javascript",
      `function add(a, b) { return a + b }
function sub(a, b) { return a - b }
function mul(a, b) { return a * b }
function renamed(a) { return a }
function local() {}
module.exports = { add, alias: renamed };
module.exports.sub = sub;
exports.mul = mul;
other.thing = local;
`,
    );
    expect(byName(symbols, "add").exported).toBe(true);
    expect(byName(symbols, "renamed").exported).toBe(true); // pair value identifier
    expect(byName(symbols, "sub").exported).toBe(true);
    expect(byName(symbols, "mul").exported).toBe(true);
    expect(byName(symbols, "local").exported).toBe(false); // non-exports assignment
  });

  it("marks a single-function CJS module (module.exports = fn)", () => {
    const { symbols } = extract("javascript", `function main() {}\nmodule.exports = main;\n`);
    expect(byName(symbols, "main").exported).toBe(true);
  });

  it.each(["typescript", "tsx"] as const)("links each symbol's chunkIndex to its body chunk (%s)", (language) => {
    const { chunks, symbols } = extract(
      language,
      `export function parse(path: string): number { return 1 }
class Store {
  save(): void {}
}
interface Row { id: number }
`,
    );
    for (const [name, nodeType] of [
      ["parse", "function_declaration"],
      ["Store", "class_declaration"],
      ["save", "method_definition"],
      ["Row", "interface_declaration"],
    ] as const) {
      const symbol = byName(symbols, name);
      expect(symbol.chunkIndex).not.toBeNull();
      const chunk = chunks[symbol.chunkIndex!];
      expect(chunk.nodeType).toBe(nodeType);
      expect(chunk.startLine).toBe(symbol.startLine);
      expect(chunk.endLine).toBe(symbol.endLine);
    }
  });

  it("chunk linkage survives multi-byte content before the declaration", () => {
    const source = `const banner = "héllo — 🎉";
export function greet(name) { return banner + name }
`;
    const { chunks, symbols } = extract("javascript", source);
    const greet = byName(symbols, "greet");
    expect(greet.chunkIndex).not.toBeNull();
    expect(chunks[greet.chunkIndex!].nodeType).toBe("function_declaration");
  });

  it.each(["typescript", "tsx"] as const)(
    "leaves chunkIndex null when no chunk exists for the node (abstract class, %s)",
    (language) => {
      const { symbols } = extract(language, `abstract class A { run(): void {} }\n`);
      expect(byName(symbols, "A")).toMatchObject({ kind: "class", chunkIndex: null });
    },
  );

  it("extracts from tsx trees (PRD §8: both TS grammars in every fixture)", () => {
    const { symbols } = extract(
      "tsx",
      `import { useState } from 'react';
export function Counter(): JSX.Element {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
export class Panel extends React.Component {
  render() { return <div />; }
}
`,
    );
    expect(byName(symbols, "Counter")).toMatchObject({
      kind: "function",
      signature: "Counter(): JSX.Element",
      exported: true,
    });
    expect(byName(symbols, "Panel")).toMatchObject({ kind: "class", exported: true });
    expect(byName(symbols, "render").kind).toBe("method");
  });

  it("returns symbols in source order, outermost first at equal starts", () => {
    const { symbols } = extract(
      "javascript",
      `class A { first(a, b) {} second() {} }
function after() {}
`,
    );
    expect(symbols.map((s) => s.name)).toEqual(["A", "first", "second", "after"]);
    expect(byName(symbols, "first")).toMatchObject({ kind: "method", signature: "first(a, b)" });
  });

  it("caps runaway value texts so signatures stay one-line and token-cheap", () => {
    const long = `const BIG = { ${Array.from({ length: 40 }, (_, i) => `k${i}: ${i}`).join(", ")} };`;
    const { symbols } = extract("javascript", long);
    const big = byName(symbols, "BIG");
    expect(big.signature!.length).toBeLessThan(100);
    expect(big.signature).not.toContain("\n");
  });
});
