# Benchmarks — setup, configure, use, run

How to run the benchmark suite. This is the operational guide; the design and
rationale live in `[docs/benchmark.md](../docs/benchmark.md)`.

The suite measures whether giving an agent the `code-index` MCP tools makes it
**more efficient** (fewer tokens for equal-or-better correctness) on code
navigation tasks, versus the same agent with only baseline tools.

## Quick start

```bash
npm install                 # deps (native better-sqlite3 — see Setup if it fails)
npm run build               # compiles src/ -> dist/ — the harness runs this built binary directly

# Smallest real run: one seed task, one arm (requires the `claude` CLI, authenticated)
npm run bench -- run --task sl-fixture-greet-001 --arms claude-with --runs 1 --workers 1 --model <model-id>

# Model Ids
#
# -- Anthropic
# - Fable 5 → claude-fable-5
# - Opus 4.8 → claude-opus-4-8 (this session runs the 1M-context variant, claude-opus-4-8[1m])
#
# -- OpenAI
# - gpt-5.6-sol
# - gpt-5.5


# Aggregate the recorded runs into a dated markdown report (offline)
npm run bench -- report --name smoke
```

There is intentionally **no** `bench` **binary** and no compiled benchmark output:
the npm scripts run the TypeScript sources directly via `tsx`. Flags after `--`
pass straight through to the harness.

## Concepts

**Six arms** (`harness/adapters/`) — `{claude,codex} × {without,with,with-skill}`.
Each task is run under some subset of: `claude-without`, `claude-with`,
`claude-with-skill`, `codex-without`, `codex-with`, `codex-with-skill`.

They sit on a strictly additive **three-rung parity ladder** — nothing is ever
removed from a lower rung, so each comparison isolates one variable:

- **`without`** — baseline tools only (`Read, Grep, Glob, Bash`).
- **`with`** — baseline tools **plus** the `code-index` MCP server. Isolates tool
  *availability*.
- **`with-skill`** — everything in `with`, **plus the shipped skill artifact**
  injected into the workspace (the exact file a user installs). Isolates the
  *instructions* layer on top of availability. For **claude** the only argv delta
  vs `with` is allowing the `Skill` tool in `--allowedTools`; for **codex** there
  is no argv delta — the `AGENTS.md` file presence in the workspace suffices.

The headline comparison is `with-skill / without` within one agent; `with / without`
and `with-skill / with` are reported alongside so the tool and skill contributions
are separable.

### Codex cost model (measured)

Per the audited validation run ([results/2026-08-08-codex-tier2.md](results/2026-08-08-codex-tier2.md)):
codex re-bills its context per tool round-trip plus a fixed per-step tax (MCP tool schemas +
`AGENTS.md`), so its `with-skill` arm carries a structural ~1.5× overhead on small tasks that
content edits cannot remove — tokens are bought back only where the index replaces many baseline
calls. Measured with the tier-2 cost-gated `AGENTS.md`: renames run below no-skill parity
(0.83–0.97×, zero MCP calls via the grep-centric chain); callers/impact tasks pay ~2.1–2.5×
tokens for large correctness gains (+0.57/+0.73); cheap tasks carry the ~1.56× structural tax
(identical to the tier-1 control). Pooled with-skill/without = 1.16 on the validation mix — for
codex the index is a correctness tool that is approximately cost-neutral in aggregate, not a
token saver on small tasks. `rr-self-discoverfiles-001` + `ci-self-openhealthy-callers-001` are
the standing deterministic regression pair for future `AGENTS.md` edits.

**Targets** (`targets.ts`) — what the agent works on. Every run gets a fresh
temp-dir copy with its own `.git` (so edit-tier diff checks work):

- `fixture-ts` — a small controlled JS/TS/TSX repo built on the fly. No network.
- `oss-zod` — zod pinned at `ca42965…`. One-time shallow clone into
  `benchmarks/fixtures/zod` on first use (needs network); override the cache
  location with `BENCH_FIXTURES`.
- `self` — this repository at git tag `bench-self-v1` (create it with
  `git tag bench-self-v1 <commit>`).

**Tasks** (`tasks.ts`, `seed-tasks.ts`) — typed `BenchTask`s across six
categories (symbol-lookup, callers-impact, bug-localization, architecture,
cross-file-navigation, rename-refactor), validated at import. By default the
live registry (`TASKS`) contains the **hand-authored seed tasks only**. The
index-driven generator (`generate-tasks.ts`, tag `generated:v1`) is wired in
behind an explicit, default-off filter — see below.

### Generated tasks (`generated:v1`)

The index-driven generator (`generate-tasks.ts`) dogfoods the tool to scale task
count: it reads a built index of a target and derives symbol-lookup, who-calls,
impact, and architecture tasks whose grader keys come straight from the index.
Scope is currently `oss-zod` only.

Because generation needs a built index, it is a **generate-and-cache** flow, not
an import-time build (an import-time index build would break `npm test`):

- `npm run bench:generate` materializes the target, builds its index with the
  shipped `dist/cli.js`, derives tasks, validates them, and writes the checked-in
  snapshot `benchmarks/generated-tasks.v1.json`. It is deterministic per target
  checkout (id-sorted output) and idempotent — re-running on an unchanged
  checkout produces a byte-identical file.
- The registry loads that snapshot (a plain file read — never an index build)
  **only** when `BENCH_INCLUDE_GENERATED=v1` is set; otherwise generated tasks
  are excluded entirely. This keeps default `TASKS` = authored-only and keeps
  `versions.task_set` distinct between filter-off and filter-on runs, so records
  stay attributable. Generated ids are `gen-*`-prefixed and never collide with
  the authored `<category>-<target>-*` scheme.

```bash
npm run bench:generate                                   # regenerate the snapshot
BENCH_INCLUDE_GENERATED=v1 npm run bench -- run --task <sel> --arms ... --model ...
```

**Circularity posture & spot-validation.** The generator's ground truth *is* the
index, and the with-arm queries that same index — neutral for the
with-vs-without comparison (both arms are graded against the same key), but
generated keys are never treated as certifying index correctness (that is the QA
suite's job). To guard against silent key drift we **spot-validate a sample of
generated keys against the raw target source** on each regeneration — one task
per generated shape, confirmed by hand against the pinned `oss-zod`
(`ca42965…`) checkout under `benchmarks/fixtures/zod`:

| Shape | Sample task | Key claim | Verified against source |
| --- | --- | --- | --- |
| symbol-lookup | `gen-symlookup-oss-zod-filePath` | `src/__tests__/language-server.source.ts:3` | `export const filePath = __filename;` on line 3 |
| who-calls | `gen-whocalls-oss-zod-denoLibRoot` | `deno-build.mjs:40`, `:94` | both call sites present; the definition (line 24) is correctly excluded |
| architecture | `gen-arch-oss-zod-configs_rollup_config_js-…` | imports `@rollup/plugin-typescript` | `import typescript from "@rollup/plugin-typescript";` in `configs/rollup.config.js` |

Who-calls keys additionally have an automated cross-check
(`grepCrossCheckCallers`): every claimed call site must also be found by an
independent `git grep` for `name(` in the working tree.

**Grading ladder** (`harness/graders/deterministic.ts`, `judge/judge.ts`) —
lowest rung that can decide the answer:
`exact` → `set` (F1) → `path-line-set` (F1, ±2 line slop) →
`test-diff` (run a test subset + regex diff assertions, edit tier) →
`judge` (LLM fallback, free-form architecture answers only).

**Workspaces & records.** Each (task, arm, rep) cell appends one JSON line to
`results/runs.jsonl` and preserves its workspace under
`results/runs/<stamp>/<run_id>/` for offline re-grading. Everything under
`results/` is git-ignored except `.gitignore` and dated `*.md` reports.

## Setup (one-time)

1. `npm install`. If the native `better-sqlite3` build fails, retry with
   `CC=/usr/bin/cc CXX=/usr/bin/c++ npm install`.
2. `npm run build`. The harness invokes the built `dist/cli.js` directly (via the
   current node) for both the index step and the with-arm MCP server, so `dist/`
   must exist — but you do **not** need `npm link` or a global install. If dist is
   missing you get a clear `code-index build not found … run npm run build first`.
3. Install and authenticate the agent CLIs for the arms you plan to run:
   `claude` for the claude arms, `codex` for the codex arms. `report` needs
   neither; `bench:judge:selftest` needs `claude`.
4. Prepare targets as needed:

- `fixture-ts` — nothing.
- `oss-zod` — the cache clones automatically on first use (network), or point
  `BENCH_FIXTURES` at a prepared cache directory.
- `self` — `git tag bench-self-v1 <commit>`.

## Configure

`bench run` flags:

| Flag              | Default              | Notes                                                                   |
| ----------------- | -------------------- | ----------------------------------------------------------------------- |
| `--model <id>`    | —                    | **Required.** Pins the model per agent. One id applies to every arm in the invocation — run claude and codex arms in separate invocations, each with a model its CLI accepts. |
| `--task <sel>`    | `all`                | `all`, a category name, or a comma-separated list of task ids.          |
| `--arms <list>`   | all six              | Comma-separated subset of the six arms: `claude-without,claude-with,claude-with-skill,codex-without,codex-with,codex-with-skill`. |
| `--runs N`        | `4`                  | Repetitions per (task, arm) cell. **N=2** for content-iteration loops, **N=4** for the final report run (see Protocol). |
| `--workers N`     | `4`                  | Concurrency.                                                            |
| `--results <dir>` | `benchmarks/results` | Where `runs.jsonl` and workspaces are written.                          |

`bench report` flags: `--name <name>` (default `report`),
`--date <YYYY-MM-DD>` (default today), `--results <dir>`.

Environment:

- `BENCH_FIXTURES` overrides the OSS clone cache location. The MCP config for
  with-arms is written automatically by the harness — nothing to edit by hand.
- `BENCH_INCLUDE_GENERATED=v1` includes the `generated:v1` task set in the
  registry (default off — see [Generated tasks](#generated-tasks-generatedv1)).
- `BENCH_SKILL_MODE=system-prompt` is a **Claude-only diagnostic** (see below);
  leave it unset for headline runs.

### Diagnostic skill mode (`BENCH_SKILL_MODE=system-prompt`)

A diagnostic that separates *"the skill description never triggered"* from
*"the skill body didn't help"*. When set, `claude-with-skill` runs inject the
`SKILL.md` **body** via `--append-system-prompt` (forcing the content in)
instead of copying the file and relying on Claude's on-demand skill discovery.
Codex skill arms are unaffected (they have no system-prompt path and still
file-install).

Such runs carry the flag `skill_mode:system-prompt` and are **excluded from
headline aggregation** in `bench report` (collected and shown separately). The
flag is stamped whenever the mode is active, so a headline run can never
silently use it. Never use it for the demonstration protocol below — it exists
only to diagnose adoption problems.

```bash
# Diagnostic only — NOT the headline. Isolates description-trigger vs body value.
BENCH_SKILL_MODE=system-prompt \
  npm run bench -- run --task all --arms claude-with-skill --runs 2 --model claude-opus-4-8
```

## Use / run

```bash
# One seed task, one arm, one rep — the cheapest real invocation
npm run bench -- run --task sl-fixture-greet-001 --arms claude-with --runs 1 --workers 1 --model <model-id>

# A whole category, both claude arms
npm run bench -- run --task symbol-lookup --arms claude-with,claude-without --model <model-id>

# The full matrix over every registered task — per agent, since --model is
# a single id (a claude model id passed to codex fails instantly). All three
# of an agent's arms go in one invocation so they share a CLI version + day.
npm run bench -- run --task all --arms claude-without,claude-with,claude-with-skill --model <claude-model-id>
npm run bench -- run --task all --arms codex-without,codex-with,codex-with-skill --model <codex-model-id>

# Build a dated markdown report from what has been recorded so far
npm run bench -- report --name smoke        # -> results/<today>-smoke.md

# Judge calibration self-test (requires the `claude` CLI)
npm run bench:judge:selftest
```

Pick task ids from `seed-tasks.ts` (e.g. `sl-fixture-greet-001`,
`ci-fixture-greet-callers-001`, `rr-fixture-add-sum-001`).

Note: `report` reads `results/runs.jsonl` and errors if it does not exist yet —
run at least one `bench run` first.

## Demonstration protocol

The single documented run that demonstrates the token gap. One invocation per
agent (all three of that agent's arms together, so they share the same CLI
version, same day, and same task-set hash), then one report. Models are pinned
to the cheaper tier: **`claude-opus-4-8`** (Claude Code), **`gpt-5.5`** (Codex
CLI). Task scope `all` includes the structure-heavy seed expansion and — when
the filter is engaged (see [Generated tasks](#generated-tasks-generatedv1)) —
the `generated:v1` tasks.

```bash
npm run bench -- run --task all \
  --arms claude-without,claude-with,claude-with-skill \
  --runs 4 --model claude-opus-4-8
npm run bench -- run --task all \
  --arms codex-without,codex-with,codex-with-skill \
  --runs 4 --model gpt-5.5
npm run bench -- report --name skills-gap
```

**Reps budget.** `--runs 4` (**N=4**) for this final report run. Use **N=2**
(`--runs 2`) for the cheaper content-iteration loops (edit the artifacts, run a
subset, keep the edit only if `with-skill/without` improves at correctness
Δ ≥ 0). Both budgets are per (task, arm) cell.

The report renders a three-way headline per agent (`with/without`,
`with-skill/with`, `with-skill/without`), a structure-heavy subset row, adoption,
win/loss/tie, and excluded-run counts. Any `skill_mode:system-prompt` diagnostic
runs are excluded from the headline and shown separately.

> The **full paid run** is a user-triggered event, not part of feature
> acceptance. Acceptance is verified on a small smoke subset — the same commands
> with reduced `--task` / `--runs` (e.g. `--runs 1` over one task per
> structure-heavy category). See dated smoke reports under `results/`.
