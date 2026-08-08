# code-index-dev

Development tools that give AI coding agents architectural understanding of a codebase — at a fraction of the token cost of text search and full-file reads.

## How it works

- **tree-sitter** parses source files into a per-repo **SQLite index** of code chunks plus a **symbol graph** (who calls what, who imports what, what extends what).
- **ast-grep** handles ad-hoc structural queries against the live working tree ("async functions without try/catch") that no text search can express.
- An **MCP server** exposes it all as agent tools: outlines, symbol lookup, ranked search, caller lists, blast-radius analysis, module maps — every answer as signatures and locations with drill-down IDs, never wall-of-text.

A rename that costs ~8,000 tokens of grep-and-read costs ~400 tokens through the index (worked example in [docs/mcp-server.md](docs/mcp-server.md#example-agent-session)).

## Status

**Design phase.** These docs describe the target architecture; no implementation exists here yet. The core index design is ported from a working Swift/GRDB implementation; the AST graph and ast-grep integration are new design. Platform: Node.js.

## Documentation

| Doc | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System overview, components, data flow, decision log, non-goals |
| [docs/schema.md](docs/schema.md) | SQLite schema: `indexed_files`, `code_chunks`, `symbols`, `edges`, FTS5, migrations, recovery |
| [docs/indexing.md](docs/indexing.md) | Pipeline: discovery → change detection → chunking → symbol/edge extraction → resolution |
| [docs/ast-graph.md](docs/ast-graph.md) | The code graph: node/edge model, construction, query use-cases with SQL |
| [docs/search.md](docs/search.md) | Three retrieval modes and when to use each (index vs. FTS vs. ast-grep) |
| [docs/mcp-server.md](docs/mcp-server.md) | Agent-facing MCP tool catalog and token-efficiency rationale |
| [docs/prd.md](docs/prd.md) | Product requirements: numbered FRs, milestones, acceptance criteria — source for tasks and the dev plan |
| [docs/benchmark.md](docs/benchmark.md) | Benchmark suite: Claude Code & Codex, with vs. without the tools — arms, tasks, harness, metrics |

Suggested reading order: architecture → schema → indexing → ast-graph → search → mcp-server → prd.

## Quick start (planned — not yet implemented)

```bash
npx code-index index .        # build/refresh .code-index/index.db
npx code-index stats          # what's indexed
npx code-index serve .        # stdio MCP server for agents
```

Requires `ast-grep` on PATH for structural search only.
