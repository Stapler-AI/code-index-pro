<!-- Template: paste this section into the target repo's AGENTS.md.
     Requires the code-index MCP server in ~/.codex/config.toml
     (see integrations/codex/config.toml). -->

## Code navigation with code-index

The `code-index` MCP tools answer structural questions in tens of tokens instead
of the thousands that grep-and-read costs. Prefer them over Grep/Read whenever the
question below matches; the baseline tools stay available for everything else.
Start a navigation session with `index_status` (confirms the server is up, reports
freshness). If it errors, fall back to Read/Grep/Glob for the whole session.

| Your question | Use | Not |
|---|---|---|
| "Where is `X` defined?" | `find_symbol { name }` | Grep |
| "What calls `X`?" | `who_calls { name }` | Grep |
| "What breaks if I change `X`?" | `impact_of_change { symbol_id }` | N greps |
| "What does `X`/this file depend on?" | `get_dependencies` | Reading imports |
| "What's in this file?" | `file_outline { path }` | Reading the file |
| "Where do we handle <concept>?" | `search_code { query }` (FTS phrases, `prefix*`, `NEAR()`) | Grep |
| "Which code matches <shape>?" | `search_structural { pattern or rule }` | Regex |
| "How is this repo organized?" | `index_status` + `module_map` | Directory walking |

Rules:
1. Never follow an index hit with a full-file Read — fetch the one body with
   `get_chunk { chunk_id }`, or Read only the returned line range.
2. Never route file content through Bash (`cat`, `sed`, `head`) when an index tool
   or a ranged read answers the question.
3. Never Grep for a symbol name — `find_symbol`/`who_calls` already resolve it.
4. Batch independent index calls in one turn; don't interleave one call per turn.
5. When the tools have answered, answer — no confirmation re-reads, no summary tour.

After editing files, call `reindex {}` before trusting graph answers.

Fallback: non-JS/TS files, content past the 2000-char chunk cap, and
`search_structural` results (no id — read the line range); if ast-grep's binary is
missing, use Grep for that query. High `unresolved_edges` means the graph may be
incomplete — corroborate a negative with `search_code`.

Chain, don't wander — name the full call chain up front, then stop:
- **Callers / impact:** `find_symbol` → `who_calls` / `impact_of_change { max_depth }` → answer.
- **Rename:** `find_symbol` → `impact_of_change` → edit every site → `reindex {}` →
  re-run `who_calls`/`search_code` on the old name to prove zero stragglers.
