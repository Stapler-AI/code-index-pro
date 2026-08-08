import type Parser from "tree-sitter";
import type { Language } from "../pipeline/language";
import type { EdgeInput } from "../storage/writes";
import { runQuery } from "./queries";
import type { ExtractedSymbol } from "./symbols";

/**
 * Edge extraction (FR-303, ast-graph.md#edge-model). Maps edges.scm captures
 * to the six directed edge types. Every edge records the innermost enclosing
 * symbol (sourceSymbolIndex into the extracted symbols array, NULL at file
 * scope), target_name (always populated), and line. target_symbol_id is
 * written NULL by the storage layer — resolution is a separate pass (FR-304).
 *
 * Deliberate v1 gaps (indexing.md#known-limitations): side-effect imports
 * (import './x') and `export * from './x'` yield no edge — they carry no
 * specifier/name; re-exports and aliases are followed one level only, so an
 * aliased import's edge carries the remote name (the specifier's name field)
 * and uses of the local alias resolve via the unique-name fallback at best.
 * Exports of non-identifier values (module.exports = { a: 1 },
 * export default expr()) also yield no edge — they name no own symbol.
 */

type EdgeType = "calls" | "imports" | "exports" | "references" | "extends" | "implements";

/** import { a as b } from './db' — local binding is the alias when present. */
function specifierLocalName(specifier: Parser.SyntaxNode): string | null {
  const alias = specifier.childForFieldName("alias");
  const name = specifier.childForFieldName("name");
  return (alias ?? name)?.text ?? null;
}

/** './db' from the string node, quotes stripped. */
function moduleString(stringNode: Parser.SyntaxNode): string {
  return stringNode.namedChildren.find((c) => c.type === "string_fragment")?.text ?? "";
}

/** Innermost symbol whose declaration node contains `node`, or null. */
function enclosingSymbolIndex(symbols: ExtractedSymbol[], node: Parser.SyntaxNode): number | null {
  let best: number | null = null;
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i].node;
    if (s.startIndex <= node.startIndex && s.endIndex >= node.endIndex) {
      if (
        best === null ||
        s.startIndex > symbols[best].node.startIndex ||
        (s.startIndex === symbols[best].node.startIndex && s.endIndex < symbols[best].node.endIndex)
      ) {
        best = i;
      }
    }
  }
  return best;
}

/** Names an ESM export declaration introduces (declarators fan out). */
function declarationNames(declaration: Parser.SyntaxNode): string[] {
  if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
    return declaration.namedChildren
      .filter((c) => c.type === "variable_declarator")
      .map((c) => c.childForFieldName("name")?.text)
      .filter((n): n is string => n !== undefined);
  }
  const name = declaration.childForFieldName("name");
  return name ? [name.text] : [];
}

/** Re-export target module for an export_specifier, one level only. */
function specifierSource(specifier: Parser.SyntaxNode): string | null {
  const statement = specifier.parent?.parent; // export_specifier -> export_clause -> export_statement
  const source = statement?.type === "export_statement" ? statement.childForFieldName("source") : null;
  return source ? moduleString(source) : null;
}

/**
 * Extract edge rows from the tree chunking already parsed (no re-parse).
 * symbols must be extractSymbolsWithNodes' output for the same tree, in the
 * order the rows get persisted — sourceSymbolIndex indexes into it.
 */
export function extractEdges(
  language: Language,
  tree: Parser.Tree,
  symbols: ExtractedSymbol[],
): EdgeInput[] {
  const knownNames = new Set(symbols.map((s) => s.input.name));
  const edges: { edge: EdgeInput; startIndex: number }[] = [];

  const push = (
    edgeType: EdgeType,
    targetName: string,
    node: Parser.SyntaxNode,
    options: { targetModule?: string | null; fileScope?: boolean; attributeFrom?: Parser.SyntaxNode } = {},
  ): void => {
    edges.push({
      startIndex: node.startIndex,
      edge: {
        sourceSymbolIndex: options.fileScope
          ? null
          : enclosingSymbolIndex(symbols, options.attributeFrom ?? node),
        edgeType,
        targetName,
        targetModule: options.targetModule ?? null,
        line: node.startPosition.row + 1,
      },
    });
  };

  // First pass: import locals extend the known-names set used for references
  // (a callback passed by its imported name is a reference too).
  const matches = runQuery(language, "edges", tree);
  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === "import.default" || capture.name === "import.namespace") {
        knownNames.add(capture.node.text);
      } else if (capture.name === "import.specifier") {
        const local = specifierLocalName(capture.node);
        if (local) knownNames.add(local);
      }
    }
  }

  for (const match of matches) {
    const byName = new Map(match.captures.map((c) => [c.name, c.node]));
    const source = byName.get("import.source");

    if (byName.has("call.callee")) {
      const node = byName.get("call.callee")!;
      push("calls", node.text, node);
    } else if (byName.has("call.method")) {
      const node = byName.get("call.method")!;
      push("calls", node.text, node);
    } else if (source && byName.has("import.specifier")) {
      // Edge carries the remote name (specifier name field) so import-based
      // resolution can match the named export; also skips the inline `type`
      // keyword an aliased capture text would include.
      const specifier = byName.get("import.specifier")!;
      const remote = specifier.childForFieldName("name");
      if (remote) push("imports", remote.text, specifier, { targetModule: moduleString(source), fileScope: true });
    } else if (source && byName.has("import.default")) {
      const node = byName.get("import.default")!;
      push("imports", node.text, node, { targetModule: moduleString(source), fileScope: true });
    } else if (source && byName.has("import.namespace")) {
      const node = byName.get("import.namespace")!;
      push("imports", node.text, node, { targetModule: moduleString(source), fileScope: true });
    } else if (byName.has("export.declaration")) {
      const declaration = byName.get("export.declaration")!;
      for (const name of declarationNames(declaration)) {
        push("exports", name, declaration, { fileScope: true });
      }
    } else if (byName.has("export.default")) {
      const node = byName.get("export.default")!;
      if (node.type === "identifier") push("exports", node.text, node, { fileScope: true });
    } else if (byName.has("export.specifier")) {
      const specifier = byName.get("export.specifier")!;
      const local = specifier.childForFieldName("name");
      if (local) {
        push("exports", local.text, specifier, { fileScope: true, targetModule: specifierSource(specifier) });
      }
    } else if (byName.has("export.cjs_module")) {
      const assignment = byName.get("export.cjs_module")!;
      const right = assignment.childForFieldName("right");
      if (right?.type === "identifier") {
        push("exports", right.text, assignment);
      } else if (right?.type === "object") {
        for (const prop of right.namedChildren) {
          if (prop.type === "shorthand_property_identifier") {
            push("exports", prop.text, prop, { attributeFrom: assignment });
          } else if (prop.type === "pair") {
            const value = prop.childForFieldName("value");
            if (value?.type === "identifier") push("exports", value.text, prop, { attributeFrom: assignment });
          }
        }
      }
    } else if (byName.has("export.cjs_named")) {
      const assignment = byName.get("export.cjs_named")!;
      const right = assignment.childForFieldName("right");
      if (right?.type === "identifier") push("exports", right.text, assignment);
    } else if (byName.has("extends.name")) {
      const node = byName.get("extends.name")!;
      push("extends", node.text, node);
    } else if (byName.has("implements.name")) {
      const node = byName.get("implements.name")!;
      push("implements", node.text, node);
    } else if (byName.has("reference.identifier")) {
      const node = byName.get("reference.identifier")!;
      if (knownNames.has(node.text)) push("references", node.text, node);
    }
  }

  edges.sort((a, b) => a.startIndex - b.startIndex);
  return edges.map((e) => e.edge);
}
