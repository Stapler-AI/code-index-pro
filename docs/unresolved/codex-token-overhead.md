# Unresolved: codex token overhead with the code-index skill

**Status:** partially resolved. Overhead cut from ~2.0× to ~1.16× pooled and every remaining
token now demonstrably buys correctness — but codex still carries a **structural ~1.5× tax on
small tasks that content edits cannot remove**. The remaining lever (tier-3) is scoped but
unfunded. See the dated reports under `benchmarks/results/` for the raw numbers.

**Last updated:** 2026-08-09. **Owner:** whoever picks up tier-3.

---

## Context — what this is

The Skills & Token-Gap feature (a six-arm benchmark harness that measures how much the
`code-index` MCP server saves an agent in tokens, with/without the tool and with/without a
skill doc) shipped and is green (`npm test`: 55 files / 578 tests, boundaries clean). Its
first measured runs surfaced a real, uncomfortable finding:

| agent | `with-skill / without` token ratio |
|---|---|
| **claude** | **0.98** — the index pays (claude caches tool outputs) |
| **codex** | **~1.8–2.15** — the index *costs* (codex does not cache) |

The user directive was: **fix the codex token overhead.** This doc records the investigation,
the approaches tried, what worked, and what is left.

### Root cause (transcript-verified, structural)

Codex re-sends its **entire growing context as fresh (uncached) input on every tool
round-trip** (~30k tokens/step in this repo), plus a **fixed per-step tax** (the 11 MCP tool
schemas + the injected `AGENTS.md`, re-billed every step). Claude caches tool outputs, so its
fresh-in stays ~5.7k regardless of tool calls; codex's fresh-in scales with round-trip count.

Consequence: **for codex, an index call only pays when it replaces many baseline
round-trips/file-reads.** The skill's core thesis ("tens of tokens instead of thousands")
holds for claude and **inverts for codex.** No amount of `AGENTS.md` wording changes the
billing model — content can only remove *wasted* calls and steer *whether* to call at all.

---

## What we tried (chronological)

### 0. A grading bug we found and fixed first (SK-16, done)

Before touching tokens, the smoke run showed a codex correctness regression (−0.47) on a
rename task. Forensics proved it was **not** the skill: the agent's `reindex {}` call wrote a
`.code-index/` SQLite DB into the workspace, and the `test-diff` grader's `mustNotMatch` scan
read that **binary DB** — which still held the *old* symbol name in stale WAL pages — and
failed a byte-perfect-correct rename. This systematically penalized skill arms on every
edit-tier task.

**Fix (shipped, uncommitted):** `workspaceContent()` in
`benchmarks/harness/graders/deterministic.ts` now excludes `.code-index/` paths **and** binary
files from the grader's tree scan. Re-grading the preserved workspace flipped 0 → 1. Locked by
tests in `test/bench-graders.test.ts` (incl. an over-exclusion control: a real straggler in a
`.ts` still fails). This is a keeper regardless of the token work.

### 1. Tier-1 — "anti-wander" content edit (SK-D17, KEPT but insufficient)

**Hypothesis:** codex wanders (redundant calls after the answer is already in hand). Forensics
on the callers task confirmed it: the 2-hop chain `find_symbol → who_calls` had the answer at
call #2, then codex made 4 more calls (redundant `search_code` ×2, an FTS syntax error, a grep
fallback) — ~120k of 150k fresh tokens wasted.

**Edit (shipped):** made the callers chain terminal ("`who_calls` IS the caller set — don't
re-verify"), widened Rule 5 to forbid repeat/bigger `search_code`, added an FTS5 punctuation
warning, and a skippable `index_status` opener. Preserved the `unresolved_edges` corroboration
carve-out.

**Result (measured, 24 sessions):** **did not fix the aggregate.** `with-skill/without` rose
1.81 → ~2.0–2.15. It *worked on its target* (callers wandering dropped on one of two reps) and
improved correctness on hard tasks, but the aggregate was dominated by (a) the untouched rename
chain and (b) tasks where the index is inherently multi-call for codex. Verdict: content
nudges alone don't reliably beat codex's re-verify instinct. Report:
`benchmarks/results/2026-08-08-codex-tier1.md`.

### 2. Server-side output trimming (investigated, REJECTED as the lever this round)

**Hypothesis:** the 25.8KB `search_code` payload is the problem; trim server output.

**Finding (exploration):** the MCP server is already disciplined — row caps + `truncated`
flags (`src/query/caps.ts`), lean 0.2–0.7KB graph responses (80-char signature caps), and a
600-token whole-session budget test (`test/token-budget.test.ts`). The 25.8KB payload came
from codex *requesting* `limit:100` (default is 20 → 4.4KB) — behavioral, not a server-defaults
problem. Server trimming is **second-order** (it shrinks how fast context grows, but the
dominant term is round-trip count × re-sent context). Left out of scope this round by decision.

### 3. Tier-2 — cost-gated index use (SK-19, KEPT — this is the real fix)

**Hypothesis:** stop codex using the index where it *loses*; make it use the index only when
one call replaces many greps/reads.

**Edit (shipped, `integrations/codex/AGENTS.md`, 40/40 lines):**
- **Cost gate** in the intro: "every tool call re-sends your whole context as a fresh
  round-trip, so pick the plan with the fewest total calls: use the index when one call
  replaces many greps/reads … if one Grep or a ranged Read settles it, or the task is trivial,
  do that directly." Resolver: "the table matches question shapes; the gate decides whether the
  index runs."
- **Rule 3 re-scoped** (the load-bearing fix): "Never Grep for a symbol name **the index
  already resolved**" — the old blanket ban *forbade* the grep-sweep renames need.
- **Rename chain rewritten grep-centric:** grep the old name → edit all sites → one final grep
  with zero hits proves it. **No `reindex`, no index re-query mid-task.**
- Kept all tier-1 anti-wander devices; `reindex` made conditional (still named for the
  11-tool contract).

**Validation (54 sessions, N=3, same-batch tier-1 control, independently audited):**

| regime | `with-skill/without` (tier-2) | vs tier-1 control | correctness |
|---|---|---|---|
| **renames** | **0.83–0.97×** (0 MCP calls) | 1.06 / 1.79 | held / better (discoverfiles 3/3 vs 2/3) |
| **callers/impact** | 2.08–2.47× | ≈ identical | **+0.57 / +0.73** — index kept where it wins |
| **cheap/trivial** | ~1.56× | ≈ identical (1.57) | unchanged |
| **pooled** | **1.16** (was 2.15) | 1.48 | — |

**Verdict: KEEP** (SK-R20). 4 of 5 gates passed; the one failure (cheap tasks ≤ 1.25) is
**invariant to the artifact** — tier-1 posts the same 1.56, at equal-or-fewer calls — so it
measures the platform tax, not the content. Revert was strictly dominated on every endpoint.

---

## Current state (all uncommitted working-tree changes)

- `integrations/codex/AGENTS.md` — tier-2 cost-gated content (skill_set `70942470a2ed`)
- `benchmarks/harness/graders/deterministic.ts` — grading artifact-exclusion fix (SK-16)
- `test/integrations-contract.test.ts` — SK-Q17 (anti-wander) + SK-Q19 (cost-gate/grep-rename) lock blocks
- `test/bench-graders.test.ts` — grading-exclusion tests
- `benchmarks/README.md` — "Codex cost model (measured)" note
- `benchmarks/results/2026-08-08-codex-tier1.md`, `-codex-tier2.md` — dated reports

`npm test` green: 55 files / 578 tests; boundaries clean. Nothing committed — the FR-304 and
doctrine-divergence rationales from the SK-R19 review are written for the commit message; per
`CLAUDE.md`, commits use `Co-Authored-By: Stapler AI <bot@stapler-ai.com>` only.

---

## What still needs to be done

### 1. Tier-3 — the only remaining lever for the cheap-task ~1.5× floor (SCOPED, UNFUNDED)

The residual overhead on small tasks is the **fixed per-step tax**: codex re-bills the 11 MCP
tool schemas + `AGENTS.md` on every round-trip. Content can't touch it. Two levers, both
touching `src/` (which the skills feature deliberately left untouched):

- **(a) Slim the 11 tool descriptions in `src/server/tools.ts`.** Every word there is
  multiplied by ~15–20 steps × every task for codex. Highest-leverage; affects **all** agents
  (verify claude's 0.98 doesn't regress).
- **(b) Reduced codex tool surface** via `integrations/codex/config.toml` (mount only the tools
  codex uses). Collides with the "names all 11 tools" contract test — a tier-3 decision, not a
  quick edit.

Measure the fixed tax directly first (with-arm first-step input − without-arm first-step input,
from the transcripts) to size the ceiling before investing.

### 2. Re-baseline the cheap-task gate before any future codex-content gate

The `≤ 1.25` bar was calibrated on a design estimate (~1.05–1.15 floor) the measurement
falsified (~1.5–1.6 on 56–77k-token baselines). As written, **no achievable content — including
the incumbent — can pass it.** Restate as relative to the measured fixed tax, or as "cheap
A2 ≤ same-batch control + ε."

### 3. Fix or retire the flaky `rr-self-makebyteoffset-001` grader

Scored 1/3 in baseline and tier-1 but 0/3 in tier-2 (Fisher p = 1.0 — noise; excluded from the
verdict by design). Its `test-diff` grader is unreliable across all arms. Either fix it or drop
it from correctness endpoints. The **standing deterministic regression pair** for future
`AGENTS.md` edits is `rr-self-discoverfiles-001` + `ci-self-openhealthy-callers-001`.

### 4. Commit the working tree

Everything above is uncommitted. Decide whether the SK-16 grader fix, the tier-2 content, and
the reports land in one commit or separately (the grader fix is independently valuable and
low-risk).

### 5. (Open question) Is token *parity* even the right goal for codex?

The measurement strongly implies **for codex the index is a correctness tool, not a token
saver** — parity below 1.0 is likely unreachable by any means short of codex gaining prompt
caching. Consider reframing the codex skill's success criterion around correctness-per-token
rather than raw token ratio, and documenting that in the PRD/gates.

---

## Key references

- Reports: `benchmarks/results/2026-08-08-codex-tier1.md`, `-codex-tier2.md`
- Fixed-tax mechanism + per-regime numbers: the "Codex cost model (measured)" note in
  `benchmarks/README.md`
- Plan of record for the tier-2 round: `~/.claude/plans/mutable-stirring-swing.md` (local)
- Tier-2 content pins: the SK-Q19 block in `test/integrations-contract.test.ts`
- Grading fix: `benchmarks/harness/graders/deterministic.ts` (`workspaceContent`, `isBinary`)
