# Skill Content Design

> **Status:** design for the content of the two shipped instruction artifacts —
> `integrations/claude/skills/code-index/SKILL.md` and `integrations/codex/AGENTS.md`.
> Part of the [skills feature architecture](architecture.md); the measurement loop that
> evaluates every content change is in [benchmark-measurement.md](benchmark-measurement.md).
> The existing skeletons are the starting point and are **extended in place**; the
> [skill design principles](../agent-skills.md#skill-design-principles) of the Phase-1
> spec remain in force and are sharpened here toward one goal: maximize the measured
> token gap at equal-or-better correctness.

## Where tokens actually go (and what the content must attack)

The 2026-08-08 bench data shows median totals of ~53–87k tokens for 1–2-tool-call tasks:
the bill is dominated by **per-turn context re-reads** (cache tokens ≈ turns × context
size) and **fresh file-content reads**, not by tool-result payloads. So the content is
designed around three attack vectors, in priority order:

| Vector | Mechanism | Content device |
|---|---|---|
| **V1. Fewer turns** | Every extra assistant turn re-pays the whole context as cache reads — the largest single multiplier | Recipes that name the *complete* call chain up front, batch independent lookups in one turn, and end with "answer directly from the tool output — do not take a verification lap" |
| **V2. No raw-text fallback after a hit** | One full-file `Read` (hundreds–thousands of tokens) erases the savings of ten index calls | Hard rules: drill down **only** by returned id (`get_chunk`) or returned line range; never `Read` a whole file, never `cat`/`sed` via Bash, never Grep a name the index already resolved |
| **V3. Right tool on the first try** | A wrong first tool costs a wasted turn (V1) plus its payload | The routing table keyed by *question shape*, plus an explicit anti-pattern list of the habitual baseline moves the index replaces |

Correctness devices ride along (they gate the headline, per architecture decision 5):
corroborate before asserting a negative (`unresolved_edges` → widen with `search_code`),
and after any edit `reindex {}` before trusting graph answers — these target the two
observed with-arm correctness losses (cross-file-navigation 0.00, rename-refactor 0.50).

## Shared content model

Both artifacts are renderings of the same underlying playbook at different depths
(deliberately divergent — architecture decision 6). The playbook's sections, in the
order agents should encounter them:

1. **Contract line** — one sentence: structural questions cost tens of tokens via the
   index vs thousands via grep-and-read; prefer the index whenever the routing table
   matches.
2. **Session opener** — `index_status` once; on error, fall back to baseline tools for
   the whole session (no retry loops).
3. **Routing table** — question shape → tool, with the *rejected* baseline habit named
   in a "Not" column (the skeleton already has this; keep it).
4. **Recipes** — named call chains per question shape (below). Each recipe states the
   full sequence, the expected turn count, and the stop condition ("you now have enough
   to answer — answer").
5. **Hard budget rules** — the V1–V3 rules as imperatives, phrased as prohibitions
   (prohibitions transfer better than preferences).
6. **Fallback & confidence rules** — non-JS/TS files, 2000-char chunk cap, ast-grep
   missing binary, `unresolved_edges`, `index_age_seconds`.

### Recipes (the sequencing discipline)

One recipe per question shape; these are also the benchmark's category shapes — that is
by construction, not overfit: the categories were derived from the tool catalog's claimed
capabilities ([benchmark.md](../benchmark.md#task-model)), and the recipes are written
against the same catalog. Guardrails below keep task-specific leakage out.

| Shape | Chain | Turn budget |
|---|---|---|
| Orientation | `index_status` → `module_map` → `file_outline` on surfaced entry points, batched | 1–2 |
| Symbol lookup | `find_symbol { name }` → answer from signature/location; `get_chunk` only if the body is truly needed | 1 |
| Callers / impact | `find_symbol` → `who_calls` / `impact_of_change { max_depth }` → answer; corroborate with `search_code` iff `unresolved_edges` is high | 1–2 |
| Concept localization | `search_code` (FTS phrases/prefix/NEAR, `path_prefix` scope) → `get_chunk` on the top hit(s) → answer | 2 |
| Cross-file trace | `find_symbol` at the entry → alternate `get_dependencies` / `who_calls` hops, batching independent hops; `get_chunk` at most once per hop **only when the hop decision needs a body** | 2–3 |
| Rename / refactor (edit) | `find_symbol` → `impact_of_change` → edit every site → `reindex {}` → re-run `who_calls`/`search_code` on the **old** name to prove zero stragglers | edit-count + 2 |
| Shape queries | `search_structural` (pattern or YAML rule, `paths`-scoped) → read only returned line ranges | 1–2 |

### Hard budget rules (verbatim spirit, both artifacts)

- Never follow an index hit with a full-file `Read` — fetch the one body by
  `get_chunk { chunk_id }`, or read only the returned line range.
- Never route file content through Bash (`cat`, `sed`, `head`) when an index tool or a
  ranged read answers the question.
- Never Grep for a symbol name — `find_symbol` / `who_calls` know it; Grep is for
  non-JS/TS files and post-`search_structural` line ranges only.
- Batch independent index calls in a single turn; do not interleave one call per turn.
- When the tools have answered the question, **answer** — no confirmation re-reads, no
  summary tour of files already understood.

## Per-artifact rendering

### `integrations/claude/skills/code-index/SKILL.md` (on-demand, full depth)

- **Frontmatter `description` is the trigger surface** and is treated as its own design
  object: it must fire on *situations* (orient, find definition/callers, blast radius,
  keyword/AST search, safe rename) — the measurement doc's adoption metric is the
  feedback signal for description tuning. `name: code-index` unchanged.
- Body carries the full model: routing table, all seven recipes with turn budgets, hard
  rules, fallback rules. Target ≲ 150 lines — a skill body also pays context cost when
  triggered (decision 4: the skill must pay for itself).
- Structure the body so rules precede recipes (rules survive truncation/skim better).

### `integrations/codex/AGENTS.md` (always-loaded, condensed)

- Loaded unconditionally every session — every line is a per-session tax measured by the
  benchmark. Target ≲ 40 lines: contract line, routing table (merged "Not" column), the
  five hard rules, one-line after-edit rule, one-line fallback rule.
- Recipes compress to a single "chain, don't wander" line plus the two chains with the
  highest measured payoff (callers/impact, rename) — chosen and revisited by bench
  evidence, not intuition.
- Keeps the skeleton's HTML comment header (template provenance + config.toml pointer).

## Guardrails (validity of the measured gap)

Enforced by `test/integrations-contract.test.ts` where mechanical, by review otherwise:

1. **No benchmark leakage** — artifacts must not mention benchmark task ids, target
   names (`zod`, `fixture-ts`, `self`), seed-task symbol names, or answer formats from
   `seed-tasks.ts`. Mechanical check: no string from the task registry's id/target/key
   fields appears in either artifact.
2. **Tool-name completeness & freshness** — every artifact names all 11 tools of the
   [catalog](../mcp-server.md#tool-catalog); no names outside it. Catches drift in both
   directions when the catalog changes.
3. **Additive language only** — artifacts teach when the index wins and when to fall
   back; they never instruct the agent that baseline tools are unavailable (parity
   ladder, architecture decision 4).
4. **Single source** — the skill body text exists only under `integrations/`; the
   contract test fails if it is duplicated under `benchmarks/` (architecture §Boundary
   rules).
5. **Generality review** — every content change that improves the bench numbers gets a
   one-question review: "would this sentence help in a repo we've never benchmarked?"
   If no, it's overfit; reject.

## Content-iteration loop

Skill content is the experimental variable; the process is fixed:

1. Edit artifact(s) under `integrations/`.
2. `npm run bench -- run --task all --arms <agent>-with,<agent>-with-skill,<agent>-without …`
   (protocol details in the measurement doc) — the harness injects the edited files and
   stamps their hash into every record.
3. `bench report` — read the three-way ratios, the adoption metric, and correctness.
4. Keep the edit iff `with-skill/without` improves **and** correctness Δ ≥ 0; the dated
   report + `skill_set` hash is the change's evidence trail.
