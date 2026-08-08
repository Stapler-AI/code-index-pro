# Benchmark Measurement of the Skills Layer

> **Status:** design for extending the existing benchmark harness (`benchmarks/`,
> [benchmark.md](../benchmark.md)) so the skills layer's token effect is measurable and
> attributable. Part of the [skills feature architecture](architecture.md); the content
> being measured is designed in [skill-content-design.md](skill-content-design.md).
> Everything here extends the shipped harness — arm model, record schema, report — and
> changes no existing semantics for the four current arms.

## Arm model: six arms, three-rung parity ladder

`Arm` (in `benchmarks/harness/adapters/types.ts`) grows from four to six values:

| Arm | MCP tools | Instructions | What it isolates |
|---|---|---|---|
| `claude-without` / `codex-without` | ✗ | ✗ | baseline |
| `claude-with` / `codex-with` | ✓ | ✗ | tool availability alone (today's with-arm, unchanged) |
| `claude-with-skill` / `codex-with-skill` | ✓ | ✓ shipped artifact | **the product as installed** |

The ladder is strictly additive (`without ⊂ with ⊂ with-skill`): each rung adds
something and removes nothing, so every pairwise ratio has a causal reading —
`with/without` = tools, `with-skill/with` = instructions, `with-skill/without` = the
headline users experience.

**Contract change, called out:** `isWithArm()` currently tests `endsWith("-with")` and
would misclassify `-with-skill`; it becomes explicit set membership
(`with`-family = tools present), with a parallel `hasSkill(arm)` predicate. Both
adapters' unit tests (`test/bench-claude-adapter.test.ts`,
`test/bench-codex-adapter.test.ts`) pin the new truth table. `ALL_ARMS` in `run.ts`
grows to six; `--arms` defaults to all six.

## Instruction injection

New module `benchmarks/harness/instructions.ts`, split pure/impure per the
[architecture's layer table](architecture.md#directory-structure--layer-mapping):

```ts
/** Pure plan: which shipped artifacts land where, for this arm. */
planInstructions(arm: Arm): { source: string; destRelPath: string }[]
// claude-with-skill → [{ source: "integrations/claude/skills/code-index/SKILL.md",
//                        destRelPath: ".claude/skills/code-index/SKILL.md" }]
// codex-with-skill  → [{ source: "integrations/codex/AGENTS.md",
//                        destRelPath: "AGENTS.md" }]
// all other arms    → []

/** Impure install: copy into the workspace; returns sha256[..12] of injected content, or null. */
installInstructions(workspaceDir: string, arm: Arm): string | null
```

Wired as a new `HarnessDeps` member, called by the run loop **after** workspace
materialization and index build, **before** agent invocation. Fake-able in harness unit
tests like every other dep.

Per-CLI mechanics — each agent's *production* instruction path, so the benchmark
measures the installed product (architecture decision 3):

| Concern | Claude Code | Codex CLI |
|---|---|---|
| Artifact destination | `<ws>/.claude/skills/code-index/SKILL.md` | `<ws>/AGENTS.md` (workspace root) |
| Load mechanism | Project-skill discovery; body loads on trigger via the `Skill` tool | `codex exec` reads cwd `AGENTS.md` unconditionally |
| Adapter change | skill arm allows `Skill` in `--allowedTools` (the only delta vs `claude-with`) | none — file presence suffices |
| Pre-existing file | workspaces never ship `.claude/` (fixture/OSS/self targets) — plain copy; error if present (isolation violation) | if the target ships an `AGENTS.md`, append the section after a separator (production guidance says "paste into"); record flag `agents_md_appended` |
| Codex `AGENTS.md` stripping | — | the codex artifact's HTML template-comment header is stripped at install (it is packaging metadata, not instructions); the sole content transform, owned by `installInstructions` and pinned by a unit test |

**Determinism caveat & diagnostic mode.** Codex injection is deterministic
(unconditional load). Claude skill *triggering* is probabilistic — a real property of
the shipped product, so the headline number includes it (trigger failures show up as
adoption < 1 and a smaller gap, which is honest). For diagnosing content-vs-trigger
problems, the claude adapter also supports an env-gated diagnostic mode
(`BENCH_SKILL_MODE=system-prompt`) that injects the SKILL.md body via
`--append-system-prompt` instead of the file copy; runs made this way carry a
`skill_mode:system-prompt` flag and are excluded from headline aggregation by the
report. Never the headline; exists so a flat result can be attributed to "description
didn't trigger" vs "body didn't help."

## Record schema extensions

`RunRecord` (in `run.ts`, one JSONL line per run — append-only file, so new fields are
additive and old records remain readable):

| Field | Change | Why |
|---|---|---|
| `arm` | six-value domain | as above |
| `versions.skill_set` | **new** — sha256[..12] of injected instruction content, `null` for non-skill arms | every result traceable to exact skill text; the content-iteration loop's join key |
| `metrics.tokens_cache_read` / `tokens_cache_creation` | **new** — split of today's `tokens_cache` (kept for back-compat) | turn overhead (cache reads) vs context growth are different levers; the skill's V1 attack (fewer turns) is visible only in the split |
| `metrics.baseline_calls` | **new in the record** (already parsed in `RunMetrics`, currently dropped at record-write) | denominator for adoption |
| `flags` | may carry `agents_md_appended`, `skill_mode:system-prompt` | audit |

Report reading tolerates records missing the new fields (old runs aggregate as before).

## Report extensions (`report.ts`, offline re-runnable)

1. **Three-way headline per agent** — replaces the single with/without row:

   | Agent | with/without | with-skill/with | **with-skill/without** | correctness Δ (skill vs without) | adoption (skill arm) | index build s |

   Ratios are medians of per-task paired ratios (as today). `with-skill/without` is the
   project's headline number going forward.
2. **Adoption metric** — per arm, median `mcp_calls / tool_calls` (0 when no tools).
   This is the mediating variable: skill → adoption ↑ → tokens ↓. A flat token gap with
   flat adoption means the skill didn't change behavior (trigger/content problem); a
   flat gap with high adoption means the recipes don't save what they claim (content
   problem). The report prints it so every iteration is diagnosable from the markdown
   alone.
3. **Token-composition columns** — per-category cells gain `fresh-in / cache-read / out`
   medians alongside the existing total, exposing *where* savings come from (V1 vs V2 of
   the content design).
4. **Win/loss/tie** — computed for both `with vs without` (as today) and
   `with-skill vs without`.
5. **Correctness gate** — headline rows where correctness Δ < 0 are rendered with an
   explicit `⚠ correctness regression` marker; the ratio is never presented without it
   (architecture decision 5).

## Task mix: surfacing the gap honestly

The gap is real but scale-dependent — small fixtures understate it
([benchmark.md](../benchmark.md#targets--fixtures) said so at design time; the
2026-08-08 numbers confirm it). Wiring changes are minimal; the mix change is authored
tasks, not harness code:

- **Weight toward structure-heavy categories and larger targets**: add seed tasks on
  `oss-zod` and `self` for callers-impact, cross-file-navigation, and rename-refactor —
  the categories where sequencing discipline compounds (multi-hop). Small-fixture tasks
  are kept (regression floor), not removed.
- **Wire the existing generator** (`generate-tasks.ts`, currently library-only) into the
  registry behind an explicit tag filter, to scale task count on `oss-zod` cheaply.
  Circularity handling is unchanged from [benchmark.md](../benchmark.md#task-generation)
  (same-key grading is neutral across arms; spot-validation still applies).
- **Prompts stay tool-agnostic** — task prompts never mention the index, MCP, or any
  tool by name, in any arm (this is what "not gaming the tasks" means mechanically; it
  already holds for the seed set and becomes a registry validation rule).

## Run protocol (the demonstration)

The result that "demonstrates the gap" is one dated report per agent produced by:

```bash
# per agent, one invocation per agent (model ids differ)
npm run bench -- run --task all \
  --arms claude-without,claude-with,claude-with-skill \
  --runs 4 --model <claude-model-id>
npm run bench -- run --task all \
  --arms codex-without,codex-with,codex-with-skill \
  --runs 4 --model <codex-model-id>
npm run bench -- report --name skills-gap
```

Protocol rules: all three arms of an agent run in the same invocation (same CLI version,
same day, same task-set hash); N=4 reps as today; the report's three-way table +
adoption column is the deliverable. Success criterion for the feature set:
**`with-skill/without` token ratio materially better than the current `with/without`
(~0.9), at correctness Δ ≥ 0, on both agents** — the concrete numeric target is set in
the PRD, not here.

## Validity threats, stated

| Threat | Mitigation |
|---|---|
| Overfitting skill text to bench tasks | Content guardrails + leakage contract test ([content doc §Guardrails](skill-content-design.md#guardrails-validity-of-the-measured-gap)) |
| Skill saves tokens by being wrong faster | Correctness gate on every ratio (report §5) |
| Claude skill trigger variance read as content failure | Adoption metric + `system-prompt` diagnostic mode separate the two |
| Instruction context cost hidden | It isn't — injected instructions are inside measured totals; Codex's always-loaded section is deliberately budgeted (content doc) |
| Codex measurement instability (0.14x event-schema drift; earlier runs recorded 0 tokens) | Already addressed by the reworked codex adapter parser; `no_result`/zero-token runs are flagged and the report must exclude flagged runs from ratios — a **prerequisite fix folded into this feature's wiring** (today they aggregate silently) |
| Cross-agent comparison creep | Unchanged non-goal; all ratios within-agent |

## Test plan (extends the existing bench test suite)

- `test/bench-instructions.test.ts` — `planInstructions` truth table (six arms);
  install copies/appends/strips correctly into a temp workspace; returns stable content
  hash; errors on pre-existing `.claude/` in a workspace.
- Adapter tests — new-arm argv deltas (`Skill` in allowedTools; codex unchanged);
  `isWithArm`/`hasSkill` truth tables.
- `test/bench-harness.test.ts` — run loop calls `installInstructions` for skill arms
  only, after index build; `skill_set` lands in the record; flagged runs excluded from
  report aggregation.
- `test/bench-report.test.ts` — three-way headline, adoption, token split, correctness
  marker, tolerance of legacy records.
- `test/integrations-contract.test.ts` — artifact content contract (content doc
  §Guardrails).
- Boundary: `npm run boundaries` (dependency-cruiser) green — new rules from the
  [architecture](architecture.md#boundary-rules--enforcement-tooling).
