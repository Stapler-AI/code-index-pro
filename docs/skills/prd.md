# Product Requirements Document — Skills & Token-Gap Measurement

> **Purpose of this document:** the single source for generating development tasks for the
> skills feature set. Every functional requirement is numbered, cites the architecture doc
> that specifies it in detail, and carries verifiable acceptance criteria. The design
> authority remains [architecture.md](architecture.md),
> [skill-content-design.md](skill-content-design.md), and
> [benchmark-measurement.md](benchmark-measurement.md); this PRD scopes and sequences
> them and fixes the acceptance thresholds those docs deliberately deferred.
> FR numbers here are scoped to this feature set (they do not collide with the main
> [prd.md](../prd.md) — cross-references should say "skills PRD FR-xxx").

## 1. Overview

The MCP server ships 11 tools, but the 2026-08-08 benchmark shows tool *availability*
alone buys only ~8–24% token savings and can even lose correctness (cross-file-navigation
0.00 vs 1.00; rename-refactor 0.50 vs 1.00). The missing layer is *instructions*: the
sequencing discipline (route by question shape, drill down by id, batch calls, reindex
after edits) that turns the tools into the token story the project claims.

This feature set delivers two things in one feedback loop:

1. **Production skills** — the Claude Code skill
   (`integrations/claude/skills/code-index/SKILL.md`) and the Codex CLI AGENTS.md section
   (`integrations/codex/AGENTS.md`), evolved in place from the existing skeletons into
   prescriptive, budget-oriented playbooks.
2. **Measurement wiring** — the benchmark harness extended with two `*-with-skill` arms
   that inject the *shipped artifacts verbatim* into run workspaces, plus record/report
   extensions (skill-content hash, cache split, adoption metric, three-way ratios) so
   every skill edit is evaluated by evidence.

**Driving objective:** substantially increase the benchmark-measured token-usage gap
between agents using the stapler-code-index tools and agents not using them, at
equal-or-better correctness — and make that gap demonstrable by a single documented run
protocol.

## 2. Goals

1. Ship skill artifacts that encode the three token attack vectors (fewer turns; no
   raw-text fallback after an index hit; right tool first try) and the two correctness
   disciplines (corroborate negatives via `unresolved_edges`; `reindex` + re-verify after
   edits) — [skill-content-design.md](skill-content-design.md).
2. Extend the harness from four arms to six (`{claude,codex} × {without,with,with-skill}`)
   on a strictly additive parity ladder, measuring the exact files users install —
   [benchmark-measurement.md](benchmark-measurement.md).
3. Make the skill's contribution *attributable*: three-way ratios, per-run `skill_set`
   content hash, MCP-adoption metric, cached/uncached token split.
4. Weight the task mix toward targets and categories where structural retrieval
   compounds, without gaming task prompts.
5. Leave the full demonstration protocol ready to execute on demand (models, arms, reps,
   report), verified end-to-end on a smoke subset.

### Non-goals — from [architecture.md](architecture.md#non-goals)

- Phases 2–3 of [agent-skills.md](../agent-skills.md) (Codex plugin packaging, claude.ai
  remote connector).
- New MCP tools or server changes — the 11-tool catalog
  ([mcp-server.md](../mcp-server.md#tool-catalog)) is fixed input.
- Cross-agent model-quality claims; all headline comparisons stay within-agent.
- CI-scheduled benchmark runs; runs stay manual.
- Skills for agent CLIs other than Claude Code and Codex CLI.
- **Executing the full paid demonstration run** — see FR-1000: the deliverable is
  harness-readiness verified on a smoke subset; the full protocol run is performed
  separately at the user's discretion and does not gate acceptance.

## 3. Success metrics & acceptance gates

All ratios are medians of per-task paired ratios within one agent, computed by
`bench report` over runs where neither side is flagged (`timeout`, `agent_error`,
`no_result`, zero-token). The correctness gate applies everywhere: a ratio only counts
toward a gate where the skill arm's correctness Δ ≥ 0 vs `without`, and the report marks
any correctness regression beside the ratio (architecture decision 5).

| Gate | Agent | Criterion |
|---|---|---|
| **G1 — headline token gap** | Claude Code | Median `with-skill/without` token ratio **≤ 0.67** (≥33% savings) over task pairs in the **structure-heavy categories**: `callers-impact`, `cross-file-navigation`, `rename-refactor`. The all-task median is reported alongside but does not gate. |
| **G2 — win rate** | Claude Code | `with-skill` wins (strictly fewer tokens) **≥ 70%** of graded task pairs vs `without`, across all tasks. |
| **G3 — Codex directional gap** | Codex CLI | `with-skill/without` ratio strictly better (lower) than the same run set's `with/without` ratio, **and** correctness Δ ≥ 0. No fixed numeric target (its always-loaded AGENTS.md pays a per-session context tax, and codex-CLI measurement has known instability). G2 does not apply to Codex. |
| **G4 — correctness floor** | both | Skill-arm correctness Δ ≥ 0 vs `without` per category; specifically the two current with-arm regressions (cross-file-navigation, rename-refactor) must be recovered to Δ ≥ 0 in the skill arm. |

Generated tasks (`generated:v1`, FR-800) **count toward all gates**: they participate in
G1's gated categories wherever their `category` field is one of the three structure-heavy
categories, and G4 applies to them identically. Their keys remain spot-validated per
[benchmark.md](../benchmark.md#task-generation); same-key grading keeps generator
circularity neutral across arms.

**When gates are evaluated:** G1–G4 are defined against the full demonstration protocol
(FR-1000) and are the feature's success criteria *when that run is performed*. Feature
**acceptance** (what gates merging this feature set) is FR-level: artifacts, wiring,
tests, and the smoke verification of FR-1000 — not the paid full run.

## 4. Functional requirements

### FR-100 Claude Code skill content — spec: [skill-content-design.md](skill-content-design.md#integrationsclaudeskillscode-indexskillmd-on-demand-full-depth)

Extend `integrations/claude/skills/code-index/SKILL.md` in place:

- **FR-101 Trigger surface.** Frontmatter `description` fires on *situations* (orient in
  a repo, find definition/callers, blast radius before an edit, keyword/AST search, safe
  rename); `name: code-index` unchanged. The description is tuned against the adoption
  metric (FR-702), not intuition.
- **FR-102 Body structure & order.** Contract line → session opener (`index_status`
  once; on error fall back for the whole session) → routing table with "Not" column →
  hard budget rules → seven recipes → fallback/confidence rules. Rules precede recipes
  (skim/truncation survival).
- **FR-103 Recipes.** All seven question-shape recipes with explicit chains, turn
  budgets, and stop conditions, per the [recipe table](skill-content-design.md#recipes-the-sequencing-discipline)
  — including the rename recipe's after-edit discipline (`reindex {}` → re-query the
  **old** name to prove zero stragglers) and the callers recipe's corroboration rule
  (`unresolved_edges` high → widen with `search_code`).
- **FR-104 Hard budget rules.** The five prohibitions verbatim in spirit: no full-file
  `Read` after an index hit (drill down via `get_chunk` / returned line range); no file
  content through Bash (`cat`/`sed`/`head`); no Grep for a symbol name the index
  resolves; batch independent index calls in one turn; answer when answered — no
  verification lap.
- **FR-105 Budget.** Body ≲ 150 lines — the skill pays its own context cost inside
  measured totals (architecture decision 4).

**Acceptance criteria:** contract test FR-300 passes; body ≤ 150 lines (excluding
frontmatter); all seven recipes present with turn budgets; the five hard rules present as
prohibitions; content review confirms additive language only (never claims baseline tools
are unavailable).

### FR-200 Codex AGENTS.md content — spec: [skill-content-design.md](skill-content-design.md#integrationscodexagentsmd-always-loaded-condensed)

Extend `integrations/codex/AGENTS.md` in place:

- **FR-201 Condensed rendering.** Contract line; routing table with merged "Not" column;
  the five hard rules; one-line after-edit rule; one-line fallback rule.
- **FR-202 Recipes.** A single "chain, don't wander" line plus the two
  highest-measured-payoff chains (initially callers/impact and rename; revisited on bench
  evidence).
- **FR-203 Budget.** ≲ 40 lines — loaded unconditionally every session, so every line is
  a measured per-session tax.
- **FR-204 Header.** The HTML template-comment header (provenance + config.toml pointer)
  is retained in the artifact; it is stripped at benchmark install time by FR-500, not
  here.

**Acceptance criteria:** contract test FR-300 passes; body ≤ 40 lines excluding the HTML
comment header; both named chains present.

### FR-300 Content guardrails & contract test — spec: [skill-content-design.md](skill-content-design.md#guardrails-validity-of-the-measured-gap)

New `test/integrations-contract.test.ts` enforcing, for both artifacts:

- **FR-301 Tool-name completeness & freshness.** Every artifact names all 11 catalog
  tools; no tool names outside the catalog (drift caught in both directions).
- **FR-302 No benchmark leakage.** No string from the task registry's id/target/key
  fields (task ids, target names such as `zod`/`fixture-ts`/`self`, seed-task symbol
  names, answer formats) appears in either artifact.
- **FR-303 Single source.** The skill body text exists only under `integrations/`; the
  test fails if a second copy of the body appears anywhere under `benchmarks/`.
- **FR-304 Generality review (process).** Any content edit that improves bench numbers
  passes the review question "would this sentence help in a repo we've never
  benchmarked?" — enforced by review, recorded in the change's PR/commit message.

**Acceptance criteria:** the test fails when a tool name is removed from an artifact,
when a fake 12th tool name is added, when a task id string is inserted, and when the
skill body is duplicated under `benchmarks/` (verified by mutation in the test's own
fixtures); passes on the shipped artifacts.

### FR-400 Six-arm model & adapter changes — spec: [benchmark-measurement.md](benchmark-measurement.md#arm-model-six-arms-three-rung-parity-ladder)

- **FR-401 Arm union.** `Arm` in `benchmarks/harness/adapters/types.ts` grows to six
  values, adding `claude-with-skill` and `codex-with-skill`. `ALL_ARMS` in `run.ts` grows
  to six; `--arms` defaults to all six.
- **FR-402 Predicates.** `isWithArm()` becomes explicit set membership (true for `with`
  and `with-skill` arms — tools present); new `hasSkill(arm)` predicate. This is a
  breaking contract change pinned by adapter unit tests.
- **FR-403 Parity ladder.** Strictly additive: `without ⊂ with ⊂ with-skill`. The only
  delta between `claude-with` and `claude-with-skill` argv is allowing the `Skill` tool
  in `--allowedTools`; the codex adapter has no argv delta (file presence suffices).
  Nothing is ever removed from a lower rung.
- **FR-404 Diagnostic mode (Claude only).** Env-gated `BENCH_SKILL_MODE=system-prompt`
  injects the SKILL.md body via `--append-system-prompt` instead of the file copy; such
  runs carry flag `skill_mode:system-prompt` and are excluded from headline aggregation.
  Never the headline; exists to separate "description didn't trigger" from "body didn't
  help".

**Acceptance criteria:** `test/bench-claude-adapter.test.ts` /
`test/bench-codex-adapter.test.ts` pin the `isWithArm`/`hasSkill` truth tables for all
six arms and the skill-arm argv deltas; existing four-arm behavior is byte-identical
(no argv change for the four current arms).

### FR-500 Instruction injection — spec: [benchmark-measurement.md](benchmark-measurement.md#instruction-injection)

New module `benchmarks/harness/instructions.ts`, split pure/impure per the
[layer table](architecture.md#directory-structure--layer-mapping):

- **FR-501 Pure plan.** `planInstructions(arm)` returns the source→dest list:
  `claude-with-skill` → SKILL.md into `.claude/skills/code-index/SKILL.md`;
  `codex-with-skill` → AGENTS.md at workspace root; all other arms → `[]`. Sources are
  paths under `integrations/` (single-source rule — the benchmark measures the shipped
  artifacts verbatim).
- **FR-502 Impure install.** `installInstructions(workspaceDir, arm)` copies artifacts
  into the workspace and returns `sha256[..12]` of injected content (null for non-skill
  arms). Wired as a new `HarnessDeps` member; called after workspace materialization and
  index build, before agent invocation; fake-able in unit tests.
- **FR-503 Pre-existing-file handling.** Claude: error if the workspace already contains
  `.claude/` (isolation violation — no current target ships one). Codex: if the target
  ships an `AGENTS.md`, append the section after a separator and set record flag
  `agents_md_appended`.
- **FR-504 Header strip.** The codex artifact's HTML template-comment header is stripped
  at install (packaging metadata, not instructions) — the sole content transform, owned
  by `installInstructions` and pinned by a unit test.
- **FR-505 Path resolution.** Only the composition root (`defaultDeps()` in `run.ts`)
  knows where `integrations/` lives on disk; no `integrations/...` path literals in the
  application layer.

**Acceptance criteria:** `test/bench-instructions.test.ts` covers the
`planInstructions` truth table for all six arms; install into a temp workspace copies,
appends, and strips correctly; returns a stable content hash; errors on pre-existing
`.claude/`; `test/bench-harness.test.ts` proves the run loop calls
`installInstructions` for skill arms only and after index build.

### FR-600 Record schema extensions — spec: [benchmark-measurement.md](benchmark-measurement.md#record-schema-extensions)

Additive fields on `RunRecord` (append-only JSONL; old records stay readable):

- **FR-601** `arm` — six-value domain.
- **FR-602** `versions.skill_set` — sha256[..12] of injected instruction content; null
  for non-skill arms. The content-iteration loop's join key.
- **FR-603** `metrics.tokens_cache_read` / `tokens_cache_creation` — split of today's
  `tokens_cache` (which is kept for back-compat).
- **FR-604** `metrics.baseline_calls` — persisted into the record (already parsed in
  `RunMetrics`, currently dropped at record-write); the adoption denominator.
- **FR-605** `flags` may carry `agents_md_appended`, `skill_mode:system-prompt`.

**Acceptance criteria:** harness test proves `skill_set` lands in skill-arm records and
is null otherwise; report reading tolerates legacy records missing all new fields.

### FR-700 Report extensions — spec: [benchmark-measurement.md](benchmark-measurement.md#report-extensions-reportts-offline-re-runnable)

`report.ts` stays offline re-runnable over existing `runs.jsonl`:

- **FR-701 Three-way headline per agent.** `with/without`, `with-skill/with`,
  **`with-skill/without`** (the project headline), correctness Δ (skill vs without),
  adoption, index build seconds. Plus a **structure-heavy subset row** per agent (the
  same ratios over `callers-impact` + `cross-file-navigation` + `rename-refactor` pairs
  only) so gate G1 is readable directly from the report.
- **FR-702 Adoption metric.** Per arm, median `mcp_calls / tool_calls` (0 when no
  tools) — the mediating variable that makes flat results diagnosable (trigger/content
  problem vs recipe problem).
- **FR-703 Token composition.** Per-category cells gain `fresh-in / cache-read / out`
  medians beside the total, exposing where savings come from (V1 vs V2).
- **FR-704 Win/loss/tie.** Computed for both `with vs without` and
  `with-skill vs without` (feeds gate G2).
- **FR-705 Correctness marker.** Any headline row with correctness Δ < 0 renders an
  explicit regression marker; a ratio is never presented without it.
- **FR-706 Flagged-run exclusion (prerequisite fix).** Runs flagged `no_result`,
  `agent_error`, `timeout`, or with zero recorded tokens are excluded from all ratio and
  win/loss aggregation (today they aggregate silently — the codex zero-token failure mode
  in `2026-08-08-bench.md`). Excluded counts are reported.
- **FR-707 Diagnostic exclusion.** Runs flagged `skill_mode:system-prompt` are excluded
  from headline aggregation and shown separately if present.

**Acceptance criteria:** `test/bench-report.test.ts` covers the three-way table, the
structure-heavy subset row, adoption, token split, correctness marker, flagged-run and
diagnostic exclusion, and legacy-record tolerance; `bench report` over the existing
`runs.jsonl` runs without error.

### FR-800 Task mix — spec: [benchmark-measurement.md](benchmark-measurement.md#task-mix-surfacing-the-gap-honestly)

- **FR-801 Structure-heavy seed expansion.** Add roughly **6–12 hand-authored tasks**
  filling gaps to the existing convention of 2 tasks per category per target, for the
  structure-heavy categories (`callers-impact`, `cross-file-navigation`,
  `rename-refactor`) on the larger targets (`oss-zod`, `self`). Small-fixture tasks are
  kept unchanged (regression floor).
- **FR-802 Generator wiring.** Wire `generate-tasks.ts` (currently library-only) into
  the registry behind an explicit tag filter; generated entries carry `generated:v1`
  tags and inline keys. Generated tasks are **included in the demonstration protocol
  and count toward headline numbers and gates** (§3), scoped initially to `oss-zod`.
  Circularity handling unchanged from [benchmark.md](../benchmark.md#task-generation):
  same-key grading is arm-neutral; spot-validation of generated keys still applies.
- **FR-803 Tool-agnostic prompts (registry validation rule).** Task prompts never
  mention the index, MCP, or any tool by name, in any arm — enforced as a load-time
  registry validation, not convention.

**Acceptance criteria:** registry validation rejects a task whose prompt names a tool /
"MCP" / "index" retrieval mechanism (unit test); after expansion each structure-heavy
category has ≥ 2 authored tasks on each of `oss-zod` and `self`; generator-produced
tasks load into the registry only under the tag filter and validate like authored ones;
a documented sample of generated keys is spot-validated.

### FR-900 Boundary enforcement — spec: [architecture.md](architecture.md#boundary-rules--enforcement-tooling)

- **FR-901 dependency-cruiser.** Installed as a devDependency with
  `.dependency-cruiser.cjs` encoding: `src` isolated from
  `benchmarks|test|integrations`; adapters may not import
  `run.ts`/`report.ts`/`instructions.ts`; `benchmarks` → `src` only via the
  grandfathered `src/storage/meta` exception (exact path — a ratchet, no new
  exceptions); no circular dependencies.
- **FR-902 Wiring.** npm script `boundaries`, chained into `pretest` so violations fail
  the suite locally, not just in CI.

**Acceptance criteria:** `npm run boundaries` passes on the finished feature; a
deliberately added violating import fails it; `pretest` runs it.

### FR-1000 Run protocol & demonstration readiness — spec: [benchmark-measurement.md](benchmark-measurement.md#run-protocol-the-demonstration)

- **FR-1001 Protocol (specified, ready to execute).** One invocation per agent, all
  three of that agent's arms together (same CLI version, same day, same task-set hash),
  then one report:

  ```bash
  npm run bench -- run --task all \
    --arms claude-without,claude-with,claude-with-skill \
    --runs 4 --model claude-opus-4-8
  npm run bench -- run --task all \
    --arms codex-without,codex-with,codex-with-skill \
    --runs 4 --model gpt-5.5
  npm run bench -- report --name skills-gap
  ```

  Models pinned to the cheaper tier: **`claude-opus-4-8`** (Claude Code), **`gpt-5.5`**
  (Codex CLI). Task scope `all` includes the FR-800 expansion and tag-filtered
  `generated:v1` tasks.
- **FR-1002 Reps budget.** **N=2** for content-iteration loops
  ([content doc §iteration loop](skill-content-design.md#content-iteration-loop));
  **N=4** for the final report run. Document both in `benchmarks/README.md`.
- **FR-1003 Smoke verification (gates acceptance).** A recorded smoke run — a small task
  subset, low reps, all three arms per agent, both agents — proving end-to-end
  mechanics: artifacts injected at the correct workspace paths, `skill_set` hash and
  `baseline_calls` in the records, cache split populated, adoption computed, three-way
  report (with structure-heavy row and exclusion counts) renders. The full paid protocol
  run is **not** part of acceptance; it is executed separately at the user's discretion
  and evaluated against the §3 gates when run.
- **FR-1004 Docs.** `benchmarks/README.md` gains the six-arm model, protocol, and reps
  budgets; `docs/agent-skills.md` and `integrations/README.md` gain pointers to this
  docset (pointer updates only — no content moves).

**Acceptance criteria:** the smoke run's dated report is committed under
`benchmarks/results/` and shows all FR-1003 mechanics; the protocol commands in the
README execute as written (verified by the smoke subset with reduced `--task`/`--runs`);
README documents N=2 / N=4 budgets and the pinned model ids.

## 5. Sequencing (build order)

1. **FR-400 + FR-500 + FR-600** — arm model, injection, record schema (the wiring
   everything else observes). Verify: unit tests green; four-arm behavior unchanged.
2. **FR-700** — report extensions incl. the flagged-run prerequisite fix. Verify:
   report over existing `runs.jsonl` unchanged for legacy rows, new columns present.
3. **FR-100 + FR-200 + FR-300** — skill content and contract test (content edits are
   cheap once measurable). Verify: contract test green; budgets met.
4. **FR-800** — task mix expansion + generator wiring + prompt validation.
5. **FR-900** — boundary tooling (can land any time; must be green at feature end).
6. **FR-1000** — README/protocol docs + smoke verification run.
7. Content-iteration loops (N=2) against the §3 gates as budget allows; the full N=4
   demonstration run remains a user-triggered event.

## 6. Risks & mitigations — from [benchmark-measurement.md](benchmark-measurement.md#validity-threats-stated)

| Risk | Mitigation in this PRD |
|---|---|
| Skill text overfits bench tasks | FR-302 leakage test, FR-304 generality review, FR-803 tool-agnostic prompts |
| Skill saves tokens by being wrong faster | G4 correctness gate; FR-705 marker |
| Claude trigger variance read as content failure | FR-702 adoption metric + FR-404 diagnostic mode |
| Instruction context cost hidden | Injected instructions are inside measured totals; FR-105/FR-203 budgets |
| Codex measurement instability | FR-706 flagged-run exclusion; G3 is directional, not numeric |
| Generator circularity inflates the gap | Same-key grading is arm-neutral; FR-802 spot-validation retained |
