import type { OutlineRow, SymbolTuple } from "./graph";
import type { SearchHit } from "./search";

/**
 * Result normalization (FR-403, search.md#result-normalization). All
 * retrieval modes return the same envelope so agents learn one shape:
 * {path, lines, preview, id}.
 *
 * - preview is a signature (lookup), snippet (FTS), or matched text
 *   (ast-grep, M6).
 * - id (chunk or symbol id) is present only for index-backed results;
 *   ast-grep results omit it and agents read the line range instead.
 * - resolved: false is present exactly on unresolved name-match hints
 *   (ast-graph.md: include them flagged, never drop them). Resolved
 *   results carry no resolved key.
 * - Envelopes never carry bodies — drill down via get_chunk.
 */
export interface ResultEnvelope {
  path: string;
  lines: [number, number];
  preview: string;
  id?: number;
  resolved?: false;
}

/** FTS hit → envelope: the snippet is the preview, the chunk id drills down. */
export function envelopeFromSearchHit(hit: SearchHit): ResultEnvelope {
  return {
    path: hit.path,
    lines: [hit.startLine, hit.endLine],
    preview: hit.excerpt,
    id: hit.chunkId,
  };
}

/**
 * Symbol tuple (find_symbol, who_calls, impact, hierarchy, dead exports) →
 * envelope: the signature is the preview (name when signature is null).
 * Tuples carrying a full span (endLine) produce a real range; call-site rows
 * (who_calls) legitimately collapse to a single line.
 */
export function envelopeFromSymbol(
  tuple: SymbolTuple & { resolved?: boolean; endLine?: number },
): ResultEnvelope {
  const envelope: ResultEnvelope = {
    path: tuple.path,
    lines: [tuple.line, tuple.endLine ?? tuple.line],
    preview: tuple.signature ?? tuple.name,
    id: tuple.id,
  };
  if (tuple.resolved === false) envelope.resolved = false;
  return envelope;
}

/** Outline row → envelope (the outline's file provides the path). */
export function envelopeFromOutline(path: string, row: OutlineRow): ResultEnvelope {
  return {
    path,
    lines: [row.startLine, row.endLine],
    preview: row.signature ?? row.name,
    id: row.id,
  };
}
