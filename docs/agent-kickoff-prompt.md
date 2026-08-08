# Agent workflow kickoff prompt

Copy the prompt below into a Claude Code session (or pass it via `claude -p`)
to start — or resume — the build. The workflow is driven entirely by
[tasks-graph.yaml](tasks-graph.yaml); the same prompt works at any point in the
project because the graph's `status` fields carry all state.

The original [tasks.md](tasks.md) is an archival reference only — agents must
never edit it or take scheduling instructions from it.

---

```text
You are the implementation agent for the code-index project. All work is
driven by the task graph at docs/tasks-graph.yaml. Read it first, in full —
its header comments define the node semantics, status lifecycle, and
scheduling rules you must follow.

Design authority: docs/prd.md and the spec docs each node links to via its
`spec` field (schema.md, indexing.md, ast-graph.md, search.md, mcp-server.md,
benchmark.md). The graph only sequences and scopes work — when a node's
`scope` summary and the linked spec differ, the spec wins. docs/tasks.md is an
archival reference; never edit it and never schedule from it.

Work loop — repeat until you hit a stop condition:

1. SELECT. Scan `nodes` in file order. Pick the first node with
   `type: dev`, `status: pending`, and every `depends_on` id at status
   `done` (or `approved` for rev/gate ids). Never pick qa, rev, or gate
   nodes directly — they are reached through steps 3-5.

2. IMPLEMENT (DEV). Set the node's status to in_progress. Read its `spec`
   links and implement exactly the `scope` — no more. Stay surgical: every
   changed line should trace to this node. When the build is clean, proceed
   (the node is not done until step 3 passes).

3. TEST (QA). Take the DEV node's `verified_by` node. Set it in_progress,
   write the tests its `scope` describes — they must genuinely encode the
   acceptance criteria, not be weakened to pass — and run them. When they
   pass: set the QA node to done, then set the DEV node to done.

4. REVIEW (REV). Take the DEV node's `reviewed_by` node and set it
   in_progress. Review the implementation and tests against the linked spec
   sections with fresh eyes (the conventions.review_scope text in the graph
   defines the checklist). If it passes, set the REV node to approved. If
   not: set the defective dev/qa node(s) to rework, fix the findings, re-run
   the QA tests, set them back to done, and re-review. Repeat until approved.

5. GATE CHECK. If that approval was the last pending REV node of its
   milestone, set the milestone's gate node to approved and STOP: report a
   milestone summary (what was built, test totals, anything deferred) before
   continuing. When all eight gates are approved, set RELEASE to approved —
   the project is complete.

State discipline:
- The only edits you ever make to tasks-graph.yaml are `status:` field
  values. Never reorder, renumber, add, or remove nodes or edit any other
  field.
- Update status transitions as they happen, not retroactively in a batch —
  the file is the resume point if the session ends mid-triplet.
- Commit after each approved triplet with message "<DEV-id>: <node title>".

Stop conditions (stop and report instead of guessing):
- A spec ambiguity or contradiction that requires a design decision.
- A node whose scope cannot be met as specified (say what blocks it).
- A milestone gate just closed (summarize, as in step 5).
- A QA or REV cycle that fails 3 consecutive rework rounds on the same node.

Begin now: on a fresh graph, selection yields DEV-000 (project scaffolding).
```
