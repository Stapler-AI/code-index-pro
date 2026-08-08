# Product Requirements Document — code-index

> **Purpose of this document:** the single source for generating development tasks and the build plan. Every functional requirement is numbered, cites the architecture doc that specifies it in detail, and carries verifiable acceptance criteria. The architecture docs remain the design authority; this PRD sequences and scopes them.

## 1. Overview

AI coding agents burn their context window learning a codebase: `grep` returns walls of matches, and answering "what calls this?" means reading whole files at hundreds or thousands of tokens each. Most of that text is used for one judgment and then occupies context for the rest of the session.

**code-index** gives agents structural answers instead of raw text — file outlines, symbol lookups, caller lists, blast-radius analysis, module maps — each in tens of tokens, with a cheap drill-down path (`get_chunk`) when a body is genuinely needed.

The system ([architecture.md](architecture.md)):

- A **tree-sitter indexer** parses source files into a per-repo **SQLite** database of code chunks, symbols, and relationship edges, with an FTS5 mirror for ranked text search.
- **ast-grep** answers ad-hoc structural ("shape") queries against the live working tree.
- A **stdio MCP server** exposes it all as agent tools.

**Status:** design complete, implementation not started. The core index design (chunks, change detection, recovery) is ported from a working Swift/GRDB implementation; the symbol graph, FTS5, ast-grep integration, and MCP server are new design.

## 2. Goals

1. Answer an agent's structural questions (outline, definition, callers, dependencies, impact) in **milliseconds and tens of tokens** from the index.
2. Make every indexing run **incremental by default** via hash-based change detection; a full index is just a run against an empty database.
3. Guarantee a **freshness-safe path** (ast-grep over the working tree) alongside the fast possibly-stale index path.
4. Be **self-healing**: the database is a pure cache; corruption is handled by quarantine-and-rebuild, never repair.
5. Ship v1 for **JavaScript, TypeScript, and TSX**.

### Non-goals (v1) — from [architecture.md](architecture.md#non-goals)

- Semantic / embedding search.
- Type-checker-grade resolution (the graph is best-effort by design).
- Cross-repo indexing (one database, one repo).
- Being an editor service / LSP replacement.

## 3. Users & primary use cases

| User | Interface | Representative use |
|---|---|---|
| AI coding agent (Claude Code, etc.) | MCP tools | "Rename `replaceChunks` safely": `find_symbol` → `who_calls` → `get_chunk` → edit → `reindex`. ≈400 tokens vs ≈8,000 for grep-and-read ([worked example](mcp-server.md#example-agent-session)). |
| Developer operating the tool | CLI | `code-index index .`, `code-index stats`, `code-index serve .` |

## 4. Success metrics

- **Token efficiency:** the worked rename scenario completes in ≈400 tokens of tool responses (~20× under the read-everything baseline).
- **Latency:** index-backed queries (lookup, FTS, graph) answer in milliseconds; `search_structural` in seconds.
- **Incrementality:** re-indexing an unchanged repo performs zero row writes; changing one file re-indexes only that file plus affected edge re-resolution.
- **Robustness:** a corrupted or foreign database never crashes the server — it is quarantined and rebuilt automatically, and the event is reported.
- **Dogfood:** the tool indexes its own repository and answers the decision-matrix questions in [search.md](search.md#decision-matrix) correctly.

## 5. Functional requirements

### FR-100 Storage layer — spec: [schema.md](schema.md)

- **FR-101 Database location & lifecycle.** One SQLite database per indexed repo at `.code-index/index.db`, opened with `better-sqlite3`, pragmas `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`. `.code-index/` is excluded from indexing and expected to be gitignored.
- **FR-102 Core tables.** `indexed_files` and `code_chunks` exactly as specified in [schema.md](schema.md#core-tables-ported), including indexes, snake_case columns, ISO-8601 text timestamps, and integer booleans.
- **FR-103 Graph tables.** `symbols` and `edges` exactly as specified in [schema.md](schema.md#graph-tables-new), including `ON DELETE` behaviors (cascade from files; `SET NULL` for `symbols.chunk_id` and `edges.target_symbol_id`) and the four edge indexes.
- **FR-104 FTS5 mirror.** External-content FTS5 table `chunks_fts` over `content` + `node_name`, maintained by AFTER INSERT / AFTER DELETE triggers (the indexer never updates chunk rows). Queries use `bm25()` ranking and `snippet()` excerpts.
- **FR-105 Meta table.** `meta` key/value rows: `schema_version`, `repo_root`, `tool_version`. Mismatch (incompatible version, copied database) triggers rebuild.
- **FR-106 Migrations.** Numbered forward-only migrations tracked via `PRAGMA user_version`, each in its own transaction. A `user_version` higher than the tool knows ⇒ quarantine and rebuild. Migrations may be destructive (clear-and-mark-stale) because the database is a cache.
- **FR-107 Health check & recovery.** On every open: required tables exist, `PRAGMA quick_check` returns `ok`, meta values match. On failure: move `index.db` (+ `-wal`/`-shm`) to `index.db.quarantine-<ISO-timestamp>`, create fresh, run migrations, trigger full re-index, and surface the event via `index_status`.
- **FR-108 Write patterns.** `upsertFile`, `replaceChunks` (delete-then-insert), same-pattern graph-row replacement, and stale pruning — all per-file writes in one transaction so readers never see a half-indexed file.

**Acceptance criteria:** fresh database passes health check; a deliberately corrupted file is quarantined (sidecar files included) and rebuilt without error; FTS content stays consistent with `code_chunks` after insert/delete cycles; opening a database with a higher `user_version` rebuilds it.

### FR-200 Indexer pipeline — spec: [indexing.md](indexing.md)

- **FR-201 Discovery.** `git ls-files --cached --others --exclude-standard` from the repo root; glob-walk fallback for non-git directories (skipping `node_modules`, `.git`, hidden dirs, `.code-index`).
- **FR-202 Language detection.** By extension per the table in [indexing.md](indexing.md#language-detection). v1 languages: `javascript` (`js`, `mjs`, `cjs`, `jsx`), `typescript` (`ts`, `mts`, `cts`), `tsx` (`tsx`). Unrecognized extensions are skipped entirely.
- **FR-203 Change detection.** Skip files > 1 MB; skip non-UTF-8 (decode failure); SHA-256 of raw bytes; skip files whose `(relative_path, file_hash)` already matches an `indexed_files` row.
- **FR-204 Chunk extraction.** Recursive tree walk emitting a `code_chunks` row per node in the per-language meaningful-node-types allowlist (lists in [indexing.md](indexing.md#chunk-extraction)); `node_name` from the node's `name` field; `context_path` of meaningful ancestors joined with `" > "`; `depth` counting meaningful ancestors only; 1-indexed lines; byte offsets; content capped at 2000 chars with `...` appended. Nested meaningful nodes each get their own chunk.
- **FR-205 Stale pruning.** At the end of every run, delete `indexed_files` rows not seen during discovery; cascades remove their chunks, symbols, and edges.
- **FR-206 Pipeline shape.** discover → filter → hash/diff → parse → chunk → extract symbols & edges → resolve edges → persist → prune. One transaction per file for parse→persist; edge resolution runs once per run after all changed files are written.

**Acceptance criteria:** first run indexes all eligible files; immediate second run writes zero rows; editing one file re-indexes only it; deleting a file removes all its rows via cascade; a 1 MB+ file and a binary file are skipped; a non-git directory indexes via the fallback walker.

### FR-300 Symbol & edge extraction and resolution — spec: [indexing.md](indexing.md#symbol-and-edge-extraction-new), [ast-graph.md](ast-graph.md)

- **FR-301 Query files.** Per-language tree-sitter `.scm` files (`queries/{javascript,typescript}/{symbols,edges}.scm`) run against the same parse used for chunking (no second parse).
- **FR-302 Symbols.** Declarations → `symbols` rows: functions, classes, methods, exported consts/lets, interfaces, type aliases, enums. `kind` mapped from node type; one-line token-cheap `signature` (params + TS return annotation); `exported` set for ESM `export` and CJS `module.exports`; `chunk_id` linking to the body chunk when one exists.
- **FR-303 Edges.** Six directed types per the [edge model](ast-graph.md#edge-model): `calls` (callee identifier, or property name for `obj.method()`), `imports` (one edge per specifier, `target_module` = source string), `exports`, `references` (non-call identifier uses of known symbol names), `extends`, `implements`. Every edge records `source_file_id`, `source_symbol_id` (innermost enclosing symbol; `NULL` at file scope), `target_name` (always populated), `line`.
- **FR-304 Resolution pass.** After persisting the batch: (1) import-based — resolve the import specifier via simplified Node resolution (relative path + extension guessing `[.js, .ts, .tsx, /index.*]`), link the named or default export; (2) same-file declaration; (3) unique-name fallback across exported symbols repo-wide; (4) otherwise leave `target_symbol_id = NULL`. `package.json` `exports` maps and tsconfig path aliases are out of scope for v1.
- **FR-305 Incremental re-resolution invariant.** When file F is re-indexed: edges from F are dropped and re-extracted; edges elsewhere whose `target_name` matches any symbol name F gained or lost are re-resolved (via `idx_edges_target_name`).
- **FR-306 Documented limitations preserved.** No type inference; dynamic constructs invisible; re-exports/aliases followed one level; resolution repo-local ([indexing.md](indexing.md#known-limitations)). Consumers must treat unresolved edges as hints, not noise.

**Acceptance criteria:** for a fixture repo, extracted symbols/edges match expected rows; a cross-file call resolves via its import; an ambiguous method name stays unresolved; renaming an exported symbol in one file re-resolves inbound edges from other files without re-indexing them.

### FR-400 Query layer — spec: [search.md](search.md), [ast-graph.md](ast-graph.md#query-use-cases)

- **FR-401 Text search.** FTS5 `MATCH` over `content` + `node_name`, `bm25()` ranked, `snippet()` excerpts, exposing the FTS5 syntax subset (terms, phrases, prefix, `NEAR`, column filters). ~20 tokens per hit.
- **FR-402 Graph queries.** Implement the seven use-case queries from [ast-graph.md](ast-graph.md#query-use-cases): who-calls (including unresolved name-matches, flagged), outbound dependencies, transitive impact closure (recursive CTE, cycle-safe via `UNION`, depth-capped, default 3), file/module dependency map (aggregating `target_module` so unresolved edges still count), class hierarchy (ancestors and descendants, depth-capped), dead exports (excluding symbols possibly targeted by unresolved edges), file outline.
- **FR-403 Result envelope.** All modes return the shared shape `{path, lines, preview, id}` ([search.md](search.md#result-normalization)); `id` present for index-backed results only. Graph results are `{id, name, kind, signature, path, line}` tuples — never bodies. Unresolved matches carry `resolved: false`.
- **FR-404 Caps.** Depth and count limits are first-class parameters (limit default 20–50); every truncated response says so.

**Acceptance criteria:** each decision-matrix row in [search.md](search.md#decision-matrix) is answerable by the named tool against a fixture repo; a cyclic call graph terminates with correct distances; the dead-exports query does not flag symbols matched by unresolved edges.

### FR-500 Structural search (ast-grep) — spec: [search.md](search.md#structural-search-ast-grep)

- **FR-501 Invocation.** Shell out to the `ast-grep` CLI with `--json`: `ast-grep run --pattern … --lang …` for single-node patterns; `ast-grep scan --inline-rules …` for YAML rules. Parses the live working tree — never the database.
- **FR-502 Scope control.** Accept a `paths` filter; optionally pre-filter candidate files via the index (language, FTS keyword) before invoking ast-grep.
- **FR-503 Missing-binary handling.** A distinguishable error when `ast-grep` is not on PATH; it is a runtime prerequisite for this tool only.

**Acceptance criteria:** a pattern query and an inline-rules query both return normalized results; an edit made after the last index run is found (freshness guarantee); with the binary absent, the error names the missing prerequisite while all other tools keep working.

### FR-600 MCP server — spec: [mcp-server.md](mcp-server.md)

- **FR-601 Server.** Stdio MCP server on `@modelcontextprotocol/sdk`; one instance per repo, repo root as startup argument. On startup: open with health check/recovery, then kick off an incremental reindex in the background without blocking the first tool call.
- **FR-602 Tool catalog.** All 11 tools with the params/returns in the [catalog](mcp-server.md#tool-catalog): `index_status`, `reindex`, `search_code`, `search_structural`, `get_chunk`, `file_outline`, `find_symbol`, `who_calls`, `get_dependencies`, `impact_of_change`, `module_map`.
- **FR-603 Design rules.** Summaries by default, bodies only via `get_chunk`; every list capped/paginated with `truncated` flags; every result carries an id and `path` + line range.
- **FR-604 Staleness & confidence signals.** Every index-backed response includes `index_age_seconds` (`search_structural` exempt); graph tools include unresolved-edge counts; `index_status` reports quarantine/rebuild events.

**Acceptance criteria:** the server registers via `.mcp.json` / `claude mcp add` as shown in [mcp-server.md](mcp-server.md#registration); the worked rename session executes end-to-end with responses matching the documented shapes; first tool call succeeds while startup reindex is still running.

### FR-700 CLI — spec: [indexing.md](indexing.md#cli-entry-points-planned)

- **FR-701** `code-index index [path]` — incremental run; `--full` clears first.
- **FR-702** `code-index stats` — files/chunks/symbols per language, unresolved-edge count, last run.
- **FR-703** `code-index clear` — delete all rows (or the whole `.code-index/` directory).
- **FR-704** `code-index serve [path]` — start the MCP server.
- **FR-705** Package exposes a `code-index` bin so `npx code-index …` works. (`watch` is future work, not v1.)

**Acceptance criteria:** the three README quick-start commands work against a real repo; `index --full` rebuilds from empty; `stats` output matches database contents.

## 6. Technical requirements

| Area | Requirement | Source |
|---|---|---|
| Implementation language | **TypeScript** (project decision, 2026-08-07 — docs previously said only "Node.js") | this PRD |
| Runtime | Node.js | README |
| SQLite driver | `better-sqlite3` (synchronous; `node:sqlite` noted as future migration) | [decision log #1](architecture.md#decision-log) |
| Parsing | `tree-sitter` + `tree-sitter-javascript` (installed) + `tree-sitter-typescript` (provides `typescript` and `tsx`) | [indexing.md](indexing.md#language-detection) |
| MCP | `@modelcontextprotocol/sdk`, stdio transport | [mcp-server.md](mcp-server.md) |
| ast-grep | CLI shell-out with `--json`; runtime prerequisite for `search_structural` only — never a hard install dependency | [decision log #3](architecture.md#decision-log) |
| Conventions | snake_case columns, ISO-8601 text timestamps, integer booleans; **not** interchangeable with the Swift reference database | [schema.md](schema.md#conventions) |
| Data stance | The database is a cache, never a source of truth; rebuild is always acceptable; no repair paths | [decision log #9](architecture.md#decision-log) |
| Testing | Automated tests per milestone against fixture repos; acceptance criteria in this PRD are the definitions of done | this PRD |

## 7. Milestones

Ordered so each milestone depends only on earlier ones. A milestone is done when its FRs' acceptance criteria pass in automated tests.

| # | Milestone | Delivers | FRs |
|---|---|---|---|
| **M1** | Scaffolding + storage layer | TypeScript setup, deps, test runner; schema, migrations, FTS triggers, health check, quarantine-and-rebuild, write patterns | FR-101–108 |
| **M2** | Indexer pipeline + basic CLI | Discovery, language detection, hashing, chunk extraction, stale pruning; `index` / `stats` / `clear` commands | FR-201–206, FR-701–703, FR-705 |
| **M3** | Symbol graph | `.scm` extraction, symbols/edges population, two-phase resolution, incremental re-resolution | FR-301–306 |
| **M4** | Query layer | FTS search, seven graph queries, shared envelope, caps/truncation | FR-401–404 |
| **M5** | MCP server | All 11 tools, startup reindex, staleness/confidence signals, registration; `serve` command | FR-601–604, FR-704 |
| **M6** | Structural search | ast-grep shell-out, scope control, missing-binary error | FR-501–503 |
| **M7** | Hardening & dogfood | End-to-end recovery drills, limit/truncation audits, self-index this repo, README/doc sync, worked-example validation | success metrics §4 |

Note: M6 depends only on M5's server shell (tool registration), not on the index — it can be built in parallel with M3/M4 if desired.

## 8. Known limitations & risks

**Accepted design limitations** (must be documented in tool responses/docs, not "fixed"):

- No type inference — `obj.method()` resolves by name only; ambiguous names stay unresolved ([indexing.md](indexing.md#known-limitations)).
- Dynamic constructs (computed calls, `require(variable)`, non-literal `import()`) are invisible to the graph.
- Re-exports and import aliases followed one level only.
- Resolution is repo-local; edges into `node_modules` stay unresolved with `target_module` populated.
- 2000-char chunk cap makes text beyond the cap invisible to `search_code`; byte offsets and `search_structural` are the fallback ([indexing.md](indexing.md#chunk-extraction)).

**Delivery risks:**

- Native module builds (`tree-sitter`, `better-sqlite3`) across Node versions/platforms — pin versions early, verify in CI.
- tree-sitter grammar quirks between `typescript` and `tsx` grammars — cover both in fixtures.
- `ast-grep` CLI output format drift — pin a minimum version, test against `--json` output.

## 9. Out of scope / future work

- Staged languages: JSON, Python, C, HTML, Bash, CSS, Swift (each needs a grammar dep, allowlist, and `.scm` files).
- `code-index watch` (fs-events incremental re-index).
- End-to-end agent benchmark suite (Claude Code & Codex, with vs. without the tools) — designed in [benchmark.md](benchmark.md); runnable after M5.
- Type-aware resolution via the TypeScript compiler API; full re-export/alias chains.
- Embedding-based semantic search.
- `node:sqlite` migration; `@ast-grep/napi` if structural search becomes a hot path.
- Cross-repo indexing.
