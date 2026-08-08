# Task Decomposition — Skills & Token-Gap Measurement

> **Source of truth:** [prd.md](prd.md) (requirements & acceptance thresholds), built on
> [architecture.md](architecture.md), [skill-content-design.md](skill-content-design.md),
> and [benchmark-measurement.md](benchmark-measurement.md). Every FR in the PRD maps to
> at least one development task below (coverage matrix at the end). Stages follow the
> PRD's §5 build order.

## Conventions

- **ID scheme.** `SK-D##` development task, `SK-Q##` its QA task, `SK-R##` its review
  task. The numeric suffix binds the triple: `SK-Q03` tests `SK-D03`; `SK-R03` reviews
  both. IDs are stable — never renumber; add new IDs at the end of a stage.
- **Three roles per task, three agents.** The **developer** implements. The **QA agent**
  writes/extends the tests that prove the dev task's completion criteria (a different
  agent from the developer). The **reviewer** is a distinct code-review agent that
  approves the dev task against its completion criteria, the cited FRs, and CLAUDE.md
  (surgical changes, simplicity) — approval is independent, never self-graded by the
  developer or QA agent.
- **Ordering within a triple.** `SK-D##` → `SK-Q##` → `SK-R##`. QA may start from the
  dev task's stated criteria in parallel where noted, but the review runs last and
  blocks the triple's "done". A review rejection reopens the dev task (same IDs).
- **Test-first option.** Where the PRD's acceptance criteria *are* tests (most of
  stages 1–2), the QA agent may land failing tests first; the dev task then makes them
  pass. Either order is acceptable; the review checks both sides.
- **Definition of done (every dev task).** `npm test` green (includes `pretest` build;
  after SK-D14, also boundaries); no changes outside the task's listed files except
  mechanical ripples explicitly noted; four-arm benchmark behavior byte-identical unless
  the task says otherwise.
- **Verification budget note.** No task in this document spends paid agent sessions
  except SK-D15 (the smoke run), which is deliberately small. The full N=4 protocol run
  is explicitly **not** a task here (PRD non-goal / FR-1000).

---

## Stage 1 — Wiring: arm model, injection, record schema (FR-400, FR-500, FR-600)

Everything else observes this wiring. Stage exit: all stage-1 triples approved; existing
four-arm behavior unchanged (argv and records byte-identical for the four current arms).

### SK-D01 — Six-arm union & predicates

- **FRs:** FR-401, FR-402.
- **Goal:** Grow `Arm` to six values (`claude-with-skill`, `codex-with-skill`); replace
  the `endsWith("-with")` contract with explicit set membership `isWithArm()` (true for
  `with` **and** `with-skill` arms); add `hasSkill(arm)` predicate; grow `ALL_ARMS` in
  `run.ts` to six and keep `--arms` defaulting to all six; replace every
  `arm.endsWith("-with")` call site in the harness (`run.ts` lines ~156, ~246 use it for
  mcp-config and index-build gating) with `isWithArm()` so skill arms get tools + index.
- **Files:** `benchmarks/harness/adapters/types.ts`, `benchmarks/harness/run.ts`.
- **Completion criteria:**
  - `Arm` has exactly six values; `isWithArm` truth table: true for the four `*-with*`
    arms, false for the two `*-without` arms; `hasSkill` true only for the two
    `*-with-skill` arms.
  - `parseBenchArgs` accepts the two new arms and rejects unknown ones; `--arms`
    default is all six.
  - Skill arms take the with-arm path for `mcpConfigFor` and `buildIndex` in `benchRun`.
  - No behavior change for the four existing arms (existing tests green unmodified
    except where they pin `ALL_ARMS` length).
- **Dependencies:** none (stage start).

### SK-Q01 — Tests: arm union & predicates

- **Goal:** Pin the new contract in `test/bench-claude-adapter.test.ts` and
  `test/bench-codex-adapter.test.ts` (per FR-402 these adapter suites own the truth
  tables), plus `test/bench-harness.test.ts` for arg parsing.
- **Tests to add:** full `isWithArm`/`hasSkill` truth table over all six arms;
  `parseBenchArgs` default arms = six; unknown-arm rejection still works;
  `resolveTasks`/run-loop gating uses with-family membership (fake-deps run with a
  `*-with-skill` arm calls `buildIndex` and `mcpConfigFor`).
- **Completion criteria:** tests fail against pre-SK-D01 code (endsWith semantics),
  pass after; existing tests untouched except additive cases.
- **Dependencies:** SK-D01 (or test-first in parallel).

### SK-R01 — Review: arm union & predicates

- **Goal:** Independent approval of SK-D01 + SK-Q01.
- **Checklist:** breaking contract change is complete (no `endsWith("-with")` survivors —
  grep the whole repo, including `report.ts`'s private `isWith`, which is fixed in
  SK-D05/SK-D06 — flag any call site the stage-1 tasks miss); four-arm argv byte-identical;
  truth tables exhaustively pinned; no speculative additions.
- **Completion criteria:** written approval or change-request list; on approval the
  triple closes.
- **Dependencies:** SK-D01, SK-Q01.

### SK-D02 — Adapter skill-arm deltas, diagnostic mode, cache-split metrics

- **FRs:** FR-403 (argv delta), FR-404 (diagnostic mode), metric source for FR-603.
- **Goal:**
  1. Claude adapter: for `claude-with-skill`, the **only** argv delta vs `claude-with`
     is adding `Skill` to `--allowedTools` (parity ladder — nothing removed). Codex
     adapter: **no** argv delta for `codex-with-skill` (file presence suffices).
  2. Diagnostic mode: `InvocationOptions` gains an optional
     `systemPromptSkill?: string` (content supplied by the composition root in SK-D04,
     keeping artifact paths out of the adapter); when set on a Claude skill-arm
     invocation, inject via `--append-system-prompt` instead of relying on the file
     copy. Env gating (`BENCH_SKILL_MODE=system-prompt`) and the
     `skill_mode:system-prompt` record flag are wired in SK-D04.
  3. Cache split: `RunMetrics` gains `tokensCacheRead` / `tokensCacheCreation`
     (`tokensCache` kept, back-compat). Claude parser fills both from
     `cache_read_input_tokens` / `cache_creation_input_tokens`; Codex parser fills
     `tokensCacheRead` from `cached_input_tokens`/`cache_read_input_tokens` and leaves
     `tokensCacheCreation` 0 (the CLI does not report it). `emptyMetrics()` extended.
- **Files:** `benchmarks/harness/adapters/types.ts`,
  `benchmarks/harness/adapters/claude.ts`, `benchmarks/harness/adapters/codex.ts`.
- **Completion criteria:** argv for the four existing arms byte-identical; skill-arm
  argv deltas exactly as above; parsers populate the split consistently with the
  existing `tokensCache` sum; `computeCost` unchanged.
- **Dependencies:** SK-D01.

### SK-Q02 — Tests: adapter deltas & cache split

- **Goal:** Extend `test/bench-claude-adapter.test.ts` / `test/bench-codex-adapter.test.ts`.
- **Tests to add:** argv snapshot for all six arms per adapter proving (a) four-arm
  byte-identity with pre-change snapshots, (b) `Skill` in allowedTools only for
  `claude-with-skill`, (c) codex argv identical between `codex-with` and
  `codex-with-skill`; `--append-system-prompt` present iff `systemPromptSkill` set and
  never for non-skill arms; stream-parse fixtures asserting the read/creation split and
  that `tokensCache == read + creation` (claude) / read-only split (codex).
- **Completion criteria:** the PRD's FR-400 acceptance ("pin the truth tables and
  skill-arm argv deltas; four-arm behavior byte-identical") is fully covered by tests.
- **Dependencies:** SK-D02.

### SK-R02 — Review: adapter deltas & cache split

- **Checklist:** parity ladder strictly additive (nothing removed from lower rungs);
  the *only* claude delta is the `Skill` tool; no `integrations/` path literals in
  adapters (FR-505 discipline); baseline tool list untouched; codex cache semantics
  documented in-code where non-obvious.
- **Dependencies:** SK-D02, SK-Q02.

### SK-D03 — Instruction-injection module (`instructions.ts`)

- **FRs:** FR-501, FR-503, FR-504 (FR-502/FR-505 wiring lands in SK-D04).
- **Goal:** New `benchmarks/harness/instructions.ts`, pure/impure split per the
  architecture layer table:
  - `planInstructions(arm)` — pure truth table: `claude-with-skill` →
    `[{source: <claude SKILL.md under integrations/>, destRelPath: ".claude/skills/code-index/SKILL.md"}]`;
    `codex-with-skill` → `[{source: <codex AGENTS.md>, destRelPath: "AGENTS.md"}]`; all
    other four arms → `[]`. Sources are `integrations/`-relative descriptors resolved
    to absolute paths by the caller (composition root), keeping the plan pure.
  - `installInstructions(workspaceDir, arm)` — copies planned artifacts into the
    workspace; returns `sha256[..12]` of injected content, `null` for non-skill arms.
  - Claude pre-existing-file rule: throw if the workspace already contains `.claude/`
    (isolation violation).
  - Codex rules: if the target ships an `AGENTS.md`, append the section after a
    separator and report an `agents_md_appended` signal to the caller (return shape may
    be `{ hash, flags }` — design the signature so SK-D04 can stamp the flag);
    strip the HTML template-comment header at install (the sole content transform).
  - Hash is computed over the **post-transform** injected content (what the agent
    actually sees), stable across runs.
- **Files:** `benchmarks/harness/instructions.ts` (new).
- **Completion criteria:** module has no imports from `run.ts`/`report.ts`; no
  `integrations/...` absolute path literals baked into the pure plan; behavior above
  fully implemented.
- **Dependencies:** SK-D01 (Arm union).

### SK-Q03 — Tests: `test/bench-instructions.test.ts` (new)

- **Goal:** The PRD's FR-500 unit-test surface.
- **Tests to add:** `planInstructions` truth table for all six arms; install into a
  temp workspace copies SKILL.md to `.claude/skills/code-index/SKILL.md`; codex install
  writes root `AGENTS.md`, strips the HTML header (pinned: output contains no
  `<!--`), appends after a separator when a target `AGENTS.md` pre-exists and signals
  `agents_md_appended`; returns a stable 12-hex hash (same content → same hash; edit →
  different hash); returns null for the four non-skill arms and writes nothing; throws
  on pre-existing `.claude/`; install is idempotent-safe for repeated fresh workspaces.
- **Completion criteria:** every FR-501/503/504 behavior has a failing-before /
  passing-after test.
- **Dependencies:** SK-D03 (or test-first in parallel).

### SK-R03 — Review: instructions module

- **Checklist:** pure/impure split honored (plan unit-testable without fs); single-source
  rule (sources under `integrations/`, no copied body text); header strip is the *only*
  transform; hash covers post-transform content; error messages actionable.
- **Dependencies:** SK-D03, SK-Q03.

### SK-D04 — Harness wiring & record schema extensions

- **FRs:** FR-502, FR-505, FR-601–FR-605.
- **Goal:**
  1. `HarnessDeps` gains `installInstructions(workspaceDir, arm)` returning the hash
     (+ flags signal per SK-D03's signature). `benchRun`/`executeRun` call it **after**
     workspace materialization and index build, **before** agent invocation, for skill
     arms only (plan-empty arms are a no-op).
  2. `defaultDeps()` (composition root) resolves where `integrations/` lives on disk
     and supplies the real installer — the only module that knows artifact paths
     (FR-505). It also reads `BENCH_SKILL_MODE=system-prompt`: in that mode, load the
     SKILL.md body, pass it as `systemPromptSkill` to the claude adapter instead of
     file-installing, and add the `skill_mode:system-prompt` flag (FR-404).
  3. `RunRecord` extensions (append-only JSONL; additive): `versions.skill_set`
     (hash or null), `metrics.tokens_cache_read` / `tokens_cache_creation` (from
     SK-D02's split; `tokens_cache` kept), `metrics.baseline_calls` (persist the
     already-parsed value currently dropped at record-write), `flags` may carry
     `agents_md_appended` / `skill_mode:system-prompt`.
- **Files:** `benchmarks/harness/run.ts`.
- **Completion criteria:** skill-arm records carry a 12-hex `skill_set`, non-skill
  records carry `null`; `baseline_calls` and the cache split land in every new record;
  ordering (materialize → buildIndex → installInstructions → runAgent) observable via
  fake deps; four-arm records unchanged except the new additive fields.
- **Dependencies:** SK-D01, SK-D02, SK-D03.

### SK-Q04 — Tests: harness wiring & record schema

- **Goal:** Extend `test/bench-harness.test.ts` with fake-deps coverage.
- **Tests to add:** `installInstructions` called for the two skill arms only; call
  order asserted (after `buildIndex`, before `runAgent`); `skill_set` in skill-arm
  records and null otherwise; `baseline_calls`, `tokens_cache_read`,
  `tokens_cache_creation` present in records; `agents_md_appended` propagates from the
  installer into `flags`; system-prompt mode sets the flag and skips file install
  (fake-level, no real env needed beyond one env-gated case); legacy record shape still
  parses through `readRuns`.
- **Completion criteria:** PRD FR-500/FR-600 acceptance lines all covered.
- **Dependencies:** SK-D04.

### SK-R04 — Review: harness wiring & record schema

- **Checklist:** `integrations/` path knowledge confined to `defaultDeps()`; run loop
  still pure/DI'd (no new fs in `benchRun`/`executeRun`); record fields additive only —
  nothing renamed or removed; JSONL back-compat argued and tested; diagnostic mode can
  never fire on headline runs silently (flag always stamped).
- **Dependencies:** SK-D04, SK-Q04.

---

## Stage 2 — Report extensions (FR-700)

Stage exit: `bench report` over the existing `results/runs.jsonl` runs without error;
legacy rows aggregate as before; new columns present.

### SK-D05 — Report aggregation: exclusions, adoption, token composition

- **FRs:** FR-706 (prerequisite fix), FR-702, FR-703, FR-707 (aggregation half),
  legacy-record tolerance (FR-600 acceptance).
- **Goal:** In `report.ts`'s pure aggregation:
  - **Flagged-run exclusion:** runs flagged `no_result` / `agent_error` / `timeout` or
    with zero recorded tokens are excluded from all ratio and win/loss aggregation;
    excluded counts surface in `ReportData` (per agent × arm).
  - **Diagnostic exclusion:** runs flagged `skill_mode:system-prompt` excluded from
    headline aggregation, collected separately for display.
  - **Adoption metric:** per arm, median `mcp_calls / tool_calls` (0 when
    `tool_calls` = 0). Tolerate legacy records (missing `baseline_calls` etc.).
  - **Token composition:** per-category cells gain `fresh-in / cache-read / out`
    medians beside the total; legacy records without the split render `—`.
  - Replace the private `isWith()` (`endsWith("-with")`) with the shared predicates
    from `types.ts` (completes SK-D01's contract change in this file).
- **Files:** `benchmarks/harness/report.ts`.
- **Completion criteria:** aggregation functions pure and unit-testable; excluded runs
  demonstrably absent from every ratio; adoption and composition computed per spec;
  `readRuns` + `buildReport` succeed over the checked-in legacy `runs.jsonl`.
- **Dependencies:** SK-D04 (record fields), SK-D01 (predicates).

### SK-Q05 — Tests: aggregation, exclusions, adoption

- **Goal:** Extend `test/bench-report.test.ts` with synthetic record sets.
- **Tests to add:** each flag class and the zero-token case individually excluded from
  ratios and win/loss, with excluded counts reported; `skill_mode:system-prompt` runs
  out of the headline but retrievable; adoption medians incl. the 0-tool-calls and
  legacy-record cases; token-composition medians incl. missing-split legacy rows; a
  fixture file of pre-extension records aggregates identically to pre-change behavior.
- **Dependencies:** SK-D05.

### SK-R05 — Review: report aggregation

- **Checklist:** exclusion applied uniformly (no path where a flagged run leaks into a
  median); pure aggregation kept free of fs/rendering; legacy tolerance is real
  (undefined-safe field access), not `as any` suppression; predicates shared, not
  re-derived locally.
- **Dependencies:** SK-D05, SK-Q05.

### SK-D06 — Report headline: three-way ratios, structure-heavy row, markers, render

- **FRs:** FR-701, FR-704, FR-705, FR-707 (render half).
- **Goal:**
  - **Three-way headline per agent:** `with/without`, `with-skill/with`,
    `with-skill/without` (the headline), correctness Δ (skill vs without), adoption
    (skill arm), index build s. Ratios are medians of per-task paired ratios within one
    agent (note: this refines today's median-of-medians quotient — pin the paired-ratio
    definition in code and tests).
  - **Structure-heavy subset row per agent:** same ratios over `callers-impact` +
    `cross-file-navigation` + `rename-refactor` pairs only (gate G1 readable directly).
  - **Win/loss/tie** for both `with vs without` and `with-skill vs without`.
  - **Correctness marker:** any headline row with correctness Δ < 0 renders an explicit
    regression marker; no ratio is ever rendered without its correctness column.
  - **Render:** markdown gains the three-way table, subset rows, excluded-run counts,
    a separate diagnostic section when `system-prompt` runs exist, and the token-composition
    columns from SK-D05.
- **Files:** `benchmarks/harness/report.ts`.
- **Completion criteria:** `bench report` over existing `runs.jsonl` (four-arm legacy
  data) renders: three-way columns show `—` where an arm is absent; all FR-701/704/705
  elements present in output.
- **Dependencies:** SK-D05.

### SK-Q06 — Tests: three-way headline & render

- **Goal:** Extend `test/bench-report.test.ts`.
- **Tests to add:** three-way ratio math on synthetic six-arm records (incl. paired-ratio
  median definition, missing-arm null handling); structure-heavy subset uses exactly
  the three categories; win/loss/tie for both pairs; regression marker appears iff
  Δ < 0 and sits beside the ratio in rendered markdown; excluded counts and diagnostic
  section render; legacy-only record set produces a valid report (no NaN/undefined in
  output).
- **Dependencies:** SK-D06.

### SK-R06 — Review: report headline

- **Checklist:** ratio semantics consistent between headline, subset row, and
  win/loss (same pairing, same exclusions); the marker cannot be bypassed by any render
  path; markdown stays parseable/diff-friendly; no aggregation logic leaked into
  `renderMarkdown`.
- **Dependencies:** SK-D06, SK-Q06.

---

## Stage 3 — Skill content & contract test (FR-100, FR-200, FR-300)

SK-D07 and SK-D08 are content-authoring tasks and may run in parallel; SK-D09 (the
contract test) must pass against both finished artifacts. Stage exit: contract test
green on shipped artifacts; budgets met.

### SK-D07 — Claude skill content (`SKILL.md`)

- **FRs:** FR-101–FR-105.
- **Goal:** Extend `integrations/claude/skills/code-index/SKILL.md` **in place** (the
  67-line skeleton is the base) into the full-depth playbook:
  - Frontmatter `description` rewritten to fire on *situations* (orient in a repo,
    find definition/callers, blast radius before an edit, keyword/AST search, safe
    rename); `name: code-index` unchanged.
  - Body order: contract line → session opener (`index_status` once; on error fall
    back for the whole session) → routing table with "Not" column → **hard budget
    rules** (before recipes — skim/truncation survival) → seven recipes → fallback &
    confidence rules.
  - All seven recipes (orientation, symbol lookup, callers/impact, concept
    localization, cross-file trace, rename/refactor, shape queries) with explicit
    chains, turn budgets, and stop conditions per the content doc's recipe table —
    including rename's after-edit discipline (`reindex {}` → re-query the **old** name)
    and callers' corroboration rule (`unresolved_edges` high → widen with `search_code`).
  - The five hard rules as prohibitions (no full-file Read after an index hit; no file
    content via Bash `cat`/`sed`/`head`; no Grep for an index-resolvable symbol; batch
    independent index calls; answer when answered).
  - Body ≤ 150 lines excluding frontmatter; additive language only (never claims
    baseline tools are unavailable); all 11 catalog tools named; no benchmark-task
    leakage (target names, task ids, seed symbols).
- **Files:** `integrations/claude/skills/code-index/SKILL.md`.
- **Completion criteria:** structure/order as above; ≤ 150 body lines; 7 recipes with
  turn budgets; 5 prohibitions; passes SK-D09's contract test once it exists.
- **Dependencies:** stages 1–2 not required to *author*, but the measurement loop
  (stages 1–2) should be merged first per PRD sequencing ("content edits are cheap once
  measurable"). Hard dependency: none.

### SK-Q07 — Tests: SKILL.md mechanical budget checks

- **Goal:** The FR-100 acceptance criteria that are mechanically checkable, as tests
  (these land in `test/integrations-contract.test.ts` alongside SK-D09's guardrails;
  coordinate file ownership — SK-Q07 owns the *budget/structure* describe block).
- **Tests to add:** body line count ≤ 150 excluding frontmatter; frontmatter has
  `name: code-index`; description mentions the trigger situations; all seven recipe
  headings present; each of the five prohibitions present (keyword-level assertions,
  e.g. `get_chunk`, `reindex`, `unresolved_edges` appear in the required sections);
  rules section precedes recipes section.
- **Completion criteria:** tests pass on SK-D07's artifact and fail on the pre-change
  skeleton (which lacks turn budgets and several recipes).
- **Dependencies:** SK-D07.

### SK-R07 — Review: SKILL.md content

- **Goal:** Independent content review — this is where FR-304 and content-doc
  guardrail 3 live.
- **Checklist:** additive language only (no sentence implies baseline tools are
  unavailable); generality question per FR-304 ("would this sentence help in a repo
  we've never benchmarked?") answered *yes* for every rule/recipe line, recorded in the
  approval note for the commit message; no benchmark leakage beyond what the
  mechanical test catches (paraphrases of task prompts count); recipes faithful to the
  content-doc table; correctness devices (corroboration, after-edit reindex) present
  and prominent.
- **Dependencies:** SK-D07, SK-Q07.

### SK-D08 — Codex AGENTS.md content

- **FRs:** FR-201–FR-204.
- **Goal:** Extend `integrations/codex/AGENTS.md` **in place** (29-line skeleton):
  contract line; routing table with merged "Not" column; the five hard rules; one-line
  after-edit rule; one-line fallback rule; a single "chain, don't wander" line plus the
  two highest-payoff chains (callers/impact and rename — revisited on bench evidence);
  HTML template-comment header retained (stripped at install by SK-D03, not here).
  Body ≤ 40 lines excluding the HTML comment header. All 11 tools named; additive
  language; no leakage.
- **Files:** `integrations/codex/AGENTS.md`.
- **Completion criteria:** ≤ 40 body lines; both named chains present; header intact;
  passes SK-D09's contract test.
- **Dependencies:** none hard; same sequencing note as SK-D07.

### SK-Q08 — Tests: AGENTS.md mechanical budget checks

- **Goal:** Budget/structure describe block for the codex artifact in
  `test/integrations-contract.test.ts`.
- **Tests to add:** body ≤ 40 lines excluding the HTML comment header; header present
  and well-formed (`<!--` … `-->` before content); the five prohibitions present; the
  callers/impact and rename chains present; "Not"-column routing table present.
- **Completion criteria:** pass on SK-D08's artifact; the line-count test must
  correctly exclude the header (pinned by a fixture).
- **Dependencies:** SK-D08.

### SK-R08 — Review: AGENTS.md content

- **Checklist:** every line justifies its per-session tax (condensed, no filler);
  FR-304 generality question recorded; additive language; consistent with SKILL.md's
  rules (same prohibitions, same fallback semantics — divergence in depth, not in
  doctrine).
- **Dependencies:** SK-D08, SK-Q08.

### SK-D09 — Content guardrails & contract test

- **FRs:** FR-301, FR-302, FR-303 (FR-304 is process, owned by SK-R07/SK-R08).
- **Goal:** New `test/integrations-contract.test.ts` guardrail block enforcing, for
  **both** artifacts:
  - **Tool-name completeness & freshness:** every artifact names all 11 catalog tools
    (`index_status`, `module_map`, `file_outline`, `find_symbol`, `who_calls`,
    `impact_of_change`, `get_dependencies`, `search_code`, `search_structural`,
    `get_chunk`, `reindex` — source the canonical list from the server's tool
    registration or `docs/mcp-server.md`, not a hand-copied array, so catalog drift is
    caught in both directions); no `snake_case` tool-like names outside the catalog.
  - **No benchmark leakage:** no string from the task registry's id/target/key fields
    (task ids, target names `zod`/`fixture-ts`/`self` as used by targets, seed-task
    symbol names, answer-format strings) appears in either artifact — derive the
    forbidden-string set programmatically from `benchmarks/tasks.ts`/`seed-tasks.ts`
    exports at test time (word-boundary matching to avoid false positives on common
    words).
  - **Single source:** the skill body text exists only under `integrations/` — fail if
    any file under `benchmarks/` contains a duplicated body (detect via a distinctive
    multi-word sentence sampled from each artifact).
  - **Mutation self-verification:** the suite includes mutation cases against in-test
    fixture copies proving the checks fire: tool name removed → fail; fake 12th tool
    added → fail; task id inserted → fail; body duplicated under a temp `benchmarks/`
    shadow → fail.
- **Files:** `test/integrations-contract.test.ts` (new; shared with SK-Q07/SK-Q08
  blocks).
- **Completion criteria:** the PRD's FR-300 acceptance sentence holds verbatim: fails
  on each mutation class (verified inside the test via fixtures), passes on the shipped
  artifacts.
- **Dependencies:** SK-D07, SK-D08 (must pass on their outputs); can be drafted in
  parallel against the skeletons.

### SK-Q09 — Tests: contract-test mutation verification

- **Goal:** SK-D09 is itself a test; QA validates the *validator*. Audit and extend the
  mutation fixtures: confirm each guardrail has at least one failing mutation and one
  passing control; add any missing mutation class (e.g. leakage via seed-task symbol
  name, not just task id; catalog list source drift — remove a tool from the canonical
  source and assert the completeness check direction flips).
- **Files:** `test/integrations-contract.test.ts`.
- **Completion criteria:** every FR-301/302/303 clause has both a red and a green case;
  running the suite on shipped artifacts is green.
- **Dependencies:** SK-D09.

### SK-R09 — Review: contract test

- **Checklist:** forbidden-string derivation is from live registry exports (not a
  frozen copy that rots); word-boundary logic can't be gamed or over-trigger; canonical
  tool list has one source of truth; test remains fast (no fs walks outside
  `integrations/` + `benchmarks/`).
- **Dependencies:** SK-D09, SK-Q09.

---

## Stage 4 — Task mix (FR-800)

Stage exit: registry validation live; structure-heavy coverage ≥ 2 authored tasks per
category on each of `oss-zod` and `self`; generator behind tag filter.

### SK-D10 — Tool-agnostic prompt validation (registry rule)

- **FRs:** FR-803.
- **Goal:** Extend `validateTasks` in `benchmarks/tasks.ts` with a load-time rule:
  reject any task whose **prompt** names a retrieval mechanism — the MCP tool names
  (the 11-tool catalog), the strings "MCP", "code-index"/"code index", and
  "index"-as-mechanism (word-boundary, case-insensitive; scoped so legitimate prompt
  words are not false-positived — e.g. a prompt asking about the repo's own
  `src/index.ts` must remain valid, so the rule should target mechanism phrases like
  "the index"/"indexed"/"reindex" and tool names rather than the bare substring).
  Applies to all tasks (authored and generated) at load.
- **Files:** `benchmarks/tasks.ts`.
- **Completion criteria:** a task prompt containing `find_symbol`, "use MCP", or "query
  the index" throws `TaskValidationError` at load; the entire existing seed set still
  validates; the rule's false-positive boundary is documented in a comment.
- **Dependencies:** none within stage 4; do first (SK-D11/SK-D12 tasks must pass it).

### SK-Q10 — Tests: prompt validation rule

- **Goal:** Extend `test/bench-registry.test.ts`.
- **Tests to add:** rejection cases for each forbidden class (tool name, "MCP",
  "code-index", mechanism-"index" phrasing); acceptance cases for near-misses
  (`src/index.ts` path in a prompt, "indexOf", "indentation"); the full shipped
  registry loads clean.
- **Dependencies:** SK-D10.

### SK-R10 — Review: prompt validation

- **Checklist:** rule matches the PRD's intent (mechanism mentions, not vocabulary
  accidents); error message names the offending substring; no weakening of existing
  validations.
- **Dependencies:** SK-D10, SK-Q10.

### SK-D11 — Structure-heavy seed-task expansion

- **FRs:** FR-801.
- **Goal:** Add **6–12 hand-authored tasks** to `benchmarks/seed-tasks.ts` filling gaps
  to the 2-per-category-per-target convention for `callers-impact`,
  `cross-file-navigation`, `rename-refactor` on `oss-zod` and `self`. Current coverage
  (from the registry): callers-impact already has 2 on each; cross-file-navigation has
  2 on `oss-zod` + 2 on `self`; rename-refactor has 2 on `oss-zod` + 2 on `self` — so
  the additions should *deepen* multi-hop coverage (the PRD's intent: tasks where
  sequencing compounds — e.g. transitive-caller chains, multi-file rename with ≥ 3 edit
  sites, cross-barrel traces), keeping to ≥ 2 per cell and adding roughly 1–2 more per
  cell up to the 6–12 budget. Keys must be derived by actually inspecting the target
  repos (grader keys are ground truth — verify each against the materialized target);
  prompts must pass SK-D10's rule; small-fixture tasks untouched (regression floor).
- **Files:** `benchmarks/seed-tasks.ts`.
- **Completion criteria:** 6–12 new tasks, all in the three structure-heavy categories
  on `oss-zod`/`self`; each cell (category × target) has ≥ 2 authored tasks; registry
  validates at load; each new grader key hand-verified against the target source (note
  the verification in the task's code comment, matching the existing seed style).
- **Dependencies:** SK-D10.

### SK-Q11 — Tests: seed expansion integrity

- **Goal:** Extend `test/bench-seed.test.ts` / `test/bench-registry.test.ts`.
- **Tests to add:** coverage assertion — each structure-heavy category × {`oss-zod`,
  `self`} has ≥ 2 authored (`tags` contains "authored") tasks; new task ids follow the
  existing id convention; all new tasks pass validation incl. SK-D10's rule; edit-tier
  additions use `test-diff` graders with non-empty `mustMatch`/`mustNotMatch`;
  spot-check a sample of new keys mechanically where cheap (e.g. `path:line` keys point
  at files that exist in the pinned target checkout, if the target cache is available —
  skip-guard otherwise, matching existing seed-test patterns).
- **Dependencies:** SK-D11.

### SK-R11 — Review: seed expansion

- **Checklist:** prompts tool-agnostic *in spirit*, not just mechanically (no steering
  toward index-shaped phrasing — FR-803's "not gaming" intent); keys plausibly correct
  (reviewer independently spot-verifies ≥ 3 keys against the targets); difficulty
  genuinely multi-hop rather than restated existing tasks; timeouts realistic vs
  existing same-category tasks.
- **Dependencies:** SK-D11, SK-Q11.

### SK-D12 — Generator wiring behind a tag filter

- **FRs:** FR-802.
- **Goal:** Wire `benchmarks/generate-tasks.ts` (currently library-only) into the
  registry behind an **explicit tag filter**: generated entries carry `generated:v1`
  tags and inline keys; they are excluded from `TASKS` by default and included only
  when the filter is engaged (e.g. env `BENCH_INCLUDE_GENERATED=v1` or a
  `--task`-selector extension — pick the smallest mechanism consistent with
  `resolveTasks`; document the choice in-code). Scope initially to `oss-zod`.
  Generation must be deterministic per target checkout (stable ids) so `task_set`
  hashes are reproducible; generated tasks pass full validation (incl. SK-D10).
  Because generation reads an index DB of the materialized target, the wiring should
  generate-and-cache (a checked-in or cached snapshot produced by an explicit
  regeneration script — `npm run bench:generate` — rather than index-building at
  import time; import-time DB work would break `npm test`).
  Record the spot-validation protocol for generated keys (which sample, how verified)
  in `benchmarks/README.md`'s task-generation note (full README overhaul is SK-D14).
- **Files:** `benchmarks/generate-tasks.ts`, `benchmarks/tasks.ts`,
  `benchmarks/harness/run.ts` (selector only, if that mechanism is chosen),
  `package.json` (script), plus the generated-snapshot file under `benchmarks/`.
- **Completion criteria:** default `TASKS` unchanged (four-arm hash-stable when filter
  off); with the filter on, `oss-zod` generated tasks load, carry `generated:v1` +
  inline keys, and validate; a documented sample of generated keys is spot-validated
  (recorded in the README note); `hashTaskSet` differs between filter on/off (recorded
  in `versions.task_set`, keeping runs attributable).
- **Dependencies:** SK-D10 (validation applies), SK-D11 (id-space coordination).

### SK-Q12 — Tests: generator wiring

- **Goal:** Extend `test/bench-generate.test.ts` / `test/bench-registry.test.ts`.
- **Tests to add:** filter off → `TASKS` identical to authored-only (snapshot of ids);
  filter on → generated tasks present, all tagged `generated:v1`, all `oss-zod`, all
  valid under `validateTasks` incl. the prompt rule; generated ids deterministic across
  two loads; generated tasks never collide with authored ids; the regeneration script
  is idempotent on an unchanged target snapshot.
- **Dependencies:** SK-D12.

### SK-R12 — Review: generator wiring

- **Checklist:** filter default-off is airtight (no path adds generated tasks to a run
  silently); circularity posture unchanged from benchmark.md (same-key grading,
  spot-validation documented); snapshot regeneration reproducible; no import-time
  side effects.
- **Dependencies:** SK-D12, SK-Q12.

---

## Stage 5 — Boundary enforcement (FR-900)

Can land any time after stage 1; must be green at feature end (run last-ordered here so
it sees the finished import graph).

### SK-D13 — dependency-cruiser rules & wiring

- **FRs:** FR-901, FR-902.
- **Goal:** Add `dependency-cruiser` as a devDependency; new `.dependency-cruiser.cjs`
  encoding exactly the architecture's four rules: `src` isolated from
  `benchmarks|test|integrations`; adapters may not import
  `run.ts`/`report.ts`/`instructions.ts`; `benchmarks` → `src` only via the
  grandfathered `src/storage/meta` exact-path exception (a ratchet — no new
  exceptions); no circular dependencies. npm script
  `boundaries: depcruise src benchmarks --config .dependency-cruiser.cjs`, chained into
  `pretest` (note: `pretest` currently runs `npm run build`; chain, don't replace).
- **Files:** `.dependency-cruiser.cjs` (new), `package.json`, `package-lock.json`.
- **Completion criteria:** `npm run boundaries` passes on the finished feature;
  `npm test` runs boundaries via `pretest`; rules match the architecture sketch
  (severity `error` throughout).
- **Dependencies:** SK-D04 (instructions.ts must exist for the adapter rule to bind);
  final green gate after SK-D12.

### SK-Q13 — Verification: boundary rules fire

- **Goal:** Prove each rule catches its violation class. dependency-cruiser config is
  not unit-testable through vitest conveniently; QA delivers a scripted verification
  (temporary violating imports applied and reverted, e.g. via a scratch script that
  writes a violating file, runs `depcruise`, asserts non-zero exit, cleans up — checked
  in as a small test in `test/` invoking `depcruise` on fixture files, or as a
  documented manual protocol in the PR if tooling friction makes a test brittle;
  prefer the test).
- **Cases:** `src` → `benchmarks` import fails; adapter → `run.ts` import fails;
  `benchmarks` → `src/anything-but-storage-meta` fails while the grandfathered
  `src/storage/meta` import passes; a circular pair fails; clean tree passes.
- **Dependencies:** SK-D13.

### SK-R13 — Review: boundary enforcement

- **Checklist:** rule regexes anchored (`^src` not `src`); ratchet exception is
  exact-path; `pretest` chain doesn't mask build failures; no rules beyond the
  architecture's four (no speculative policy).
- **Dependencies:** SK-D13, SK-Q13.

---

## Stage 6 — Docs & smoke verification (FR-1000)

### SK-D14 — Protocol & docs updates

- **FRs:** FR-1001 (documentation of the protocol), FR-1002, FR-1004.
- **Goal:** `benchmarks/README.md` gains: the six-arm model and parity ladder; the
  demonstration protocol verbatim from the PRD (both `bench run` invocations with
  pinned models `claude-opus-4-8` / `gpt-5.5`, then `bench report --name skills-gap`);
  the reps budgets (N=2 content-iteration, N=4 final report); the generated-task
  filter usage (from SK-D12) and spot-validation note; the diagnostic
  `BENCH_SKILL_MODE` and its exclusion from headlines. `docs/agent-skills.md` and
  `integrations/README.md` gain pointers to `docs/skills/` (pointer updates **only** —
  no content moves).
- **Files:** `benchmarks/README.md`, `docs/agent-skills.md`, `integrations/README.md`.
- **Completion criteria:** protocol commands copy-paste runnable (flag names match
  `parseBenchArgs` as shipped); N=2/N=4 and both model ids documented; pointer-only
  diffs on the two pointer files.
- **Dependencies:** SK-D01–SK-D12 (documents what shipped).

### SK-Q14 — Tests/verification: docs accuracy

- **Goal:** Mechanical accuracy checks, not prose review: extract the fenced protocol
  commands from `benchmarks/README.md` and assert their flags parse via
  `parseBenchArgs` (arms valid, runs numeric) — a small test in
  `test/bench-harness.test.ts` or a new `test/bench-docs.test.ts`; assert the two
  pointer files reference `docs/skills/` paths that exist.
- **Dependencies:** SK-D14.

### SK-R14 — Review: docs

- **Checklist:** README teaches the *shipped* behavior (cross-check flags, env vars,
  file paths against code); pointer-only rule honored; no duplicated normative content
  (single source stays in `docs/skills/`).
- **Dependencies:** SK-D14, SK-Q14.

### SK-D15 — Smoke verification run (gates acceptance)

- **FRs:** FR-1003, and the executable verification of FR-1001.
- **Goal:** Execute and commit a recorded smoke run: a small task subset (e.g. one task
  per structure-heavy category on a small+large target mix), low reps (`--runs 1`),
  **all three arms per agent, both agents**, using the README's command shape with
  reduced `--task`/`--runs`; then `bench report` with a dated name. Requires the
  `claude` and `codex` CLIs installed and authenticated, and `npm run build` complete;
  this task spends a small real-session budget by design. Commit the dated report
  under `benchmarks/results/` (workspaces/runs.jsonl stay per existing gitignore
  policy).
- **Files:** `benchmarks/results/<date>-skills-smoke.md` (new; produced by
  `bench report`).
- **Completion criteria (the FR-1003 mechanics checklist, each verified in the run's
  artifacts):**
  1. Skill-arm workspaces contain the artifact at the correct path
     (`.claude/skills/code-index/SKILL.md` / root `AGENTS.md`, header stripped).
  2. Records carry `skill_set` (12-hex) on skill arms, null elsewhere.
  3. Records carry `baseline_calls` and the cache split.
  4. Adoption computed per arm in the report.
  5. Three-way report renders with structure-heavy row and exclusion counts.
  6. The README protocol commands executed as written (modulo `--task`/`--runs`).
- **Dependencies:** all prior dev tasks (SK-D01–SK-D14) approved.

### SK-Q15 — Verification: smoke-run evidence audit

- **Goal:** Independently audit the smoke run's evidence trail (not re-run it):
  inspect preserved workspaces under `results/runs/` for the six checklist items; parse
  the appended `runs.jsonl` lines and assert schema fields; confirm the committed
  report contains the three-way table, subset row, adoption, and exclusion counts.
  Deliver the audit as a checklist in the PR description (this QA task validates an
  execution, so its artifact is the audit record, not new test code).
- **Dependencies:** SK-D15.

### SK-R15 — Review: demonstration readiness

- **Checklist:** smoke report committed and dated; every FR-1003 mechanic evidenced;
  no gate G1–G4 claims made from smoke data (smoke proves mechanics, not the gap);
  full-protocol run correctly left as a user-triggered event; feature-level acceptance
  (PRD §3 "when gates are evaluated") satisfied at the FR level.
- **Dependencies:** SK-D15, SK-Q15.

---

## Post-acceptance (not gating — listed for completeness)

- **SK-O01 (optional, budget-gated):** content-iteration loops at N=2 per
  [skill-content-design.md §iteration loop](skill-content-design.md#content-iteration-loop):
  edit artifacts → smoke-scale run → keep iff `with-skill/without` improves and
  correctness Δ ≥ 0. Each kept edit re-passes SK-D07/SK-D08's budgets, the contract
  test, and an SK-R07/SK-R08-style content review (FR-304 recorded per commit). Not
  part of feature acceptance (PRD §5 item 7).
- **Full demonstration run** (N=4, both agents, `--task all`, gates G1–G4): explicitly
  a user-triggered event, out of scope per PRD non-goals and FR-1000.

## Dependency graph (dev tasks)

```
Stage 1: SK-D01 ──► SK-D02 ─┐
              └───► SK-D03 ─┴─► SK-D04
Stage 2: SK-D04 ──► SK-D05 ──► SK-D06
Stage 3: SK-D07 ─┐ (parallel)         (soft-ordered after Stage 2 per PRD §5)
         SK-D08 ─┴─► SK-D09
Stage 4: SK-D10 ──► SK-D11 ──► SK-D12
Stage 5: SK-D13 (after SK-D04; final green gate after SK-D12)
Stage 6: SK-D14 (after D01–D12) ──► SK-D15 (after D01–D14)
```

Within every triple: `SK-D##` → `SK-Q##` → `SK-R##`; a triple is done only on reviewer
approval.

## PRD coverage matrix

| PRD requirement | Dev | QA | Review |
|---|---|---|---|
| FR-101–FR-105 (Claude skill) | SK-D07 | SK-Q07 | SK-R07 |
| FR-201–FR-204 (Codex AGENTS.md) | SK-D08 | SK-Q08 | SK-R08 |
| FR-301–FR-303 (contract test) | SK-D09 | SK-Q09 | SK-R09 |
| FR-304 (generality review process) | — (process) | — | SK-R07, SK-R08 (+ SK-O01 loops) |
| FR-401, FR-402 (arm union, predicates) | SK-D01 | SK-Q01 | SK-R01 |
| FR-403, FR-404 (parity ladder argv, diagnostic mode) | SK-D02 (+ SK-D04 env gate) | SK-Q02, SK-Q04 | SK-R02, SK-R04 |
| FR-501, FR-503, FR-504 (plan, pre-existing, strip) | SK-D03 | SK-Q03 | SK-R03 |
| FR-502, FR-505 (deps wiring, path resolution) | SK-D04 | SK-Q04 | SK-R04 |
| FR-601–FR-605 (record schema) | SK-D04 (metric source: SK-D02) | SK-Q04 (+ SK-Q02) | SK-R04 |
| FR-701, FR-704, FR-705, FR-707 (headline, W/L/T, marker, diag excl.) | SK-D06 (+ SK-D05 aggregation) | SK-Q06 | SK-R06 |
| FR-702, FR-703, FR-706 (adoption, composition, flagged excl.) | SK-D05 | SK-Q05 | SK-R05 |
| FR-801 (seed expansion) | SK-D11 | SK-Q11 | SK-R11 |
| FR-802 (generator wiring) | SK-D12 | SK-Q12 | SK-R12 |
| FR-803 (tool-agnostic prompts) | SK-D10 | SK-Q10 | SK-R10 |
| FR-901, FR-902 (boundaries) | SK-D13 | SK-Q13 | SK-R13 |
| FR-1001, FR-1002, FR-1004 (protocol docs, budgets, pointers) | SK-D14 | SK-Q14 | SK-R14 |
| FR-1003 (smoke verification) | SK-D15 | SK-Q15 | SK-R15 |
| §3 gates G1–G4 | evaluated only at the user-triggered full run (see SK-R15, Post-acceptance) | | |

**Totals:** 15 development tasks, 15 QA tasks, 15 review tasks (45 gated tasks; plus
1 optional post-acceptance item SK-O01).
