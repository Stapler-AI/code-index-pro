import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Parser from "tree-sitter";
import { grammarFor } from "../pipeline/chunks";
import type { Language } from "../pipeline/language";

/**
 * Tree-sitter query layer (FR-301, indexing.md#symbol-and-edge-extraction-new).
 * Loads the per-language .scm files and runs them against the parse tree that
 * chunking already produced — extraction never re-parses.
 *
 * Capture contract (consumed by FR-302/FR-303 extraction):
 * - symbols.scm: @definition.<kind> on the declaration node, @name on its name.
 * - edges.scm: @call.callee/@call.method, @import.default/@import.specifier/
 *   @import.namespace with @import.source, @export.declaration/@export.default/
 *   @export.specifier/@export.source/@export.cjs_module/@export.cjs_named/
 *   @export.cjs_name, @extends.name, @implements.name, @reference.identifier.
 * - Captures starting with "_" only anchor predicates; ignore them.
 * - An inline type specifier captures as "type Row" (keyword included);
 *   consumers must strip the leading "type ".
 */

export type QueryName = "symbols" | "edges";

// tsx shares the typescript query files but compiles against its own grammar.
const QUERY_DIRS: Record<Language, string> = {
  javascript: "javascript",
  typescript: "typescript",
  tsx: "typescript",
};

// queries/ sits at the package root, one level above both src/ and dist/.
const QUERIES_ROOT = resolve(__dirname, "..", "..", "queries");

const compiled = new Map<string, Parser.Query>();

export function queryPath(language: Language, name: QueryName): string {
  return join(QUERIES_ROOT, QUERY_DIRS[language], `${name}.scm`);
}

/** Compile (and cache) a query file against the language's own grammar. */
export function loadQuery(language: Language, name: QueryName): Parser.Query {
  const key = `${language}:${name}`;
  let query = compiled.get(key);
  if (!query) {
    query = new Parser.Query(grammarFor(language), readFileSync(queryPath(language, name), "utf8"));
    compiled.set(key, query);
  }
  return query;
}

/** Run a query over an existing tree; no parsing happens here. */
export function runQuery(language: Language, name: QueryName, tree: Parser.Tree): Parser.QueryMatch[] {
  return loadQuery(language, name).matches(tree.rootNode);
}
