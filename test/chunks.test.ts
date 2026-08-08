import { describe, expect, it } from "vitest";
import { CONTENT_CAP_CHARS, extractChunks, parseSource } from "../src/pipeline/chunks";
import type { Language } from "../src/pipeline/language";

function chunksFor(language: Language, source: string) {
  return extractChunks(parseSource(language, source), source, language);
}

describe("chunk extraction (FR-204)", () => {
  it("emits golden rows for a JavaScript class file", () => {
    const src = [
      'import { greet } from "./greet";',
      "",
      "export class Counter {",
      "  count = 0;",
      "  increment(by) {",
      "    this.count += by;",
      "    return this.count;",
      "  }",
      "}",
      "",
      "function standalone(a, b) {",
      "  return a + b;",
      "}",
    ].join("\n");

    const rows = chunksFor("javascript", src).map((c) => ({
      nodeType: c.nodeType,
      nodeName: c.nodeName,
      contextPath: c.contextPath,
      depth: c.depth,
      lines: [c.startLine, c.endLine],
    }));

    expect(rows).toEqual([
      { nodeType: "import_statement", nodeName: null, contextPath: "import_statement", depth: 0, lines: [1, 1] },
      { nodeType: "export_statement", nodeName: null, contextPath: "export_statement", depth: 0, lines: [3, 9] },
      {
        nodeType: "class_declaration",
        nodeName: "Counter",
        contextPath: "export_statement > class_declaration",
        depth: 1,
        lines: [3, 9],
      },
      {
        nodeType: "field_definition",
        nodeName: null,
        contextPath: "export_statement > class_declaration > field_definition",
        depth: 2,
        lines: [4, 4],
      },
      {
        nodeType: "method_definition",
        nodeName: "increment",
        contextPath: "export_statement > class_declaration > method_definition",
        depth: 2,
        lines: [5, 8],
      },
      { nodeType: "function_declaration", nodeName: "standalone", contextPath: "function_declaration", depth: 0, lines: [11, 13] },
    ]);
  });

  it("a class yields its own chunk plus one per method (nested meaningful nodes)", () => {
    const src = ["class Api {", "  get() {}", "  post() {}", "}"].join("\n");
    const rows = chunksFor("javascript", src);

    const classChunk = rows.find((c) => c.nodeType === "class_declaration");
    expect(classChunk?.nodeName).toBe("Api");
    const methods = rows.filter((c) => c.nodeType === "method_definition");
    expect(methods.map((m) => m.nodeName)).toEqual(["get", "post"]);
    for (const m of methods) {
      expect(m.contextPath).toBe("class_declaration > method_definition");
      expect(m.depth).toBe(1);
    }
  });

  it("emits golden rows for TypeScript type constructs", () => {
    const src = [
      "export interface Shape {",
      "  area(): number;",
      "}",
      "",
      "type Point = { x: number; y: number };",
      "",
      "enum Color { Red, Green }",
    ].join("\n");

    const rows = chunksFor("typescript", src).map((c) => ({
      nodeType: c.nodeType,
      nodeName: c.nodeName,
      contextPath: c.contextPath,
      depth: c.depth,
      lines: [c.startLine, c.endLine],
    }));

    expect(rows).toEqual([
      { nodeType: "export_statement", nodeName: null, contextPath: "export_statement", depth: 0, lines: [1, 3] },
      {
        nodeType: "interface_declaration",
        nodeName: "Shape",
        contextPath: "export_statement > interface_declaration",
        depth: 1,
        lines: [1, 3],
      },
      { nodeType: "type_alias_declaration", nodeName: "Point", contextPath: "type_alias_declaration", depth: 0, lines: [5, 5] },
      { nodeType: "enum_declaration", nodeName: "Color", contextPath: "enum_declaration", depth: 0, lines: [7, 7] },
    ]);
  });

  it("typescript does not inherit JS-only node types (variable_declaration, generator)", () => {
    const src = ["var legacy = 1;", "function* gen() { yield 1; }"].join("\n");
    const types = chunksFor("typescript", src).map((c) => c.nodeType);
    expect(types).not.toContain("variable_declaration");
    expect(types).not.toContain("generator_function_declaration");
    // ...while the same source in a JS file chunks both.
    const jsTypes = chunksFor("javascript", src).map((c) => c.nodeType);
    expect(jsTypes).toContain("variable_declaration");
    expect(jsTypes).toContain("generator_function_declaration");
  });

  it("emits golden rows for a TSX component with an arrow chunk chain", () => {
    const src = [
      "export function Hello(props: { name: string }) {",
      "  return <div>{props.name}</div>;",
      "}",
      "",
      "const Wrapped = (x: number) => x * 2;",
    ].join("\n");

    const rows = chunksFor("tsx", src).map((c) => ({
      nodeType: c.nodeType,
      nodeName: c.nodeName,
      contextPath: c.contextPath,
      depth: c.depth,
    }));

    expect(rows).toEqual([
      { nodeType: "export_statement", nodeName: null, contextPath: "export_statement", depth: 0 },
      {
        nodeType: "function_declaration",
        nodeName: "Hello",
        contextPath: "export_statement > function_declaration",
        depth: 1,
      },
      { nodeType: "lexical_declaration", nodeName: null, contextPath: "lexical_declaration", depth: 0 },
      {
        nodeType: "variable_declarator",
        nodeName: "Wrapped",
        contextPath: "lexical_declaration > variable_declarator",
        depth: 1,
      },
      {
        nodeType: "arrow_function",
        nodeName: null,
        contextPath: "lexical_declaration > variable_declarator > arrow_function",
        depth: 2,
      },
    ]);
  });

  it("caps content at 2000 chars with '...' while byte offsets still slice the full body", () => {
    const bigBody = `  const filler = "${"y".repeat(2100)}";\n  return filler;`;
    const src = `function huge() {\n${bigBody}\n}`;

    const fn = chunksFor("javascript", src).find((c) => c.nodeType === "function_declaration")!;
    expect(fn.content).toHaveLength(CONTENT_CAP_CHARS + 3);
    expect(fn.content.endsWith("...")).toBe(true);
    expect(fn.content.startsWith("function huge()")).toBe(true);

    // Byte offsets recover the untruncated body from the raw source.
    const sliced = Buffer.from(src).subarray(fn.startByte, fn.endByte).toString();
    expect(sliced).toBe(src);
    expect(sliced.length).toBeGreaterThan(CONTENT_CAP_CHARS);
  });

  it("byte offsets are true byte positions for non-ASCII sources", () => {
    const src = 'const café = "münchen";\nfunction after() { return 1; }';
    const fn = chunksFor("javascript", src).find((c) => c.nodeType === "function_declaration")!;

    const bytes = Buffer.from(src);
    expect(bytes.subarray(fn.startByte, fn.endByte).toString()).toBe(
      "function after() { return 1; }",
    );
    // é and ü each take 2 UTF-8 bytes, so byte offset > char index.
    expect(fn.startByte).toBe(src.indexOf("function after") + 2);
  });

  it("uses 1-indexed lines", () => {
    const rows = chunksFor("javascript", "function first() {}");
    expect(rows[0].startLine).toBe(1);
    expect(rows[0].endLine).toBe(1);
  });
});
