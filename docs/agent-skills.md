# Agent Skills & Integrations

> **Status:** Phase 1 (local Claude Code + Codex CLI) is specified here, with copy-ready skeletons under [`integrations/`](../integrations/). Phases 2–3 (Codex plugin packaging, claude.ai remote connector) are roadmap only. Agent CLI flags and file formats drift between releases — re-verify against the installed CLI versions when adopting, the same warning the [benchmark adapters](benchmark.md) carry.

> **See also:** the skill *content design*, six-arm measurement wiring, and the demonstration protocol for the shipped `code-index` skill live in [`docs/skills/`](skills/) (PRD, architecture, benchmark-measurement, and skill-content-design). This document remains the Phase-1 integration architecture.

## Purpose

The [MCP server](mcp-server.md) makes the 11 tools *available*, but availability is not *adoption*: an agent with `find_symbol` in its tool list will still reach for `grep` out of habit unless it is told when the index tools win and how to chain them. The missing piece is a **skill/instructions layer** — a small amount of always-relevant guidance that encodes the routing playbook ("name known → `find_symbol`, keyword → `search_code`, shape → `search_structural`") so agents use the token-cheap path unprompted.

This document is the architecture for that layer across both target agents (Claude Code and Codex CLI), the specification for the skeleton artifacts shipped in [`integrations/`](../integrations/), and the packaging/distribution roadmap toward a Codex plugin and a claude.ai connector.

## Relationship to existing docs

| Doc | What it owns | What this doc adds |
|---|---|---|
| [mcp-server.md](mcp-server.md) | The tool catalog, design rules, token rationale | How to *register* the server and *teach* agents to use it |
| [search.md](search.md) | The decision matrix for the three retrieval modes | The condensed version embedded in skill guidance |
| [benchmark.md](benchmark.md) + `benchmarks/harness/adapters/` | Measured proof the tools pay off; ground-truth headless invocation flags | The production (non-benchmark) integration path |

The tool catalog is **not** duplicated here — [mcp-server.md](mcp-server.md#tool-catalog) is authoritative.

## Skill design principles

These govern the skill body, the AGENTS.md section, and any future plugin-shipped instructions:

1. **Route by question shape, not habit.** Name known → `find_symbol` / `who_calls`; fuzzy keyword → `search_code`; code shape → `search_structural`; orientation → `index_status` + `module_map`. The full routing table is the [decision matrix](search.md#decision-matrix).
2. **Summaries first, bodies on demand.** Never follow a search hit with a full-file read; use the returned id with `get_chunk`, or read only the returned line range. This is the whole token story (~400 vs. ~8,000 tokens on the [canonical rename](mcp-server.md#example-agent-session)).
3. **Baseline tools are fallback, not default.** Read/Grep/Glob remain the right tools for: files outside the indexed languages (JS/TS/TSX), content beyond the 2000-char chunk cap ([known blind spot](search.md#text-search-fts5)), and ast-grep results, which carry no id — read the returned line range instead.
4. **Respect staleness signals.** Every index-backed response carries `index_age_seconds`. After editing, call `reindex {}` before trusting graph answers; for files edited seconds ago, prefer `search_structural` — it reads the live tree.
5. **Treat `unresolved_edges` as a confidence meter.** A high count near the queried region means callers may be missing from the graph — widen with `search_code` before claiming "no callers" ([why edges go unresolved](indexing.md#known-limitations)).
6. **Degrade gracefully.** `search_structural` is the only tool requiring the `ast-grep` binary and returns a distinguishable error when it is missing — fall back to Grep for that query; everything else keeps working.

## Tool-usage playbook

The recipes the skeletons distill. Each is a chain, not a single call — the value is in the sequencing.

### Orientation in an unfamiliar repo

1. `index_status` — languages, file/symbol counts, index freshness, recovery notices.
2. `module_map { path_prefix? }` — the file-level import graph (mermaid-ready).
3. `file_outline` on the entry points the map surfaces.

~150 tokens for a structural picture that reading files would cost thousands to build.

### Symbol lookup → callers → drill-down

1. `find_symbol { name }` — definition site(s) with signatures and ids.
2. `who_calls { symbol_id }` — inbound callers with locations.
3. `get_chunk { chunk_id }` on the one body you actually need.

The worked rename example (with token accounting) is in [mcp-server.md](mcp-server.md#example-agent-session).

### Blast radius before an edit

1. `impact_of_change { symbol_id, max_depth: 3 }` — transitive callers grouped by file.
2. Check the returned `unresolved_edges` count; if high, corroborate with `search_code` on the symbol name.
3. `get_dependencies { symbol_id }` for the outbound half of the picture.

### After editing

1. `reindex {}` — incremental; the delta response confirms what was reabsorbed.
2. Re-run whatever graph query the next step depends on. Until then, prefer `search_structural` for anything touching the edited files.

### Structural queries

1. Direct shapes → `pattern` (`console.log($ARG)`, `await $EXPR`). Contextual shapes → YAML `rule` with `stopBy: end` on relational clauses ([pattern-vs-rule guidance](search.md#structural-search-ast-grep)).
2. Scope with `paths` and the prefilter params so a whole-repo parse becomes a dozen-file parse.

### Fuzzy "where do we handle X"

1. `search_code { query }` — FTS5 syntax: phrases (`"replace chunks"`), prefixes (`pars*`), proximity (`NEAR(hash detect, 10)`), scoped with `path_prefix`.
2. Drill into winners by `chunk_id` via `get_chunk`.

## Claude Code integration (Phase 1)

### Architecture

Two cooperating artifacts in the **target** repo:

- **`.mcp.json`** makes the tools exist — MCP registration is unconditional per session.
- **`.claude/skills/code-index/SKILL.md`** makes the agent use them well — a skill is discovered by its frontmatter `description` and its body is loaded only when the description matches the task at hand.

Because the description is the trigger surface, it must name the *situations* (code navigation, finding callers, impact analysis, orienting in a repo), not the implementation.

### Skill format

A skill is a directory under `.claude/skills/<name>/` (project-level) or `~/.claude/skills/<name>/` (personal) containing a `SKILL.md` with YAML frontmatter:

```yaml
---
name: code-index
description: Navigate and analyze codebases with the code-index MCP tools (symbol
  lookup, callers, blast radius, outlines, ranked and structural search). Use when
  orienting in a repo, finding where a symbol is defined or called, assessing the
  impact of a change before editing, or searching code by keyword or AST shape.
---
```

`name` is lowercase-hyphenated; `description` is the trigger surface (≤ ~2 sentences, includes "use when…"); an optional `allowed-tools` key can restrict the skill to a tool subset. The body is plain markdown instructions.

### Setup steps

From a checkout of this repo, in the target repository:

```bash
# 1. Register the MCP server (either copy the template…)
cp <code-index-checkout>/integrations/claude/mcp.json .mcp.json
#    …or use the CLI)
claude mcp add code-index -- npx code-index serve .

# 2. Install the skill
mkdir -p .claude/skills
cp -r <code-index-checkout>/integrations/claude/skills/code-index .claude/skills/

# 3. Keep the index out of version control
echo ".code-index/" >> .gitignore
```

Verify with `claude mcp list` (the `code-index` server should appear) and by asking a session "what calls `<some function>`?" — the answer should arrive via `mcp__code-index__who_calls`, not grep.

### Tool permissions

Tool names surface to Claude Code as `mcp__code-index__<tool>` (e.g. `mcp__code-index__find_symbol`). For headless or CI use, allow them explicitly alongside the baseline set, and pin the MCP config for reproducibility (ground truth: `benchmarks/harness/adapters/claude.ts`):

```bash
claude -p "<prompt>" \
  --mcp-config .mcp.json --strict-mcp-config \
  --allowedTools "Read,Grep,Glob,Bash,mcp__code-index__*"
```

## Codex integration (Phase 1)

### Architecture

The same two-layer split, with Codex's mechanisms:

- **`[mcp_servers.code-index]`** in `~/.codex/config.toml` provides the tools.
- A short **`## Code navigation with code-index`** section in the target repo's `AGENTS.md` provides the usage playbook.

Codex has no on-demand skill mechanism — `AGENTS.md` is loaded unconditionally every session, so the section pays its context cost every time. Keep it short: a routing table and three rules, not the full playbook.

### config.toml format

```toml
# Merge into ~/.codex/config.toml.
[mcp_servers.code-index]
command = "npx"
args = ["code-index", "serve", "."]
```

Two footguns, both verified by the [benchmark adapter](benchmark.md) (`benchmarks/harness/adapters/codex.ts`):

- `command` must be a **bare executable** with the arguments in `args`. Putting the whole command line in `command` does not error — the server is silently never attached.
- `"."` as the serve path resolves against the session's working directory; the server indexes whatever repo Codex is launched in.

### Exec-mode (headless) overrides

For one-off headless runs, inject the server without touching config.toml:

```bash
codex exec "<prompt>" --json \
  -c mcp_servers.code-index.command=npx \
  -c 'mcp_servers.code-index.args=["code-index","serve","."]'
```

### Sandbox caveat

As of this writing, Codex's managed sandbox profiles (`read-only`, `workspace-write`) **auto-cancel MCP tool calls in exec mode** (openai/codex#16685). Until fixed upstream, headless MCP use requires:

```bash
codex exec "<prompt>" --sandbox danger-full-access ...
```

This disables the sandbox entirely — a real security tradeoff, acceptable in trusted CI or a benchmark harness, not a default to recommend to users. Interactive Codex sessions prompt for MCP calls normally and do not need it. The benchmark harness mirrors this workaround and carries the same caveat.

## Packaging & distribution roadmap

### Phase 1 — local npm + per-repo setup (now)

- Install the tool from a checkout: `npm install && npm run build && npm link` (later, `npm install -g stapler-code-index` once published).
- Copy the skeletons from [`integrations/`](../integrations/) into each target repo per the setup steps above.
- `integrations/` ships in the npm tarball (`package.json` `files`), so installed copies carry the templates.

### Phase 2 — Codex plugin packaging (future)

Goal: a one-command install that writes the `[mcp_servers.code-index]` table and drops the `AGENTS.md` section into a target repo. Open questions to resolve before committing:

- Stability of the Codex plugin manifest format (still moving between releases).
- Bundle the server binary in the plugin vs. resolving `code-index` via npx at run time.
- Delivering the `ast-grep` prerequisite (bundle, postinstall, or document-and-degrade).

### Phase 3 — claude.ai remote connector (future)

The gap is transport: the server is **stdio-only today** ([mcp-server.md](mcp-server.md)). A claude.ai connector is a hosted remote MCP server, which requires design work beyond packaging — explicitly out of scope for the Phase 1 spec sections above:

- **Transport** — Streamable HTTP via `@modelcontextprotocol/sdk` alongside (not replacing) stdio.
- **Repo access** — the indexer reads a local working tree; remote hosting implies server-side checkouts or a sync mechanism.
- **Multi-repo routing** — today one server instance per repo root; a hosted connector must map requests to repos.
- **Authn/z** — per-user repo access on a shared host.
- **`search_structural` semantics** — "live working tree" needs redefining when the tree lives server-side.

## Skeleton artifacts

The contract for [`integrations/`](../integrations/): each file is a template to copy into a target repo, not live configuration for this repo.

| Artifact | Destination in target repo | Customize |
|---|---|---|
| `integrations/claude/mcp.json` | `.mcp.json` | Nothing, if `code-index` is on PATH via npx |
| `integrations/claude/skills/code-index/SKILL.md` | `.claude/skills/code-index/SKILL.md` | Nothing required; optionally add repo-specific entry points to the orientation recipe |
| `integrations/codex/config.toml` | Merge into `~/.codex/config.toml` | Nothing, if `code-index` is on PATH via npx |
| `integrations/codex/AGENTS.md` | Paste section into the repo's `AGENTS.md` | Trim the table if the repo's AGENTS.md is already long |

## Decision log

1. **Skeletons live in a top-level `integrations/`, not `.claude/skills/`.** They are templates *for target repos*; a live `.claude/skills/` directory in this repo would be auto-discovered by Claude Code sessions developing this repo, conflating template with local config.
2. **One skill, not one-per-tool.** The value is the routing playbook — which tool for which question shape. Eleven per-tool skills would fragment triggering and teach nothing about sequencing.
3. **The AGENTS.md section is deliberately short.** Codex loads AGENTS.md unconditionally every session (context cost every time), unlike Claude skills which load on demand — so Codex gets the condensed table and three rules, Claude gets the full playbook.
4. **`integrations` added to `package.json` `files`** so published/linked installs carry the templates alongside `dist` and `queries`.
5. **Phase ordering: local stdio integrations → Codex plugin → remote connector.** The connector is last because it requires a new transport plus a repo-access model — design work, not packaging work.
