---
name: stapler-plan
description: Four-stage plan-first pipeline that produces architecture docs, a PRD, a dev/QA/review task decomposition, and an orchestration kickoff prompt in the project's docs/ directory. Use whenever the user wants to plan a project or feature set before coding begins — including requests to "create architecture documentation", "write a PRD", "break this down into agent tasks", "set up a development plan", or "get this ready for agents to build" — even if they never say "stapler-plan" by name. Do not use for quick single-file changes that need no planning documents.
argument-hint: "[ask|auto] [detailed project or feature description]"
---

# Stapler Plan

A four-stage planning pipeline that "staples" together the full pre-development document chain for a project or feature set. Each stage produces a document in the project's `docs/` directory, and each stage runs in a **fresh subagent with a clean context window**. The clean context matters: it forces each stage's output to be driven only by the documents on disk, never by leftover conversation state — which is also what makes the documents trustworthy inputs for the stage after them.

Stages, in order:

1. **Architecture** — `docs/architecture.md` (+ supporting architecture docs)
2. **PRD** — `docs/prd.md`
3. **Task decomposition** — `docs/tasks.md` (dev / QA / review task triples)
4. **Validation & kickoff** — verify `tasks.md` is complete, then write the orchestration kickoff prompt

Don't skip or reorder stages — each stage's agent treats the prior stage's documents as its source of truth, so a missing stage starves the next one.

## Drive the pipeline to completion — never idle mid-stage

You (the orchestrator) own the pipeline's forward motion. Run each stage agent as blocking work and wait for its result **within your own turn**; the moment a stage's document is on disk, start the next stage. Do not end your turn to "wait" for a stage agent, arm a watcher or timeout, or rely on being re-woken by a notification — an orchestrator that yields mid-pipeline usually stays stopped, and the pipeline stalls until a human notices. Before ending any turn, check: is every stage done and the final report written? If not, and you aren't blocked on the user, keep working. The only legitimate reasons to end your turn are a completed pipeline or input only the user can provide (a question relay, or an `ask`-mode approval).

> **Note on `/plan` mode:** spawned subagents have no interactive plan mode. Approximate it per stage: instruct each stage agent to first explore read-only and reason through its approach, and only then write its document(s). The agent must not modify anything outside the document(s) its stage owns.

## Arguments

- **Mode** (first argument, optional): `ask` or `auto`. Default: `ask`.
  - `ask` — after each stage's document lands in `docs/`, pause and get the user's approval (via AskUserQuestion) before spawning the next stage's agent. Offer the user the chance to request revisions; revisions go back to the same stage's agent before proceeding.
  - `auto` — run the stages back-to-back without approval pauses. Only interrupt the user for blocking questions raised through the question-relay protocol.
- **Description** (remainder of arguments): the user's detailed description of the project or feature set to plan. If missing or vague, ask the user for it before starting Stage 1 — the whole pipeline is built on it.

## Question-relay protocol

Subagents cannot talk to the user directly. Whenever a stage agent is unclear about anything, it must **return its questions as its result instead of guessing**. Then:

1. The main session presents the questions to the user via AskUserQuestion.
2. The main session relays the answers back to the same agent via SendMessage (don't spawn a replacement agent — the stage agent keeps its context).
3. Repeat until the agent has what it needs, then it writes its document(s).

This protocol is available in every stage and **mandatory in Stage 2**: the PRD drives everything downstream, so an ambiguity baked into it multiplies into wrong tasks and wasted agent runs.

Two rules keep the relay from stalling the pipeline:

- **Stage agents: answers received means write now.** When the relayed answers arrive, write the document in that same turn. Don't stop to confirm understanding, acknowledge the answers, or wait for a go-ahead — the document itself is the confirmation. A stage agent that ends its turn after absorbing answers, without its document on disk, has failed the stage.
- **Orchestrator: verify on disk, not by message.** After relaying answers, keep driving: wait on the stage agent's result, and treat the document's presence on disk as the source of truth for stage completion (messages can cross or go stale — check the filesystem before nudging or escalating). If the stage agent stopped without writing, resume it once with a direct instruction to write immediately; only if that fails, spawn a replacement agent seeded with the prior stage's documents plus the full question-and-answer history.

## Stage 1 — Architecture documentation

Spawn a new agent with a clean context window. Prompt template:

> Help me create architecture documentation for this project. The goal of this project is to [USER DETAILED DESCRIPTION].
>
> Before designing, read `[SKILL_DIR]/references/architecture/layered-architecture.md` and the file(s) under `[SKILL_DIR]/references/architecture/stacks/` matching the project's stack(s) — follow their layer model, directory structures, and separation rules in the architecture you produce. Then explore the existing codebase read-only and think through the architecture before writing anything. Write `docs/architecture.md`, plus any supporting architecture documents the design needs (e.g. schema, data flow, component designs), to the `docs/` directory. Create `docs/` if it does not exist. The architecture doc must state the chosen directory structure, the layer each directory belongs to, and the boundary-enforcement tooling to install. If anything about the goal is unclear, return your questions instead of guessing.

(Replace `[SKILL_DIR]` with this skill's absolute directory path so the stage agent can find the references.)

Stage output: `docs/architecture.md` and any supporting architecture files.

## Stage 2 — PRD

Spawn a new agent with a clean context window (no carryover from Stage 1). Instruct it to:

1. Review **all** architecture documentation in the `docs/` directory.
2. Draft a PRD for the project or feature set at `docs/prd.md`.
3. **Before writing**, surface every open question through the question-relay protocol. This document will be used to create the tasks and development plan, so keep asking until understanding is full and complete — an ambiguous PRD is a failed stage.

Stage output: `docs/prd.md` with functional requirements and acceptance criteria.

## Stage 3 — Task decomposition

Spawn a new agent with a clean context window. Instruct it to read `docs/prd.md` and create an agent-developer task decomposition list at `docs/tasks.md`, where:

- Every requirement in the PRD is decomposed into development tasks sized for a single agent to complete.
- **Every development task gets a QA task**: build the tests that validate the dev task's completion and functionality.
- **Every development task gets a separate review task**: to be run by a distinct code-review agent that approves the dev task's completion. The reviewer is separate from the developer and QA agents so approval is independent, not self-graded.

Stage 3 is not complete until all development, QA, and review tasks are present in `docs/tasks.md`.

Stage output: `docs/tasks.md` containing dev/QA/review task triples covering the full PRD.

## Stage 4 — Validation & orchestration kickoff

Spawn a new agent with a clean context window. Instruct it to:

1. Review `docs/tasks.md` and verify it is complete and everything is ready for the development workflow to begin: every PRD requirement is covered, every dev task has its QA and review tasks, dependencies and ordering are coherent.
2. If gaps are found, report them; route fixes back through the question-relay protocol or a Stage 3 revision pass before continuing.
3. Once everything is validated, write the kickoff prompt for the orchestration agent (e.g. `docs/agent-kickoff-prompt.md`). The prompt must instruct the orchestrator to **maximize the number of subagents it creates** to complete the tasks: assign each task in `docs/tasks.md` to a separate, new agent, with the goal of completing the entire workflow as efficiently as possible.

Stage output: validation verdict plus the orchestration kickoff prompt. The pipeline is done when the kickoff prompt exists and the user has it in hand to start the development workflow.

## Report structure

When the pipeline finishes, summarize for the user in this shape:

```
# Stapler Plan complete
## Documents produced (paths + one-line gist each)
## Open decisions the user resolved along the way
## How to kick off development (points at the kickoff prompt)
```

## Reference outputs

Exemplars of each stage's expected output shape, from the code-index project:

- `docs/architecture.md` (+ `docs/schema.md`, `docs/indexing.md`, `docs/search.md`, `docs/ast-graph.md`, `docs/mcp-server.md`) — Stage 1
- `docs/prd.md` — Stage 2
- `docs/tasks.md` — Stage 3
- `docs/agent-kickoff-prompt.md` — Stage 4
