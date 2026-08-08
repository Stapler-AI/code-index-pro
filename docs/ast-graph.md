# AST Graph

The code graph answers *"how is this connected"* — the question an agent actually has before editing. The flat chunk table (ported from the Swift reference) answers *"what's here"*; the graph is the new layer on top: who calls X, what breaks if Y changes, how modules depend on each other.

The graph is **not a separate store**. It is two SQLite tables — [`symbols` and `edges`](schema.md#graph-tables-new) — queried with joins and recursive CTEs. At repo scale (10⁴–10⁵ symbols) this is fast, keeps the system to one file and one driver, and needs no graph database.

## Node model

Two node kinds:

- **Symbols** — rows in `symbols`: named declarations with a `kind` (`function`, `class`, `method`, `variable`, `interface`, `type_alias`, `enum`, `module`), a line range, an `exported` flag, and a one-line `signature`.
- **Files** — rows in `indexed_files`, acting as module nodes. File-scope edges (top-level imports/exports) attach here via `source_file_id` with `source_symbol_id IS NULL`.

The `signature` field is the token-cheap default representation: graph queries return signatures, never bodies. `chunk_id` links a symbol to its chunk for drill-down via `get_chunk`.

JS/TS mapping examples:

| Source | `kind` | `signature` |
|---|---|---|
| `function parseFile(path, opts) {…}` | `function` | `parseFile(path, opts)` |
| `class Indexer extends Base {…}` | `class` | `class Indexer extends Base` |
| `save(force: boolean): Promise<void>` (method) | `method` | `save(force: boolean): Promise<void>` |
| `export const MAX_SIZE = 1_000_000` | `variable` | `MAX_SIZE = 1_000_000` |
| `interface ChunkRow {…}` | `interface` | `interface ChunkRow` |

## Edge model

Six directed edge types. Every edge carries `target_name` (the identifier as written — always present) and optionally `target_symbol_id` (set only when [resolution](indexing.md#edge-resolution) succeeded).

| `edge_type` | From → To | Produced by (JS/TS) |
|---|---|---|
| `imports` | file → symbol or module | `import { upsertFile } from './db'` — one edge per specifier, `target_module = './db'` |
| `exports` | file → own symbol | `export function parse…`, `module.exports = …` |
| `calls` | symbol → symbol | `upsertFile(row)` inside `indexFile` ⇒ `indexFile —calls→ upsertFile` |
| `references` | symbol → symbol | non-call identifier use: `arr.map(parseRow)` ⇒ `—references→ parseRow` |
| `extends` | class → class | `class Indexer extends Base` |
| `implements` | class → interface (TS) | `class Store implements Cache` |

**Resolved vs. unresolved.** `target_symbol_id IS NULL` means the resolver couldn't (or shouldn't) link the edge: external package, dynamic call, ambiguous name. Consumers must treat unresolved edges as *hints*, not noise — a caller list should include unresolved name-matches, flagged as such, rather than silently dropping them. Graph tools report unresolved counts so agents know the confidence level ([mcp-server.md](mcp-server.md#error-and-staleness-behavior)).

## Construction

Symbols and edges are extracted during indexing by per-language tree-sitter `.scm` queries, then linked by a two-phase resolution pass — details in [indexing.md](indexing.md#symbol-and-edge-extraction-new). Flavor of the query layer, for JS calls:

```scheme
; queries/javascript/edges.scm — direct calls and method calls
(call_expression
  function: (identifier) @call.callee)

(call_expression
  function: (member_expression
    property: (property_identifier) @call.method))
```

## Query use-cases

The concrete questions the design must support, each with its SQL sketch. All transitive queries are **depth-capped** and **cycle-safe** (`UNION`, not `UNION ALL`, deduplicates visited nodes).

### Who calls X (direct)

```sql
SELECT s.id, s.name, s.kind, s.signature, f.relative_path, e.line
FROM edges e
JOIN symbols s       ON s.id = e.source_symbol_id
JOIN indexed_files f ON f.id = e.source_file_id
WHERE e.edge_type IN ('calls', 'references')
  AND (e.target_symbol_id = :symbol_id
       OR (e.target_symbol_id IS NULL AND e.target_name = :symbol_name));
```

The `target_name` arm keeps unresolved-but-matching callers visible (flagged in results).

### What does X call / use (outbound)

```sql
SELECT e.edge_type, e.target_name, e.target_module, e.line,
       t.id, t.kind, t.signature, tf.relative_path
FROM edges e
LEFT JOIN symbols t        ON t.id = e.target_symbol_id
LEFT JOIN indexed_files tf ON tf.id = t.file_id
WHERE e.source_symbol_id = :symbol_id;
```

### Impact of changing X (transitive inbound closure)

```sql
WITH RECURSIVE impact(id, depth) AS (
  SELECT :symbol_id, 0
  UNION
  SELECT e.source_symbol_id, impact.depth + 1
  FROM edges e
  JOIN impact ON e.target_symbol_id = impact.id
  WHERE e.source_symbol_id IS NOT NULL
    AND e.edge_type IN ('calls', 'references', 'extends', 'implements')
    AND impact.depth < :max_depth          -- default 3
)
SELECT DISTINCT s.id, s.name, s.kind, s.signature, f.relative_path, MIN(impact.depth) AS distance
FROM impact
JOIN symbols s       ON s.id = impact.id
JOIN indexed_files f ON f.id = s.file_id
WHERE impact.id != :symbol_id
GROUP BY s.id
ORDER BY distance, f.relative_path;
```

Served by the `impact_of_change` tool, grouped by file.

### File / module dependency map

Aggregates `imports` edges to file granularity — works even when individual edges are unresolved, because `target_module` is always recorded:

```sql
SELECT f.relative_path AS from_file,
       COALESCE(tf.relative_path, e.target_module) AS to_module,
       COUNT(*) AS import_count
FROM edges e
JOIN indexed_files f        ON f.id = e.source_file_id
LEFT JOIN symbols t         ON t.id = e.target_symbol_id
LEFT JOIN indexed_files tf  ON tf.id = t.file_id
WHERE e.edge_type = 'imports'
GROUP BY from_file, to_module;
```

Served by `module_map`; renders directly as a mermaid `flowchart`.

### Class hierarchy of T

```sql
WITH RECURSIVE ancestry(id, depth) AS (
  SELECT :class_id, 0
  UNION
  SELECT e.target_symbol_id, ancestry.depth + 1
  FROM edges e JOIN ancestry ON e.source_symbol_id = ancestry.id
  WHERE e.edge_type IN ('extends', 'implements')
    AND e.target_symbol_id IS NOT NULL AND ancestry.depth < 10
)
SELECT s.id, s.name, s.kind, s.signature, f.relative_path
FROM ancestry JOIN symbols s ON s.id = ancestry.id
JOIN indexed_files f ON f.id = s.file_id;
```

(Descendants: same shape with source/target swapped.)

### Dead exports

Exported symbols with no inbound resolved edge — refactoring candidates:

```sql
SELECT s.id, s.name, s.kind, s.signature, f.relative_path
FROM symbols s
JOIN indexed_files f ON f.id = s.file_id
WHERE s.exported = 1
  AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_symbol_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM edges e
                  WHERE e.target_symbol_id IS NULL AND e.target_name = s.name);
```

The second `NOT EXISTS` avoids flagging symbols that unresolved edges *might* target. Results are still best-effort (entry points and externally-consumed APIs look "dead").

### File outline

Not a graph traversal, but served from `symbols` — the skeleton of one file:

```sql
SELECT id, name, kind, signature, start_line, end_line, exported
FROM symbols
WHERE file_id = (SELECT id FROM indexed_files WHERE relative_path = :path)
ORDER BY start_line;
```

## Result shaping for token efficiency

Rules every graph query obeys:

- Results are `{id, name, kind, signature, path, line}` tuples — **never bodies**. A body is one `get_chunk` call away via the symbol's `chunk_id`.
- Depth (`max_depth`, default 3) and count (`limit`, default 50) caps are first-class parameters, and responses say when they truncated.
- Unresolved-edge matches are included but flagged (`resolved: false`).

## Future work (explicitly out of scope for v1)

- Type-aware resolution via the TypeScript compiler API (would fix method-call ambiguity).
- Full re-export/alias chains.
- Embedding-based semantic neighbors.
