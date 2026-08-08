---
name: code-index
description: >-
  Navigate and analyze a codebase with the code-index MCP tools. Use this skill
  whenever you need to orient in an unfamiliar repo, find where a symbol is
  defined or which code calls it, assess the blast radius of a change before you
  edit, search code by keyword or by AST shape, or rename/refactor a symbol
  safely. The index answers structural questions (outlines, callers,
  dependencies, impact) in tens of tokens where grep-and-read costs thousands.
---

# code-index

Structural questions cost tens of tokens through the index and thousands through
grep-and-read — prefer the index whenever the routing table below matches, and
fall back to the baseline tools (Read/Grep/Glob/Bash) only where noted.

## Session opener

Open any code-navigation session with `index_status` **once**. It reports index
freshness, unresolved-edge counts, and any recovery events, and confirms the
server is registered. If it errors, the server is unavailable — fall back to
Read/Grep/Glob for the whole session; do not retry in a loop.

## Routing table

| Your question | Use | Not |
|---|---|---|
| "How is this repo organized?" | `index_status` + `module_map { path_prefix? }` | Walking directories |
| "Where is `X` defined?" | `find_symbol { name }` | Grep |
| "What calls `X`?" | `who_calls { symbol_id or name }` | Grep |
| "What breaks if I change `X`?" | `impact_of_change { symbol_id }` | N greps |
| "What does `X` / this file depend on?" | `get_dependencies { symbol_id or path }` | Reading imports |
| "What's in this file?" | `file_outline { path }` | Reading the file |
| "Where do we handle <concept>?" | `search_code { query }` (FTS phrases, `prefix*`, `NEAR()`) | Grep |
| "Which code matches <shape>?" | `search_structural { pattern or rule }` | Regex |
| "Give me one body" | `get_chunk { chunk_id }` | Reading the whole file |

## Hard budget rules

Every extra turn re-pays the whole context, and one full-file read erases the
savings of many index calls. These are prohibitions, not preferences:

- **No full-file `Read` after an index hit.** Every index result carries an id and
  a line range — fetch one body with `get_chunk { chunk_id }`, or Read only the
  returned line range. Never follow a hit with a whole-file Read.
- **No file content through Bash.** Do not `cat`, `sed`, or `head` a file when an
  index tool or a ranged Read answers the question.
- **No Grep for an index-resolvable symbol.** `find_symbol` / `who_calls` already
  know the name. Grep is for non-JS/TS files and post-`search_structural` ranges.
- **Batch independent index calls in one turn.** When lookups don't depend on each
  other, issue them together — do not spend one turn per call.
- **Answer when answered.** When the tools have resolved the question, answer from
  their output. No confirmation re-reads, no summary tour of files you understand.

## Recipes

Each recipe names the full call chain, its turn budget, and its stop condition.

**Orientation (1–2 turns).** `index_status` → `module_map { path_prefix? }` →
`file_outline` on the entry points the map surfaces, batching the outlines in one
turn. Stop once the map and outlines name the pieces you need.

**Symbol lookup (1 turn).** `find_symbol { name }` → answer from the returned
signature and location. Call `get_chunk { chunk_id }` only if the body is truly
needed. Stop as soon as the signature answers the question.

**Callers / impact (1–2 turns).** `find_symbol { name }` → `who_calls { symbol_id }`
or `impact_of_change { symbol_id, max_depth }` → answer from the caller list.
Corroboration rule: if `unresolved_edges` is high, the graph may be missing
callers — widen with `search_code { query }` before asserting "no callers". Stop
once the list (corroborated if needed) is complete.

**Concept localization (2 turns).** `search_code { query, path_prefix? }` using FTS
phrases, `prefix*`, or `NEAR()` and a `path_prefix` to scope → `get_chunk` on the
top hit(s) → answer. Stop once the top hits confirm where the concept lives.

**Cross-file trace (2–3 turns).** `find_symbol` at the entry point → alternate
`get_dependencies { symbol_id }` and `who_calls { symbol_id }` hops, batching
independent hops in a turn → `get_chunk` at most once per hop, and only when the
next-hop decision needs a body. Stop when the path from entry to target is known.

**Rename / refactor (edit-count + 2 turns).** `find_symbol { name }` →
`impact_of_change { symbol_id }` → edit every site → `reindex {}` (incremental,
fast) → re-run `who_calls` / `search_code` on the **old** name to prove zero
stragglers remain. Stop once the old name resolves to nothing.

**Shape queries (1–2 turns).** `search_structural { pattern or rule }` — a direct
shape as a `pattern` (e.g. `await $EXPR`), a contextual shape as a YAML `rule` with
`stopBy: end` on relational clauses — scoped with `paths` to keep the parse small.
Results carry no chunk id, so read only the returned line ranges. Stop once the
matches answer the question.

## Fallback & confidence rules

- **`unresolved_edges` is a confidence meter.** A high count means callers may be
  missing from the graph — corroborate with `search_code` before claiming a
  negative like "nothing calls this".
- **Trust freshness, reindex after edits.** Index-backed answers carry
  `index_age_seconds`. After editing, run `reindex {}` before trusting graph
  results; `search_structural` reads the live working tree and needs no reindex.
- **Fall back deliberately.** Use Read/Grep/Glob for non-JS/TS files, for content
  beyond the 2000-character chunk cap, and to read `search_structural` line ranges
  (no chunk id). If `search_structural` reports the ast-grep binary is missing, use
  Grep for that one query — every other tool still works.
