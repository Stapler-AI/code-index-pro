import type { PipelineHooks } from "../pipeline/run";
import { extractEdges } from "./edges";
import { resolveEdges } from "./resolve";
import { extractSymbolsWithNodes } from "./symbols";

/**
 * The M3 graph hooks (FR-301..FR-304): symbol & edge extraction against the
 * chunking parse tree, and the post-persist resolution pass. Plugged into
 * runPipeline by the CLI (and later the MCP server).
 */
export const graphHooks: PipelineHooks = {
  extract: ({ language, content, tree, chunks }) => {
    const symbols = extractSymbolsWithNodes(language, content, tree, chunks);
    return { symbols: symbols.map((s) => s.input), edges: extractEdges(language, tree, symbols) };
  },
  resolve: resolveEdges,
};
