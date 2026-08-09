<!-- Template: paste this section into the target repo's AGENTS.md.
     Requires the code-index MCP server in ~/.codex/config.toml
     (see integrations/codex/config.toml). -->

## Code navigation with code-index
Baseline Grep/Read/Glob stay available. Every tool call re-sends your whole context as a fresh
round-trip, so pick the plan with the **fewest total calls**: use the index when one call
**replaces many greps**/reads (callers, impact, structure, orientation across files you haven't
read); if one Grep or a ranged Read of a known file settles it, or the task is trivial, do that
directly. Open with `index_status`, or **skip it** and **go straight to `find_symbol`** for a
**single known-symbol lookup**; on error, use Read/Grep/Glob for the session. The table matches
question shapes; the **gate decides** whether the index runs.

| Your question | Use | Not |
|---|---|---|
| "Where is `X` defined?" | `find_symbol { name }` | Grep |
| "What calls `X`?" | `who_calls { name }` | Grep |
| "What breaks if I change `X`?" | `impact_of_change { symbol_id }` | N greps |
| "What does `X`/this file depend on?" | `get_dependencies` | Reading imports |
| "What's in this file?" | `file_outline { path }` | Reading the file |
| "Where do we handle <concept>?" | `search_code { query }` — FTS5: bare words, `"phrase"`, `prefix*`, `NEAR()`; **no raw** `(` `)` `:` (they error) | Grep |
| "Which code matches <shape>?" | `search_structural { pattern or rule }` | Regex |
| "How is this repo organized?" | `index_status` + `module_map` | Directory walking |

Rules:
1. Never follow an index hit with a full-file Read — fetch the one body with
   `get_chunk { chunk_id }`, or Read only the returned line range.
2. Never route file content through Bash (`cat`, `sed`, `head`) when an index tool or a ranged read answers.
3. Never Grep for a symbol name **the index already resolved** — don't re-buy the answer.
4. Batch independent index calls in one turn; don't interleave one call per turn.
5. When the tools have answered, answer — no confirmation re-reads, no summary tour,
   no **repeat/bigger** `search_code`, second `who_calls`, or grep "to be sure": each
   extra call re-sends the whole context as fresh (**uncached**) tokens.
After edits, call `reindex {}` **only if** you will keep querying the graph — never as a closing step.
Fallback: non-JS/TS files, content past the 2000-char chunk cap, `search_structural`
results (no id — read the range), missing ast-grep → Grep. High `unresolved_edges`
= graph may be incomplete — corroborate a negative with `search_code`.
Chain, don't wander — name the full call chain up front, then stop:
- **Callers / impact:** `find_symbol` → `who_calls` / `impact_of_change { max_depth }` → answer.
  `who_calls` IS the caller set — answer from it, don't re-verify with `search_code`, a
  second `who_calls`, or grep; fewer hits than expected = the resolved-call graph, not an
  error. Answer directly unless `unresolved_edges` is high (then widen once per Fallback).
- **Rename:** grep the old name for every site → edit all sites → one final grep with zero
  hits proves it. Grep is the rename tool — **no `reindex`**, no index re-query mid-task.
