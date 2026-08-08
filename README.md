# stapler-code-index

Development tools that give AI coding agents architectural understanding of a codebase — at a fraction of the token cost of text search and full-file reads.

## How it works

- **tree-sitter** parses source files into a per-repo **SQLite index** (`.code-index/index.db`) of code chunks plus a **symbol graph** (who calls what, who imports what, what extends what).
- **ast-grep** handles ad-hoc structural queries against the live working tree ("async functions without try/catch") that no text search can express.
- An **MCP server** exposes it all as 11 agent tools: outlines, symbol lookup, ranked search, caller lists, blast-radius analysis, module maps — every answer as signatures and locations with drill-down IDs, never wall-of-text.

A rename that costs ~8,000 tokens of grep-and-read costs ~400 tokens through the index (worked example in [docs/mcp-server.md](docs/mcp-server.md#example-agent-session), guarded by an automated budget test).

## Quick start

Once, in a checkout of this repo (unpublished — installs from source):

```bash
npm install
npm run build
npm link            # puts `code-index` on your PATH
```

Then, in any JS/TS repository:

```bash
npx code-index index .
npx code-index stats
npx code-index serve .
```

- `index` builds or incrementally refreshes `.code-index/index.db` (add it to your `.gitignore`).
- `stats` shows files/chunks/symbols per language, unresolved edges, and the last run.
- `serve` starts the stdio MCP server (health-checks the index, then reindexes in the background without blocking the first tool call).
- `index --full` clears and rebuilds; `clear` deletes the index directory.

Languages: JavaScript, TypeScript, TSX (`.js .mjs .cjs .jsx .ts .mts .cts .tsx`).

`ast-grep` (>= 0.42.0) on PATH is a runtime prerequisite for the `search_structural` tool only — everything else works without it. Install with `npm install -g @ast-grep/cli` or `brew install ast-grep`.

## Registering with an agent

```jsonc
// .mcp.json in the target repo
{
  "mcpServers": {
    "code-index": {
      "command": "npx",
      "args": ["code-index", "serve", "."],
    },
  },
}
```

or `claude mcp add code-index -- npx code-index serve .`

Skill and config templates for Claude Code and Codex, plus the integration architecture and distribution roadmap, are in [docs/agent-skills.md](docs/agent-skills.md) and [`integrations/`](integrations/).

## Robustness model

The index is a pure cache: it is never repaired, only rebuilt. A corrupted, foreign, or copied database is quarantined on open and rebuilt from source; the recovery event is reported by the `index_status` tool. Deleting `.code-index/` is always safe.

## Documentation

| Doc                                          | Covers                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | System overview, components, data flow, decision log, non-goals                                         |
| [docs/schema.md](docs/schema.md)             | SQLite schema: `indexed_files`, `code_chunks`, `symbols`, `edges`, FTS5, migrations, recovery           |
| [docs/indexing.md](docs/indexing.md)         | Pipeline: discovery → change detection → chunking → symbol/edge extraction → resolution                 |
| [docs/ast-graph.md](docs/ast-graph.md)       | The code graph: node/edge model, construction, query use-cases with SQL                                 |
| [docs/search.md](docs/search.md)             | Three retrieval modes and when to use each (index vs. FTS vs. ast-grep)                                 |
| [docs/mcp-server.md](docs/mcp-server.md)     | Agent-facing MCP tool catalog and token-efficiency rationale                                            |
| [docs/agent-skills.md](docs/agent-skills.md) | Claude Code & Codex integration architecture: skills, MCP registration, packaging roadmap               |
| [docs/prd.md](docs/prd.md)                   | Product requirements: numbered FRs, milestones, acceptance criteria — source for tasks and the dev plan |
| [docs/benchmark.md](docs/benchmark.md)       | Benchmark suite: Claude Code & Codex, with vs. without the tools — arms, tasks, harness, metrics        |

Suggested reading order: architecture → schema → indexing → ast-graph → search → mcp-server → agent-skills → prd.

## Implementation notes (doc/spec reconciliations)

Documented deviations from the spec sketches, each flagged during review rather than silently absorbed:

- **Dead-exports query** excludes self-referential `exports` edges — the literal sketch returns an empty set under this edge model (`src/query/graph.ts`).
- **Repo identity is symlink-canonical**: `meta.repo_root` stores/compares `realpath`, so `/var` vs `/private/var` aliases of the same directory are one repo, not a "copied database" (`src/storage/meta.ts`).
- **Default exports** carry no schema marker; a default import links only when local and exported names coincide (`src/graph/resolve.ts`, documented limitations).
- Accepted v1 limitations (no type inference, dynamic constructs invisible, one-level re-exports/aliases, repo-local resolution) are stated where edge data is consumed and pinned by tests.

## Development

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest, ~290 tests
```
