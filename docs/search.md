# Search & Retrieval

The query layer offers three retrieval modes. Which one an agent (or the MCP server on its behalf) should use depends on what the agent already knows:

| Mode | You know… | Backed by | Freshness | Cost |
|---|---|---|---|---|
| **Indexed lookup** | a *name* (`find_symbol`, `who_calls`, `file_outline`) | `symbols` / `edges` tables | as of last index | ~ms, tens of tokens |
| **Text search** | a *keyword* (`search_code`) | FTS5 over `code_chunks` | as of last index | ~ms, tens of tokens |
| **Structural search** | a *shape* (`search_structural`) | ast-grep over the working tree | **live** | ~seconds, tens of tokens |

All three exist because each answers questions the others can't — and all three replace the token-expensive baseline of `grep` + reading whole files into context.

## Text search (FTS5)

`search_code` runs an FTS5 `MATCH` over chunk `content` and `node_name` (schema and triggers in [schema.md](schema.md#full-text-search-new)), ranked by `bm25()`, with `snippet()` excerpts.

Query syntax exposed to agents (FTS5 subset):

- `parse chunk` — both terms, any order
- `"replace chunks"` — phrase
- `pars*` — prefix
- `NEAR(hash detect, 10)` — proximity
- `content: cache` — column filter

Result shape (per hit, ~20 tokens): `{chunk_id, path, start_line, end_line, node_type, node_name, context_path, excerpt}`. Full body via `get_chunk(chunk_id)`.

**Known blind spot:** chunk content is capped at 2000 chars ([indexing.md](indexing.md#chunk-extraction)), so text beyond the cap in a very large function is unsearchable. Fallback: `search_structural` or plain grep on the working tree.

## Structural search (ast-grep)

`search_structural` answers *shape* questions no text search can express — "async functions without try/catch", "calls to `fetch` with a hardcoded URL", "components that use `useEffect` with an empty dependency array".

### Position in the architecture

ast-grep runs **against the working tree, not the database**:

- It is the **freshness-guaranteed** path — it sees edits made seconds ago that the index hasn't absorbed.
- It parses files on every query, so it costs seconds instead of milliseconds — fine for targeted questions, wrong for "orient me in this repo" (use the index for that).
- It needs no schema support: any pattern the grammar can express works today, including things the index deliberately doesn't model.

### Invocation

The MCP server shells out to the `ast-grep` CLI with `--json` (decision: CLI over `@ast-grep/napi` — see [decision log](architecture.md#decision-log); `ast-grep` becomes a runtime prerequisite for this one tool).

- Simple, single-node patterns → `ast-grep run --pattern '<p>' --lang <lang> --json <paths>`
- Complex shapes → `ast-grep scan --inline-rules '<yaml>' --json <paths>`

Pattern-vs-rule guidance (condensed from the ast-grep skill reference):

- Use a **pattern** for direct code shapes: `console.log($ARG)`, `await $EXPR`.
- Use a **YAML rule** (`kind` + relational `has`/`inside`, composite `all`/`any`/`not`) for contextual shapes — and always set `stopBy: end` on relational rules so traversal doesn't stop at the first non-matching child:

```yaml
id: async-no-trycatch
language: javascript
rule:
  all:
    - kind: function_declaration
    - has: { pattern: await $EXPR, stopBy: end }
    - not:
        has: { pattern: "try { $$$ } catch ($E) { $$$ }", stopBy: end }
```

### Scope control

`search_structural` accepts a `paths` filter. Additionally, the server can use the index to **pre-filter candidates** before invoking ast-grep — e.g. restrict to files of the pattern's language, or to files matching an FTS keyword first — turning a whole-repo parse into a dozen-file parse.

## Decision matrix

| The agent's question | Use | Why |
|---|---|---|
| "Where is `upsertFile` defined?" | `find_symbol` | Name known → direct lookup, no noise |
| "What calls `replaceChunks`?" / "what breaks if I change it?" | `who_calls` / `impact_of_change` | Connectivity question → graph |
| "What's in this file?" | `file_outline` | Skeleton beats reading 500 lines |
| "Where do we handle cache corruption?" | `search_code` | Fuzzy keyword → FTS ranking |
| "Which async functions lack error handling?" | `search_structural` | Shape question — index doesn't model it |
| "Find calls to `exec` with template literals" | `search_structural` | Argument-shape question |
| Anything about a file **edited moments ago** | `search_structural`, or `reindex` first | Index may be stale; ast-grep reads the live tree |
| "How is this repo organized?" | `index_status` + `module_map` | Orientation → aggregates, not search |

## Result normalization

All three modes return the same envelope, so agents learn one shape:

```json
{
  "path": "src/db/writer.js",
  "lines": [42, 68],
  "preview": "replaceChunks(fileId, chunks)",
  "id": 1234
}
```

- `preview` is a signature (lookup), snippet (FTS), or matched text (ast-grep).
- `id` (chunk or symbol id) is present for index-backed results and enables drill-down; ast-grep results omit it and agents fall back to reading the line range.
- Every list is capped and reports truncation ([mcp-server.md](mcp-server.md#design-rules)).
