import type Parser from "tree-sitter";
import { makeByteOffset } from "../pipeline/chunks";
import type { Language } from "../pipeline/language";
import type { ChunkInput, SymbolInput } from "../storage/writes";
import { runQuery } from "./queries";

/**
 * Symbol extraction (FR-302, ast-graph.md#node-model). Maps @definition.<kind>
 * captures from symbols.scm to symbols rows: kind from the capture name, a
 * one-line token-cheap signature, exported for ESM exports and CJS
 * module.exports, and chunkIndex pointing at the declaration's body chunk
 * when chunk extraction produced one.
 */

/** Signatures are one-line and token-cheap; long value texts get truncated. */
const SIGNATURE_VALUE_CAP = 80;

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SIGNATURE_VALUE_CAP ? `${collapsed.slice(0, SIGNATURE_VALUE_CAP)}...` : collapsed;
}

function fieldText(node: Parser.SyntaxNode, field: string): string {
  const child = node.childForFieldName(field);
  return child ? oneLine(child.text) : "";
}

function heritageText(node: Parser.SyntaxNode): string {
  const heritage = node.children.find((c) => c.type === "class_heritage");
  return heritage ? ` ${oneLine(heritage.text)}` : "";
}

/** Assemble the signature per the ast-graph.md mapping-table examples. */
function buildSignature(kind: string, name: string, node: Parser.SyntaxNode): string {
  switch (kind) {
    case "function":
    case "method":
      // parseFile(path, opts) / save(force: boolean): Promise<void>
      return `${name}${fieldText(node, "parameters")}${fieldText(node, "return_type")}`;
    case "class":
      // class Indexer extends Base
      return `class ${name}${heritageText(node)}`;
    case "variable": {
      // MAX_SIZE = 1_000_000
      const value = node.childForFieldName("value");
      return value ? `${name} = ${oneLine(value.text)}` : name;
    }
    case "interface":
      return `interface ${name}`;
    case "type_alias":
      return `type ${name} = ${fieldText(node, "value")}`;
    case "enum":
      return `enum ${name}`;
    default:
      return name;
  }
}

/** ESM: the declaration itself sits under an export_statement. */
function isEsmExported(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "export_statement") return true;
  // variable_declarator -> (lexical|variable)_declaration -> export_statement
  return (
    (parent.type === "lexical_declaration" || parent.type === "variable_declaration") &&
    parent.parent?.type === "export_statement"
  );
}

/**
 * Names exported by reference rather than by wrapping the declaration:
 * export { a, a as b }, export default f, module.exports = f,
 * module.exports = { a, b }, exports.x = f, module.exports.x = f.
 * Gathered from the edges.scm export captures on the same tree.
 *
 * Accepted v1 limitation (name-only, like edge resolution —
 * indexing.md#known-limitations): matching is by name across the whole file,
 * so a nested declaration sharing an exported name (e.g. a method named like
 * a CJS-exported function) is also marked exported.
 */
function collectExportedNames(language: Language, tree: Parser.Tree): Set<string> {
  const names = new Set<string>();
  const addObjectNames = (object: Parser.SyntaxNode): void => {
    for (const prop of object.namedChildren) {
      if (prop.type === "shorthand_property_identifier") names.add(prop.text);
      else if (prop.type === "pair") {
        const value = prop.childForFieldName("value");
        if (value?.type === "identifier") names.add(value.text);
      }
    }
  };

  for (const match of runQuery(language, "edges", tree)) {
    for (const capture of match.captures) {
      const node = capture.node;
      switch (capture.name) {
        case "export.specifier": {
          const local = node.childForFieldName("name");
          if (local) names.add(local.text);
          break;
        }
        case "export.default":
          if (node.type === "identifier") names.add(node.text);
          break;
        case "export.cjs_module": {
          const right = node.childForFieldName("right");
          if (!right) break;
          if (right.type === "identifier") names.add(right.text);
          else if (right.type === "object") addObjectNames(right);
          break;
        }
        case "export.cjs_named": {
          const right = node.childForFieldName("right");
          if (right?.type === "identifier") names.add(right.text);
          break;
        }
        default:
          break;
      }
    }
  }
  return names;
}

/** A symbol row plus its declaration node, for edge attribution (FR-303). */
export interface ExtractedSymbol {
  input: SymbolInput;
  node: Parser.SyntaxNode;
}

/**
 * Extract symbols rows from the tree chunking already parsed (no re-parse).
 * chunks must be extractChunks' output for the same tree/content so byte keys
 * line up. Returns symbols in source order (outermost first at equal starts);
 * edge extraction relies on this order matching the persisted symbols array.
 */
export function extractSymbolsWithNodes(
  language: Language,
  content: string,
  tree: Parser.Tree,
  chunks: ChunkInput[],
): ExtractedSymbol[] {
  const toByte = makeByteOffset(content);
  const chunkIndexByKey = new Map<string, number>();
  chunks.forEach((chunk, index) => {
    chunkIndexByKey.set(`${chunk.startByte}:${chunk.endByte}:${chunk.nodeType}`, index);
  });

  const exportedNames = collectExportedNames(language, tree);
  const symbols: (ExtractedSymbol & { startByte: number; endByte: number })[] = [];

  for (const match of runQuery(language, "symbols", tree)) {
    const definition = match.captures.find((c) => c.name.startsWith("definition."));
    const name = match.captures.find((c) => c.name === "name");
    if (!definition || !name) continue;
    const kind = definition.name.slice("definition.".length);
    const node = definition.node;
    const startByte = toByte(node.startIndex);
    const endByte = toByte(node.endIndex);

    symbols.push({
      startByte,
      endByte,
      node,
      input: {
        chunkIndex: chunkIndexByKey.get(`${startByte}:${endByte}:${node.type}`) ?? null,
        name: name.node.text,
        kind,
        signature: buildSignature(kind, name.node.text, node),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        exported: isEsmExported(node) || exportedNames.has(name.node.text),
      },
    });
  }

  symbols.sort((a, b) => a.startByte - b.startByte || b.endByte - a.endByte);
  return symbols.map(({ input, node }) => ({ input, node }));
}

/** SymbolInput rows only — what the storage layer persists. */
export function extractSymbols(
  language: Language,
  content: string,
  tree: Parser.Tree,
  chunks: ChunkInput[],
): SymbolInput[] {
  return extractSymbolsWithNodes(language, content, tree, chunks).map((s) => s.input);
}
