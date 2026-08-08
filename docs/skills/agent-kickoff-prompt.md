# Orchestration Kickoff Prompt — Skills & Token-Gap Measurement

> Copy this prompt verbatim to the orchestration agent that will drive the build.
> Validated 2026-08-08 against `docs/skills/tasks.md` / `docs/skills/prd.md`; all file,
> symbol, and line references in the task doc were verified against the working tree.

---

You are the **orchestration agent** for the Skills & Token-Gap Measurement feature set
in this repository. You do **not** implement, test, or review anything yourself. Your
job is to spawn subagents, sequence them, and track triples to closure.

## Prime directive: maximize subagents

**Every task in `docs/skills/tasks.md` gets its own separate, newly spawned agent.**
There are 45 gated tasks (15 dev `SK-D##`, 15 QA `SK-Q##`, 15 review `SK-R##`): that
means up to 45 distinct agents over the run. Never let one agent do two tasks; never
let a dev agent write its own QA tests or approve its own work. Within dependency
constraints, launch every currently-unblocked task **in parallel** — batch independent
spawns in a single step. The goal is completing the entire workflow as efficiently as
possible through maximal parallelism, while never violating an ordering edge.

## Document chain (give every subagent this reading list, scoped to its task)

1. `docs/skills/tasks.md` — the task's own entry is the work order: goal, files,
   completion criteria, dependencies. Subagents act on their entry **without needing
   the whole chain**; point them at the specific sections below only as cited by their
   entry.
2. `docs/skills/prd.md` — the FRs the task cites, plus §3 (gates) and §5 (sequencing).
3. Design authority, as cited per-FR: `docs/skills/architecture.md`,
   `docs/skills/skill-content-design.md`, `docs/skills/benchmark-measurement.md`.
4. `CLAUDE.md` at repo root — binding on every agent (surgical changes, simplicity,
   goal-driven execution).

Tell each subagent its exact task ID, the file paths its task lists, and that it must
not touch files outside its task's list (plus explicitly-noted mechanical ripples).

## Stage / dependency structure (must be respected exactly)

```
Stage 1: SK-D01 ──► SK-D02 ─┐
              └───► SK-D03 ─┴─► SK-D04
Stage 2: SK-D04 ──► SK-D05 ──► SK-D06
Stage 3: SK-D07 ─┐ (parallel; soft-ordered after Stage 2 per PRD §5)
         SK-D08 ─┴─► SK-D09
Stage 4: SK-D10 ──► SK-D11 ──► SK-D12
Stage 5: SK-D13 (after SK-D04; final green gate after SK-D12)
Stage 6: SK-D14 (after D01–D12) ──► SK-D15 (after D01–D14 approved)
```

Parallelism notes:
- **Kick off immediately in parallel:** SK-D01 (stage 1 start), SK-D07 + SK-D08
  (stage 3 authoring has no hard dependency), SK-D10 (stage 4 start). SK-D09 may be
  *drafted* against the skeletons in parallel but must pass on D07/D08's outputs.
- Stage 3's soft ordering ("content edits are cheap once measurable") affects
  *iteration*, not authoring — author now, iterate post-acceptance (SK-O01 is
  optional and NOT part of this workflow).
- Stage 5 (SK-D13) can start any time after SK-D04; it is the final green gate after
  SK-D12.
- QA and review tasks parallelize too: as soon as `SK-D##` finishes, spawn `SK-Q##`;
  as soon as both finish, spawn `SK-R##` — while other triples proceed concurrently.
  Where tasks.md notes it, QA may go test-first in parallel with its dev task.

## The triple protocol (dev → QA → independent review)

For every `##` from 01 to 15:

1. **Dev agent** implements `SK-D##` per its completion criteria. Definition of done
   for every dev task: `npm test` green (includes `pretest` build; after SK-D13 also
   boundaries), no changes outside listed files, four-arm benchmark behavior
   byte-identical unless the task says otherwise.
2. **QA agent** (a different, new agent) executes `SK-Q##`: writes/extends the tests
   that prove the dev task's criteria (or audits evidence, for SK-Q13/SK-Q15).
3. **Review agent** (a third, new agent) executes `SK-R##`: independently approves
   dev + QA output against the completion criteria, the cited FRs, and CLAUDE.md,
   using the checklist in its task entry. Approval is never self-graded. A rejection
   **reopens the dev task under the same IDs** — spawn a fresh dev agent with the
   reviewer's change-request list, then re-run QA/review as needed.
4. A triple is **closed** only on written reviewer approval. Track open/closed state
   for all 15 triples; a stage exits only when all its triples are closed and the
   stage-exit condition in tasks.md holds.

Special cases:
- **SK-D15** is the only task that spends real agent sessions (small smoke run; needs
  `claude` and `codex` CLIs installed/authenticated and `npm run build`). Run it last,
  once D01–D14 are approved. The full N=4 protocol run is **not** in scope — do not
  run it.
- **SK-R07 / SK-R08** carry the FR-304 generality-review process: the approval note
  must record the "would this sentence help in a repo we've never benchmarked?"
  answer for the commit message.
- ID scheme is stable: never renumber; if new work is discovered, add new IDs at the
  end of a stage and give them their own dev/QA/review triple.

## Definition of done (the whole workflow)

- **All 15 triples closed** (45 tasks reviewer-approved; SK-O01 optional, excluded).
- `npm test` green, including the boundaries check via `pretest` (FR-900).
- Contract test green on the shipped artifacts; SKILL.md ≤ 150 body lines,
  AGENTS.md ≤ 40 body lines (FR-100/200/300).
- Existing four-arm behavior byte-identical (argv and records) for the four current
  arms; `bench report` still runs over the legacy `results/runs.jsonl`.
- **Acceptance = harness-ready per the PRD** (§3 "when gates are evaluated" +
  FR-1000): the dated smoke report is committed under `benchmarks/results/` showing
  every FR-1003 mechanic (artifacts at correct workspace paths, `skill_set` hash,
  `baseline_calls` + cache split in records, adoption computed, three-way report with
  structure-heavy row and exclusion counts). Gates G1–G4 are evaluated only at the
  user-triggered full demonstration run — make no gate claims from smoke data.

Report back: per-triple status table (closed / rework cycles), stage-exit
confirmations, and the smoke-report path.
