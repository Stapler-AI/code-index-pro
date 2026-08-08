# MCP Server

The agent-facing surface: a **stdio MCP server** (built on `@modelcontextprotocol/sdk`) exposing the [query layer](search.md) and [graph](ast-graph.md) as tools. One server instance per repository; the repo root is a startup argument.

Startup behavior:

1. Open the database with [health-check/recovery](schema.md#health-check-and-recovery).
2. Kick off an incremental [reindex](indexing.md) in the background so the index converges toward fresh without blocking the first tool call.

## Design rules

Every tool obeys these; they are what makes the server token-cheap:

- **Summaries by default, bodies on demand.** List results carry names, signatures, paths, and line ranges — never full source. `get_chunk` is the single drill-down primitive.
- **Every list is capped and paginated** (`limit` param, default 20–50 per tool; responses include `truncated: true` and a cursor when applicable).
- **Every result carries an id** (chunk or symbol) so the next question needs no re-search.
- **Every result carries `path` + line range** so the agent can always fall back to reading the exact file slice with its own tools.

## Tool catalog

| Tool | Params | Returns | Token rationale |
|---|---|---|---|
| `index_status` | — | files/chunks/symbols per language, unresolved-edge count, last index time, recovery notices | Repo orientation in ~50 tokens |
| `reindex` | `full?: boolean` | delta: files added/updated/removed, duration | Keeps every other tool trustworthy after edits |
| `search_code` | `query`, `limit?`, `path_prefix?` | ranked chunk summaries with snippets ([envelope](search.md#result-normalization)) | Replaces grep + open-file loops; ~20 tokens/hit vs. whole files |
| `search_structural` | `pattern` or `rule` (YAML), `lang`, `paths?` | ast-grep matches: path, lines, matched text | Answers shape questions without the agent reading candidate files; live working tree |
| `get_chunk` | `chunk_id` | one chunk's stored content + metadata | Drill-down: one function body, not one file |
| `file_outline` | `path` | ordered symbol skeleton: names, kinds, signatures, line ranges, exported flags | A 500-line file becomes ~30 lines |
| `find_symbol` | `name`, `kind?`, `path_prefix?` | symbol summaries | Direct navigation without search noise |
| `who_calls` | `symbol_id` or `name`, `limit?` | inbound `calls`/`references` edges with caller signatures; unresolved matches flagged | The pre-edit safety question, answered as a list |
| `get_dependencies` | `symbol_id` or `path` | outbound edges: calls, imports (with `target_module`) | "What does this rely on" without reading it |
| `impact_of_change` | `symbol_id`, `max_depth?` (default 3) | transitive callers grouped by file, with distance | Blast radius in one call instead of N greps |
| `module_map` | `path_prefix?` | file-level import graph (edge list, mermaid-ready) | Whole-architecture picture in ~100 tokens |

## Error and staleness behavior

- Every response includes `index_age_seconds` so the agent knows how stale index-backed answers may be; `search_structural` is exempt (always live).
- Graph tools include `unresolved_edges` counts for the traversed region — the agent's confidence signal ([why edges go unresolved](indexing.md#known-limitations)).
- If the database failed health check and was rebuilt, `index_status` reports the quarantine event.
- `search_structural` returns a distinguishable error when the `ast-grep` binary is missing (it is the only tool requiring it).

## Example agent session

Task: *"rename `replaceChunks` to `replaceFileChunks` safely."*

```
→ find_symbol { name: "replaceChunks" }
← 1 hit: {id: 812, kind: "method", signature: "replaceChunks(fileId, chunks)",
          path: "src/db/writer.js", lines: [42, 68]}          (~40 tokens)

→ who_calls { symbol_id: 812 }
← 3 callers: indexFile (src/indexer/run.js:118), rebuild (src/indexer/run.js:201),
             test "replaces chunks" (test/db.test.js:77)       (~80 tokens)

→ get_chunk { chunk_id: 3401 }        // body of indexFile call site
← 26-line function body                                        (~250 tokens)

→ (agent edits 4 sites, then) reindex {}
← { updated: 3, duration_ms: 240 }
```

**≈ 400 tokens** of context consumed. The read-everything baseline — grep for `replaceChunks`, open `writer.js` (300 lines), `run.js` (250 lines), `db.test.js` (200 lines) — is **≈ 8,000 tokens**, a ~20× difference, growing with repo size.

## Registration

In the target repo:

```jsonc
// .mcp.json in the target repo
{
  "mcpServers": {
    "code-index": {
      "command": "npx",
      "args": ["code-index", "serve", "."]
    }
  }
}
```

or `claude mcp add code-index -- npx code-index serve .`

Skill templates and full integration guidance (Claude Code, Codex, sandbox caveats, distribution roadmap): [agent-skills.md](agent-skills.md).
