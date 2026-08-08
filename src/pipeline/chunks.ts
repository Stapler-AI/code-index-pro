import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TreeSitterTypeScript from "tree-sitter-typescript";
import type { ChunkInput } from "../storage/writes";
import type { Language } from "./language";

/**
 * Chunk extraction (FR-204, indexing.md#chunk-extraction). A node becomes a
 * code_chunks row when its type is in the language's meaningful-node-types
 * allowlist; nested meaningful nodes each get their own chunk.
 */

export const CONTENT_CAP_CHARS = 2000;

const JAVASCRIPT_MEANINGFUL = new Set([
  "function_declaration",
  "class_declaration",
  "method_definition",
  "arrow_function",
  "variable_declarator",
  "export_statement",
  "import_statement",
  "lexical_declaration",
  "variable_declaration",
  "generator_function_declaration",
  "field_definition",
]);

const TYPESCRIPT_MEANINGFUL = new Set([
  "function_declaration",
  "class_declaration",
  "method_definition",
  "arrow_function",
  "variable_declarator",
  "export_statement",
  "import_statement",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "lexical_declaration",
]);

const MEANINGFUL_NODE_TYPES: Record<Language, Set<string>> = {
  javascript: JAVASCRIPT_MEANINGFUL,
  typescript: TYPESCRIPT_MEANINGFUL,
  tsx: TYPESCRIPT_MEANINGFUL,
};

// tree-sitter grammar modules have no usable types; Parser.setLanguage takes them as-is.
const GRAMMARS: Record<Language, any> = {
  javascript: JavaScript,
  typescript: TreeSitterTypeScript.typescript,
  tsx: TreeSitterTypeScript.tsx,
};

/** Grammar object for a language; shared with the query layer (FR-301). */
export function grammarFor(language: Language): any {
  return GRAMMARS[language];
}

const parsers = new Map<Language, Parser>();

function parserFor(language: Language): Parser {
  let parser = parsers.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(GRAMMARS[language]);
    parsers.set(language, parser);
  }
  return parser;
}

/**
 * Parse source once; the returned tree is shared with symbol/edge extraction
 * (FR-301: no second parse).
 */
export function parseSource(language: Language, content: string): Parser.Tree {
  return parserFor(language).parse(content);
}

/**
 * tree-sitter string indexes are UTF-16 code units; the schema stores byte
 * offsets usable to slice the raw file. For pure-ASCII sources they coincide.
 * Exported so symbol extraction (FR-302) maps nodes to chunks by identical
 * byte keys.
 */
export function makeByteOffset(content: string): (charIndex: number) => number {
  if (Buffer.byteLength(content) === content.length) return (i) => i;
  return (i) => Buffer.byteLength(content.slice(0, i));
}

/** Walk the tree emitting one ChunkInput per meaningful node, in source order. */
export function extractChunks(tree: Parser.Tree, content: string, language: Language): ChunkInput[] {
  const meaningful = MEANINGFUL_NODE_TYPES[language];
  const toByte = makeByteOffset(content);
  const chunks: ChunkInput[] = [];

  const walk = (node: Parser.SyntaxNode, ancestors: string[]): void => {
    const isMeaningful = meaningful.has(node.type);
    if (isMeaningful) {
      const text = node.text;
      chunks.push({
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startByte: toByte(node.startIndex),
        endByte: toByte(node.endIndex),
        nodeType: node.type,
        nodeName: node.childForFieldName("name")?.text ?? null,
        parentNodeType: node.parent?.type ?? null,
        content: text.length > CONTENT_CAP_CHARS ? `${text.slice(0, CONTENT_CAP_CHARS)}...` : text,
        contextPath: [...ancestors, node.type].join(" > "),
        depth: ancestors.length,
      });
    }
    const childAncestors = isMeaningful ? [...ancestors, node.type] : ancestors;
    for (const child of node.namedChildren) {
      walk(child, childAncestors);
    }
  };

  walk(tree.rootNode, []);
  return chunks;
}
