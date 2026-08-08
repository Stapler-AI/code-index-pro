# code-index — Agent Task List

> Task decomposition of [prd.md](prd.md) for AI developer agents. The PRD and the spec docs it cites remain the design authority — every task links to its source. This file only sequences and scopes the work.

## How to use this file

1. Pick the **first unchecked task whose "Depends on" tasks are all checked**. Milestones are dependency-ordered; within a milestone, tasks are listed in execution order. M6 may run in parallel with M3/M4 (see [dependency notes](#dependency-notes)).
2. Every **DEV** task has a paired **QA** task. The QA task builds automated tests that encode the PRD's acceptance criteria for that requirement. **A DEV task is done only when its QA task's tests pass.** Every DEV/QA pair also has a paired **REV** task: the code review agent approves the pair, and a DEV task is fully complete only when its REV task is approved.
3. Work test-adjacent: complete DEV-xxx, then immediately QA-xxx, then REV-xxx, before moving on.
4. Check the box when done. Do not reorder or renumber tasks.

**ID convention:** `DEV-104` implements FR-104; `QA-104` tests it; `REV-104` reviews DEV-104 + QA-104. x00-series IDs (`DEV-000`, `DEV-801`…) cover non-FR work (scaffolding, hardening) and carry matching REV IDs (`REV-000`, `REV-801`…).

**Task fields:** *Implements* (FR + spec links) · *Depends on* (task IDs) · *Scope* (what to build — summarized from the spec, which stays authoritative) · *Done when* (verifiable completion criteria). REV tasks use the same fields, with *Scope* describing what the review agent checks.

---

## M1 — Scaffolding + storage layer

### - [ ] DEV-000 — Project scaffolding

- **Implements:** PRD §6 technical requirements, FR-705 (bin wiring); [prd.md](prd.md#6-technical-requirements)
- **Depends on:** —
- **Scope:**
  - TypeScript project setup: `tsconfig.json`, `src/` layout, build script.
  - Dependencies, versions pinned (native-build risk, PRD §8): `better-sqlite3`, `tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript`, `@modelcontextprotocol/sdk`.
  - Test runner installed and configured.
  - `package.json` `bin` entry `code-index` → CLI stub (prints usage; real commands come in M2/M5).
- **Done when:** build passes, native modules compile on the dev platform, the bin stub runs, and QA-000's smoke test passes.

### - [ ] QA-000 — Test harness + shared fixture repos

- **Implements:** PRD §6 testing requirement ("automated tests per milestone against fixture repos")
- **Depends on:** DEV-000
- **Scope:**
  - Test-runner config wired into `package.json` scripts.
  - Fixture-repo builders (temp-dir based, reused by all later QA tasks): a small repo with JS + TS + TSX files, in **git** and **non-git** variants; helpers to write/edit/delete fixture files mid-test.
  - DB helpers: open a fixture's `.code-index/index.db`, query rows, count writes.
- **Done when:** a smoke test builds both fixture variants and asserts their file layout; harness runs green in CI-style invocation.

### - [ ] REV-000 — Review: Project scaffolding

- **Implements:** Review gate for PRD §6 technical requirements, FR-705 (bin wiring); [prd.md](prd.md#6-technical-requirements)
- **Depends on:** DEV-000, QA-000
- **Scope:** Code review agent reviews the DEV-000 implementation and QA-000 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-101 — Database location & lifecycle

- **Implements:** FR-101; [schema.md §Overview](schema.md#overview)
- **Depends on:** DEV-000
- **Scope:**
  - Open/create one SQLite DB per repo at `.code-index/index.db` via `better-sqlite3` (create `.code-index/` as needed).
  - Pragmas on open: `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`.
  - `.code-index/` is excluded from indexing (enforced in DEV-201's discovery; the exclusion constant lives here).
- **Done when:** QA-101 passes.

### - [ ] QA-101 — Tests: database open & pragmas

- **Implements:** FR-101 acceptance
- **Depends on:** DEV-101, QA-000
- **Scope:** Tests that opening a fixture repo creates `.code-index/index.db`; the three pragma values read back as configured; reopening an existing database succeeds without recreating it.
- **Done when:** tests pass.

### - [ ] REV-101 — Review: Database location & lifecycle

- **Implements:** Review gate for FR-101; [schema.md §Overview](schema.md#overview)
- **Depends on:** DEV-101, QA-101
- **Scope:** Code review agent reviews the DEV-101 implementation and QA-101 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-102 — Core tables

- **Implements:** FR-102; [schema.md §Core tables](schema.md#core-tables-ported)
- **Depends on:** DEV-101
- **Scope:** `indexed_files` and `code_chunks` exactly as specified — columns, `relative_path` UNIQUE, `ON DELETE CASCADE` from files to chunks, `idx_chunks_file_id`, `idx_chunks_node_type`, snake_case, ISO-8601 text timestamps, integer booleans. (Created via the migration mechanism once DEV-106 lands; a first migration file is acceptable here.)
- **Done when:** QA-102 passes.

### - [ ] QA-102 — Tests: core tables

- **Implements:** FR-102 acceptance
- **Depends on:** DEV-102, QA-000
- **Scope:** Schema-introspection tests (`sqlite_master`, `PRAGMA table_info`): all columns/types/indexes present; duplicate `relative_path` insert fails; deleting an `indexed_files` row cascades to its `code_chunks`.
- **Done when:** tests pass.

### - [ ] REV-102 — Review: Core tables

- **Implements:** Review gate for FR-102; [schema.md §Core tables](schema.md#core-tables-ported)
- **Depends on:** DEV-102, QA-102
- **Scope:** Code review agent reviews the DEV-102 implementation and QA-102 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-103 — Graph tables

- **Implements:** FR-103; [schema.md §Graph tables](schema.md#graph-tables-new)
- **Depends on:** DEV-102
- **Scope:** `symbols` and `edges` exactly as specified: cascade from `indexed_files`; `symbols.chunk_id` → `ON DELETE SET NULL`; `edges.source_symbol_id` → CASCADE; `edges.target_symbol_id` → `SET NULL`; indexes `idx_symbols_name`, `idx_symbols_file`, and the four edge indexes (`source`, `target`, `target_name`, `type`).
- **Done when:** QA-103 passes.

### - [ ] QA-103 — Tests: graph tables & delete behaviors

- **Implements:** FR-103 acceptance
- **Depends on:** DEV-103, QA-000
- **Scope:** Tests: deleting a file cascades to its symbols and edges; deleting a chunk nulls `symbols.chunk_id`; deleting a target symbol nulls `edges.target_symbol_id` while deleting a source symbol removes the edge; all six indexes exist.
- **Done when:** tests pass.

### - [ ] REV-103 — Review: Graph tables

- **Implements:** Review gate for FR-103; [schema.md §Graph tables](schema.md#graph-tables-new)
- **Depends on:** DEV-103, QA-103
- **Scope:** Code review agent reviews the DEV-103 implementation and QA-103 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-104 — FTS5 mirror

- **Implements:** FR-104; [schema.md §Full-text search](schema.md#full-text-search-new)
- **Depends on:** DEV-102
- **Scope:** External-content `chunks_fts` over `content` + `node_name` (`content='code_chunks'`, `content_rowid='id'`); AFTER INSERT and AFTER DELETE triggers exactly as in the spec (no UPDATE trigger — the indexer never updates chunk rows).
- **Done when:** QA-104 passes.

### - [ ] QA-104 — Tests: FTS consistency

- **Implements:** FR-104 acceptance ("FTS content stays consistent with `code_chunks` after insert/delete cycles")
- **Depends on:** DEV-104, QA-000
- **Scope:** Tests: inserted chunks are findable via `MATCH` on both content and `node_name`; after repeated insert→delete→insert cycles, FTS row count equals `code_chunks` count and deleted content is unfindable; a `bm25()`-ordered query with `snippet()` returns the spec's join shape.
- **Done when:** tests pass.

### - [ ] REV-104 — Review: FTS5 mirror

- **Implements:** Review gate for FR-104; [schema.md §Full-text search](schema.md#full-text-search-new)
- **Depends on:** DEV-104, QA-104
- **Scope:** Code review agent reviews the DEV-104 implementation and QA-104 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-105 — Meta table

- **Implements:** FR-105; [schema.md §Meta table](schema.md#meta-table)
- **Depends on:** DEV-102
- **Scope:** `meta` key/value table; populate `schema_version`, `repo_root` (absolute path at creation), `tool_version` on database creation; a check helper that reports mismatch (incompatible version, copied database) for the health check to act on.
- **Done when:** QA-105 passes.

### - [ ] QA-105 — Tests: meta population & mismatch detection

- **Implements:** FR-105 acceptance
- **Depends on:** DEV-105, QA-000
- **Scope:** Tests: a fresh database contains the three rows with correct values; the mismatch helper flags a database whose `repo_root` differs (simulated copy) and whose `schema_version` differs.
- **Done when:** tests pass.

### - [ ] REV-105 — Review: Meta table

- **Implements:** Review gate for FR-105; [schema.md §Meta table](schema.md#meta-table)
- **Depends on:** DEV-105, QA-105
- **Scope:** Code review agent reviews the DEV-105 implementation and QA-105 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-106 — Migrations

- **Implements:** FR-106; [schema.md §Migrations](schema.md#migrations)
- **Depends on:** DEV-102, DEV-103, DEV-104, DEV-105
- **Scope:** Numbered forward-only migration runner tracked via `PRAGMA user_version`; each migration in its own transaction, bumping `user_version` last; all table/trigger/index DDL from DEV-102/103/104/105 consolidated as migration 1; a `user_version` higher than the tool knows is reported as *foreign* (quarantine handled by DEV-107).
- **Done when:** QA-106 passes.

### - [ ] QA-106 — Tests: migration runner

- **Implements:** FR-106 acceptance
- **Depends on:** DEV-106, QA-000
- **Scope:** Tests: a fresh database migrates 0→current and `user_version` matches; reopening is a no-op (no DDL re-runs); a database with `user_version` = current+1 is reported foreign.
- **Done when:** tests pass.

### - [ ] REV-106 — Review: Migrations

- **Implements:** Review gate for FR-106; [schema.md §Migrations](schema.md#migrations)
- **Depends on:** DEV-106, QA-106
- **Scope:** Code review agent reviews the DEV-106 implementation and QA-106 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-107 — Health check & quarantine-and-rebuild

- **Implements:** FR-107; [schema.md §Health check and recovery](schema.md#health-check-and-recovery)
- **Depends on:** DEV-106
- **Scope:**
  - On every open: required tables exist (`indexed_files`, `code_chunks`, `symbols`, `edges`, `chunks_fts`, `meta`) via `sqlite_master`; `PRAGMA quick_check` returns exactly `ok`; meta values match (DEV-105 helper); foreign `user_version` (DEV-106) fails the check.
  - On failure: move `index.db` + `-wal`/`-shm` sidecars to `index.db.quarantine-<ISO-timestamp>`; create fresh; run migrations; flag "full re-index required"; record a recovery event retrievable later by `index_status` (FR-604).
- **Done when:** QA-107 passes.

### - [ ] QA-107 — Tests: recovery drill

- **Implements:** FR-107 acceptance ("a deliberately corrupted file is quarantined (sidecar files included) and rebuilt without error"; "fresh database passes health check"; "higher `user_version` rebuilds")
- **Depends on:** DEV-107, QA-000
- **Scope:** Tests: a fresh database passes the health check; overwriting `index.db` with garbage bytes → open succeeds, quarantine file (with sidecars) exists with ISO-stamped name, new database is healthy, recovery event recorded; a higher-`user_version` database is quarantined and rebuilt; a copied database (wrong `repo_root`) is rebuilt.
- **Done when:** tests pass.

### - [ ] REV-107 — Review: Health check & quarantine-and-rebuild

- **Implements:** Review gate for FR-107; [schema.md §Health check and recovery](schema.md#health-check-and-recovery)
- **Depends on:** DEV-107, QA-107
- **Scope:** Code review agent reviews the DEV-107 implementation and QA-107 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-108 — Write patterns

- **Implements:** FR-108; [schema.md §Write patterns](schema.md#write-patterns)
- **Depends on:** DEV-106
- **Scope:** `upsertFile` (by `relative_path`, returns `id`); `replaceChunks(fileId, chunks)` as delete-then-insert (keeps FTS triggers sufficient), maintaining `chunk_count`; same-pattern replacement for a file's symbols and edges; stale-prune helper (delete `indexed_files` rows not in a seen-set); **all per-file writes wrapped in one transaction**.
- **Done when:** QA-108 passes.

### - [ ] QA-108 — Tests: write patterns & atomicity

- **Implements:** FR-108 acceptance
- **Depends on:** DEV-108, QA-000
- **Scope:** Tests: `upsertFile` twice with same path returns the same id with updated fields; `replaceChunks` leaves `chunk_count` and FTS consistent; graph-row replacement removes old rows and inserts fresh; a failure injected mid-write rolls back the whole file (no half-indexed state); prune helper cascades.
- **Done when:** tests pass.

### - [ ] REV-108 — Review: Write patterns

- **Implements:** Review gate for FR-108; [schema.md §Write patterns](schema.md#write-patterns)
- **Depends on:** DEV-108, QA-108
- **Scope:** Code review agent reviews the DEV-108 implementation and QA-108 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

---

## M2 — Indexer pipeline + basic CLI

### - [ ] DEV-201 — File discovery

- **Implements:** FR-201; [indexing.md §File discovery](indexing.md#file-discovery)
- **Depends on:** DEV-000
- **Scope:** `git ls-files --cached --others --exclude-standard` from the repo root, paths under `.code-index/` excluded; non-git fallback: glob walk skipping `node_modules`, `.git`, hidden directories, `.code-index`.
- **Done when:** QA-201 passes.

### - [ ] QA-201 — Tests: discovery (git + fallback)

- **Implements:** FR-201 acceptance; FR-200 acceptance ("a non-git directory indexes via the fallback walker")
- **Depends on:** DEV-201, QA-000
- **Scope:** Tests on both fixture variants: git repo lists tracked + untracked files but not gitignored ones or `.code-index/`; non-git walk skips `node_modules`, hidden dirs, `.git`.
- **Done when:** tests pass.

### - [ ] REV-201 — Review: File discovery

- **Implements:** Review gate for FR-201; [indexing.md §File discovery](indexing.md#file-discovery)
- **Depends on:** DEV-201, QA-201
- **Scope:** Code review agent reviews the DEV-201 implementation and QA-201 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-202 — Language detection

- **Implements:** FR-202; [indexing.md §Language detection](indexing.md#language-detection)
- **Depends on:** DEV-000
- **Scope:** Extension → language mapping for v1: `js|mjs|cjs|jsx` → `javascript`, `ts|mts|cts` → `typescript`, `tsx` → `tsx`; unrecognized extensions are skipped entirely (staged languages stay out).
- **Done when:** QA-202 passes.

### - [ ] QA-202 — Tests: language detection

- **Implements:** FR-202 acceptance
- **Depends on:** DEV-202, QA-000
- **Scope:** Table-driven test over all eight v1 extensions plus unknown ones (`.json`, `.py`, `.md`, no extension) asserting skip.
- **Done when:** tests pass.

### - [ ] REV-202 — Review: Language detection

- **Implements:** Review gate for FR-202; [indexing.md §Language detection](indexing.md#language-detection)
- **Depends on:** DEV-202, QA-202
- **Scope:** Code review agent reviews the DEV-202 implementation and QA-202 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-203 — Change detection

- **Implements:** FR-203; [indexing.md §Change detection](indexing.md#change-detection)
- **Depends on:** DEV-108
- **Scope:** Per discovered file: skip > 1 MB; skip non-UTF-8 (decode failure = binary); SHA-256 of raw bytes; skip when an `indexed_files` row matches `(relative_path, file_hash)`.
- **Done when:** QA-203 passes.

### - [ ] QA-203 — Tests: change detection

- **Implements:** FR-203 acceptance; FR-200 acceptance ("a 1 MB+ file and a binary file are skipped")
- **Depends on:** DEV-203, QA-000
- **Scope:** Tests: a 1 MB+ fixture file is skipped; a binary (invalid UTF-8) file is skipped; an unchanged file (matching hash row) is skipped; a content change (new hash) is selected for re-index.
- **Done when:** tests pass.

### - [ ] REV-203 — Review: Change detection

- **Implements:** Review gate for FR-203; [indexing.md §Change detection](indexing.md#change-detection)
- **Depends on:** DEV-203, QA-203
- **Scope:** Code review agent reviews the DEV-203 implementation and QA-203 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-204 — Chunk extraction

- **Implements:** FR-204; [indexing.md §Chunk extraction](indexing.md#chunk-extraction)
- **Depends on:** DEV-108, DEV-202
- **Scope:**
  - tree-sitter parse; recursive walk emitting a `code_chunks` row per node in the per-language meaningful-node-types allowlist (javascript and typescript/tsx lists verbatim from the spec).
  - Per chunk: `node_name` from the node's `name` field; `context_path` of meaningful ancestors + self joined with `" > "`; `depth` counting meaningful ancestors only; 1-indexed lines; byte offsets; `content` capped at 2000 chars with `...` appended.
  - Nested meaningful nodes each get their own chunk (class chunk + one per method).
- **Done when:** QA-204 passes.

### - [ ] QA-204 — Tests: chunk extraction

- **Implements:** FR-204 acceptance
- **Depends on:** DEV-204, QA-000
- **Scope:** Golden-row tests per language (JS, TS, TSX fixtures): expected `node_type`, `node_name`, `context_path`, `depth`, line numbers; a >2000-char function is truncated with trailing `...` while its byte offsets still slice the full body from the source file; a class yields its own chunk plus per-method chunks.
- **Done when:** tests pass.

### - [ ] REV-204 — Review: Chunk extraction

- **Implements:** Review gate for FR-204; [indexing.md §Chunk extraction](indexing.md#chunk-extraction)
- **Depends on:** DEV-204, QA-204
- **Scope:** Code review agent reviews the DEV-204 implementation and QA-204 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-205 — Stale pruning

- **Implements:** FR-205; [indexing.md §Change detection](indexing.md#change-detection)
- **Depends on:** DEV-108, DEV-201
- **Scope:** At end of every run, delete `indexed_files` rows whose `relative_path` was not seen during discovery; cascades remove chunks, symbols, edges (uses DEV-108's prune helper).
- **Done when:** QA-205 passes.

### - [ ] QA-205 — Tests: stale pruning

- **Implements:** FR-205 acceptance; FR-200 acceptance ("deleting a file removes all its rows via cascade")
- **Depends on:** DEV-205, QA-000
- **Scope:** Test: index fixture; delete one source file; re-run; its `indexed_files`, `code_chunks` (and FTS mirror) rows are gone.
- **Done when:** tests pass.

### - [ ] REV-205 — Review: Stale pruning

- **Implements:** Review gate for FR-205; [indexing.md §Change detection](indexing.md#change-detection)
- **Depends on:** DEV-205, QA-205
- **Scope:** Code review agent reviews the DEV-205 implementation and QA-205 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-206 — Pipeline orchestration

- **Implements:** FR-206; [indexing.md §Pipeline overview](indexing.md#pipeline-overview)
- **Depends on:** DEV-201–DEV-205
- **Scope:** Wire discover → filter → hash/diff → parse → chunk → *(extraction hook, filled by M3)* → *(resolution hook, filled by M3)* → persist → prune. One transaction per file for parse→persist; the resolution hook runs once per run after all changed files are written; return a run delta (files added/updated/removed, duration) for `reindex`/CLI use.
- **Done when:** QA-206 passes.

### - [ ] QA-206 — Tests: incremental pipeline

- **Implements:** FR-206 acceptance ("first run indexes all eligible files; immediate second run writes zero rows; editing one file re-indexes only it")
- **Depends on:** DEV-206, QA-000
- **Scope:** Tests: first run indexes every eligible fixture file; an immediate second run performs zero row writes (assert via SQLite `total_changes` or unchanged `last_indexed` values); editing one file re-indexes only that file.
- **Done when:** tests pass.

### - [ ] REV-206 — Review: Pipeline orchestration

- **Implements:** Review gate for FR-206; [indexing.md §Pipeline overview](indexing.md#pipeline-overview)
- **Depends on:** DEV-206, QA-206
- **Scope:** Code review agent reviews the DEV-206 implementation and QA-206 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-701 — CLI: `index`

- **Implements:** FR-701; [indexing.md §CLI entry points](indexing.md#cli-entry-points-planned)
- **Depends on:** DEV-206
- **Scope:** `code-index index [path]` runs an incremental pipeline run (path defaults to cwd); `--full` clears all rows first, then runs. Print the run delta.
- **Done when:** QA-701 passes.

### - [ ] QA-701 — Tests: `index` command

- **Implements:** FR-701 / FR-700 acceptance
- **Depends on:** DEV-701, QA-000
- **Scope:** Tests invoking the CLI against a fixture: first run populates the DB; `--full` after an edit rebuilds from empty and converges to the same row counts.
- **Done when:** tests pass.

### - [ ] REV-701 — Review: CLI: `index`

- **Implements:** Review gate for FR-701; [indexing.md §CLI entry points](indexing.md#cli-entry-points-planned)
- **Depends on:** DEV-701, QA-701
- **Scope:** Code review agent reviews the DEV-701 implementation and QA-701 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-702 — CLI: `stats`

- **Implements:** FR-702
- **Depends on:** DEV-206
- **Scope:** `code-index stats` prints files/chunks/symbols per language, unresolved-edge count, last run time (symbols/edges read as 0 until M3 lands).
- **Done when:** QA-702 passes.

### - [ ] QA-702 — Tests: `stats` command

- **Implements:** FR-702 acceptance ("`stats` output matches database contents")
- **Depends on:** DEV-702, QA-000
- **Scope:** Test: index a fixture, run `stats`, parse output, assert counts equal direct SQL counts.
- **Done when:** tests pass.

### - [ ] REV-702 — Review: CLI: `stats`

- **Implements:** Review gate for FR-702
- **Depends on:** DEV-702, QA-702
- **Scope:** Code review agent reviews the DEV-702 implementation and QA-702 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-703 — CLI: `clear`

- **Implements:** FR-703
- **Depends on:** DEV-108
- **Scope:** `code-index clear` deletes all rows (or removes the whole `.code-index/` directory).
- **Done when:** QA-703 passes.

### - [ ] QA-703 — Tests: `clear` command

- **Implements:** FR-703 acceptance
- **Depends on:** DEV-703, QA-000
- **Scope:** Test: after indexing, `clear` leaves an empty index (zero rows or no `.code-index/`); a subsequent `index` run works from scratch.
- **Done when:** tests pass.

### - [ ] REV-703 — Review: CLI: `clear`

- **Implements:** Review gate for FR-703
- **Depends on:** DEV-703, QA-703
- **Scope:** Code review agent reviews the DEV-703 implementation and QA-703 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-705 — Package bin wiring

- **Implements:** FR-705
- **Depends on:** DEV-000, DEV-701
- **Scope:** Finalize the `bin` entry started in DEV-000 so `npx code-index …` works: shebang, built entry point, command dispatch (`index`, `stats`, `clear`; `serve` added in M5).
- **Done when:** QA-705 passes.

### - [ ] QA-705 — Tests: bin invocation

- **Implements:** FR-705 acceptance ("the three README quick-start commands work against a real repo")
- **Depends on:** DEV-705, QA-000
- **Scope:** Test executing the packaged bin (direct `node <bin>` or `npm pack`-based) running `index`, `stats`, `clear` against a fixture end-to-end.
- **Done when:** tests pass.

### - [ ] REV-705 — Review: Package bin wiring

- **Implements:** Review gate for FR-705
- **Depends on:** DEV-705, QA-705
- **Scope:** Code review agent reviews the DEV-705 implementation and QA-705 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

---

## M3 — Symbol graph

### - [ ] DEV-301 — Tree-sitter query files

- **Implements:** FR-301; [indexing.md §Symbol and edge extraction](indexing.md#symbol-and-edge-extraction-new), [ast-graph.md §Construction](ast-graph.md#construction)
- **Depends on:** DEV-204
- **Scope:** `queries/javascript/{symbols,edges}.scm` and `queries/typescript/{symbols,edges}.scm` (typescript set serves `tsx` too); loader that compiles them per grammar; extraction runs against the **same parse tree** used for chunking — no second parse.
- **Done when:** QA-301 passes.

### - [ ] QA-301 — Tests: query files compile & capture

- **Implements:** FR-301 acceptance
- **Depends on:** DEV-301, QA-000
- **Scope:** Tests: all four `.scm` files compile against their grammars (including the `tsx` grammar — PRD §8 grammar-quirk risk); running them on fixture trees yields captures; the extraction API accepts an existing tree (no re-parse).
- **Done when:** tests pass.

### - [ ] REV-301 — Review: Tree-sitter query files

- **Implements:** Review gate for FR-301; [indexing.md §Symbol and edge extraction](indexing.md#symbol-and-edge-extraction-new), [ast-graph.md §Construction](ast-graph.md#construction)
- **Depends on:** DEV-301, QA-301
- **Scope:** Code review agent reviews the DEV-301 implementation and QA-301 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-302 — Symbol extraction

- **Implements:** FR-302; [ast-graph.md §Node model](ast-graph.md#node-model)
- **Depends on:** DEV-301
- **Scope:** Declarations → `symbols` rows: functions, classes, methods, exported consts/lets, interfaces, type aliases, enums. `kind` mapped from node type; one-line token-cheap `signature` (params + TS return annotation, per the mapping-table examples); `exported` for ESM `export` and CJS `module.exports`; `chunk_id` linked to the body chunk when one exists.
- **Done when:** QA-302 passes.

### - [ ] QA-302 — Tests: symbol rows

- **Implements:** FR-302 / FR-300 acceptance ("extracted symbols … match expected rows")
- **Depends on:** DEV-302, QA-000
- **Scope:** Golden-row tests per language covering every kind; signature strings match ast-graph.md's mapping examples; `exported` correct for ESM and CJS; each symbol's `chunk_id` points at its body chunk.
- **Done when:** tests pass.

### - [ ] REV-302 — Review: Symbol extraction

- **Implements:** Review gate for FR-302; [ast-graph.md §Node model](ast-graph.md#node-model)
- **Depends on:** DEV-302, QA-302
- **Scope:** Code review agent reviews the DEV-302 implementation and QA-302 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-303 — Edge extraction

- **Implements:** FR-303; [ast-graph.md §Edge model](ast-graph.md#edge-model)
- **Depends on:** DEV-301
- **Scope:** Six directed edge types: `calls` (callee identifier, or property name for `obj.method()`), `imports` (one edge per specifier, `target_module` = source string), `exports`, `references` (non-call identifier uses of known symbol names), `extends`, `implements` (TS). Every edge records `source_file_id`, `source_symbol_id` (innermost enclosing symbol, `NULL` at file scope), `target_name` (always populated), `line`. Extraction writes `target_symbol_id = NULL`.
- **Done when:** QA-303 passes.

### - [ ] QA-303 — Tests: edge rows

- **Implements:** FR-303 / FR-300 acceptance ("… edges match expected rows")
- **Depends on:** DEV-303, QA-000
- **Scope:** Golden-row tests: one fixture exercising all six edge types; `obj.method()` records the property name; top-level imports carry `source_symbol_id = NULL` and correct `target_module`; a call inside a function attributes to that innermost symbol.
- **Done when:** tests pass.

### - [ ] REV-303 — Review: Edge extraction

- **Implements:** Review gate for FR-303; [ast-graph.md §Edge model](ast-graph.md#edge-model)
- **Depends on:** DEV-303, QA-303
- **Scope:** Code review agent reviews the DEV-303 implementation and QA-303 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-304 — Edge resolution pass

- **Implements:** FR-304; [indexing.md §Edge resolution](indexing.md#edge-resolution)
- **Depends on:** DEV-302, DEV-303, DEV-206
- **Scope:** After the batch persists, resolve in order: (1) import-based — resolve the specifier via simplified Node resolution (relative path + extension guessing `[.js, .ts, .tsx, /index.*]`), link the named or default export; (2) same-file declaration; (3) unique-name fallback across exported symbols repo-wide; (4) leave `target_symbol_id = NULL`. `package.json` `exports` maps and tsconfig path aliases are explicitly out of scope. Runs in DEV-206's resolution hook.
- **Done when:** QA-304 passes.

### - [ ] QA-304 — Tests: resolution ladder

- **Implements:** FR-304 / FR-300 acceptance ("a cross-file call resolves via its import; an ambiguous method name stays unresolved")
- **Depends on:** DEV-304, QA-000
- **Scope:** Tests: cross-file call resolves through its import (including extensionless `./x` → `x.ts` and `./dir` → `dir/index.ts`); same-file call resolves; a uniquely-named exported symbol resolves via fallback; two classes with the same method name → edge stays `NULL`; an import from `react`/`node_modules` stays unresolved with `target_module` populated.
- **Done when:** tests pass.

### - [ ] REV-304 — Review: Edge resolution pass

- **Implements:** Review gate for FR-304; [indexing.md §Edge resolution](indexing.md#edge-resolution)
- **Depends on:** DEV-304, QA-304
- **Scope:** Code review agent reviews the DEV-304 implementation and QA-304 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-305 — Incremental re-resolution

- **Implements:** FR-305; [indexing.md §Edge resolution](indexing.md#edge-resolution) (incremental invariant)
- **Depends on:** DEV-304
- **Scope:** When file F is re-indexed: edges from F are dropped and re-extracted (cascade handles it); compute the set of symbol names F **gained or lost**; re-resolve edges elsewhere whose `target_name` is in that set (lookup via `idx_edges_target_name`). No other edges are touched.
- **Done when:** QA-305 passes.

### - [ ] QA-305 — Tests: rename re-resolution

- **Implements:** FR-305 / FR-300 acceptance ("renaming an exported symbol in one file re-resolves inbound edges from other files without re-indexing them")
- **Depends on:** DEV-305, QA-000
- **Scope:** Tests: rename an exported symbol in F, re-run; inbound edges in other files now resolve to the new symbol (or drop to `NULL` for the old name) while those files' `last_indexed` values are unchanged; unrelated edges keep their ids/values.
- **Done when:** tests pass.

### - [ ] REV-305 — Review: Incremental re-resolution

- **Implements:** Review gate for FR-305; [indexing.md §Edge resolution](indexing.md#edge-resolution) (incremental invariant)
- **Depends on:** DEV-305, QA-305
- **Scope:** Code review agent reviews the DEV-305 implementation and QA-305 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-306 — Documented limitations preserved

- **Implements:** FR-306; [indexing.md §Known limitations](indexing.md#known-limitations)
- **Depends on:** DEV-304
- **Scope:** Ensure the four accepted limitations (no type inference; dynamic constructs invisible; re-exports/aliases one level; repo-local resolution) hold as designed — not "fixed" — and are stated in code docs where consumers read edge data, so unresolved edges are treated as hints.
- **Done when:** QA-306 passes.

### - [ ] QA-306 — Tests: limitations behave as documented

- **Implements:** FR-306 acceptance
- **Depends on:** DEV-306, QA-000
- **Scope:** Tests: a dynamic `import(variable)` and computed call produce no misleading resolved edge; an aliased import (`import { a as b }`) resolves one level; ambiguous names remain present-but-unresolved (visible with `target_name`, not dropped).
- **Done when:** tests pass.

### - [ ] REV-306 — Review: Documented limitations preserved

- **Implements:** Review gate for FR-306; [indexing.md §Known limitations](indexing.md#known-limitations)
- **Depends on:** DEV-306, QA-306
- **Scope:** Code review agent reviews the DEV-306 implementation and QA-306 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

---

## M4 — Query layer

### - [ ] DEV-401 — Text search (FTS)

- **Implements:** FR-401; [search.md §Text search](search.md#text-search-fts5)
- **Depends on:** DEV-104, DEV-206
- **Scope:** `search_code` query function: FTS5 `MATCH` over `content` + `node_name`, `bm25()` ranking, `snippet()` excerpts; expose the FTS5 syntax subset (terms, phrases, prefix, `NEAR`, column filters); `limit` and `path_prefix` params.
- **Done when:** QA-401 passes.

### - [ ] QA-401 — Tests: FTS search modes

- **Implements:** FR-401 acceptance
- **Depends on:** DEV-401, QA-000
- **Scope:** Tests per syntax mode (term, phrase, prefix, `NEAR`, column filter) against an indexed fixture: expected hits, bm25 ordering, snippet markers present, `path_prefix` filtering.
- **Done when:** tests pass.

### - [ ] REV-401 — Review: Text search (FTS)

- **Implements:** Review gate for FR-401; [search.md §Text search](search.md#text-search-fts5)
- **Depends on:** DEV-401, QA-401
- **Scope:** Code review agent reviews the DEV-401 implementation and QA-401 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-402 — Seven graph queries

- **Implements:** FR-402; [ast-graph.md §Query use-cases](ast-graph.md#query-use-cases)
- **Depends on:** DEV-304
- **Scope:** Implement the seven queries from their SQL sketches: who-calls (including unresolved name-matches, flagged); outbound dependencies; transitive impact closure (recursive CTE, cycle-safe via `UNION`, depth-capped, default 3); file/module dependency map (aggregating `target_module` so unresolved edges count); class hierarchy (ancestors + descendants, depth-capped); dead exports (excluding symbols possibly targeted by unresolved edges); file outline.
- **Done when:** QA-402 passes.

### - [ ] QA-402 — Tests: graph queries

- **Implements:** FR-402 / FR-400 acceptance ("each decision-matrix row … answerable"; "a cyclic call graph terminates with correct distances"; "the dead-exports query does not flag symbols matched by unresolved edges")
- **Depends on:** DEV-402, QA-000
- **Scope:** Tests: each index-backed [decision-matrix](search.md#decision-matrix) row answered correctly on a fixture; a fixture with a call cycle terminates with correct minimum distances; dead-exports skips symbols whose name matches an unresolved edge; hierarchy works both directions; module map includes `node_modules` specifiers via `target_module`.
- **Done when:** tests pass.

### - [ ] REV-402 — Review: Seven graph queries

- **Implements:** Review gate for FR-402; [ast-graph.md §Query use-cases](ast-graph.md#query-use-cases)
- **Depends on:** DEV-402, QA-402
- **Scope:** Code review agent reviews the DEV-402 implementation and QA-402 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-403 — Result envelope

- **Implements:** FR-403; [search.md §Result normalization](search.md#result-normalization)
- **Depends on:** DEV-401, DEV-402
- **Scope:** All modes return `{path, lines, preview, id}`; `id` only for index-backed results; graph results are `{id, name, kind, signature, path, line}` tuples — never bodies; unresolved matches carry `resolved: false`.
- **Done when:** QA-403 passes.

### - [ ] QA-403 — Tests: envelope conformance

- **Implements:** FR-403 acceptance
- **Depends on:** DEV-403, QA-000
- **Scope:** Shape tests over every query function's output: envelope keys, no body/content fields in graph results, `resolved: false` present exactly on unresolved matches.
- **Done when:** tests pass.

### - [ ] REV-403 — Review: Result envelope

- **Implements:** Review gate for FR-403; [search.md §Result normalization](search.md#result-normalization)
- **Depends on:** DEV-403, QA-403
- **Scope:** Code review agent reviews the DEV-403 implementation and QA-403 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-404 — Caps & truncation

- **Implements:** FR-404
- **Depends on:** DEV-403
- **Scope:** `limit` (default 20–50 per query) and `max_depth` (default 3) as first-class parameters on every list-returning query; every truncated response says so (`truncated: true`).
- **Done when:** QA-404 passes.

### - [ ] QA-404 — Tests: caps honored

- **Implements:** FR-404 acceptance
- **Depends on:** DEV-404, QA-000
- **Scope:** Tests: results beyond `limit` are cut with `truncated: true`; under-limit results report no truncation; `max_depth` bounds the impact closure.
- **Done when:** tests pass.

### - [ ] REV-404 — Review: Caps & truncation

- **Implements:** Review gate for FR-404
- **Depends on:** DEV-404, QA-404
- **Scope:** Code review agent reviews the DEV-404 implementation and QA-404 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

---

## M5 — MCP server

### - [ ] DEV-601 — Server shell & startup

- **Implements:** FR-601; [mcp-server.md](mcp-server.md)
- **Depends on:** DEV-107, DEV-206
- **Scope:** Stdio MCP server on `@modelcontextprotocol/sdk`; repo root as startup argument; on startup open with health-check/recovery (DEV-107), then kick off an incremental reindex in the background **without blocking the first tool call**.
- **Done when:** QA-601 passes.

### - [ ] QA-601 — Tests: startup behavior

- **Implements:** FR-601 / FR-600 acceptance ("first tool call succeeds while startup reindex is still running")
- **Depends on:** DEV-601, QA-000
- **Scope:** Tests (MCP client over stdio against a spawned server): initialize handshake succeeds; a tool call issued immediately at startup succeeds while the background reindex is still running (large fixture or injected delay); a corrupted database at startup is quarantined and the server still comes up.
- **Done when:** tests pass.

### - [ ] REV-601 — Review: Server shell & startup

- **Implements:** Review gate for FR-601; [mcp-server.md](mcp-server.md)
- **Depends on:** DEV-601, QA-601
- **Scope:** Code review agent reviews the DEV-601 implementation and QA-601 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-602 — Tool catalog (11 tools)

- **Implements:** FR-602; [mcp-server.md §Tool catalog](mcp-server.md#tool-catalog)
- **Depends on:** DEV-601, DEV-404
- **Scope:** Register all 11 tools with the params/returns in the catalog: `index_status`, `reindex`, `search_code`, `search_structural` (stub until M6 — returns the FR-503 missing-prerequisite error until DEV-501 lands), `get_chunk`, `file_outline`, `find_symbol`, `who_calls`, `get_dependencies`, `impact_of_change`, `module_map`. Tools delegate to the M4 query layer and DEV-206 pipeline.
- **Done when:** QA-602 passes.

### - [ ] QA-602 — Tests: catalog & worked example

- **Implements:** FR-602 / FR-600 acceptance ("the worked rename session executes end-to-end with responses matching the documented shapes")
- **Depends on:** DEV-602, QA-000
- **Scope:** Tests: `tools/list` returns all 11 with expected schemas; each tool invoked on a fixture returns its documented shape; the [worked rename session](mcp-server.md#example-agent-session) (`find_symbol` → `who_calls` → `get_chunk` → edit → `reindex`) executes end-to-end with correct results.
- **Done when:** tests pass.

### - [ ] REV-602 — Review: Tool catalog (11 tools)

- **Implements:** Review gate for FR-602; [mcp-server.md §Tool catalog](mcp-server.md#tool-catalog)
- **Depends on:** DEV-602, QA-602
- **Scope:** Code review agent reviews the DEV-602 implementation and QA-602 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-603 — Design rules enforcement

- **Implements:** FR-603; [mcp-server.md §Design rules](mcp-server.md#design-rules)
- **Depends on:** DEV-602
- **Scope:** Summaries by default — bodies only via `get_chunk`; every list capped/paginated with `truncated` flags (reusing DEV-404); every result carries an id and `path` + line range.
- **Done when:** QA-603 passes.

### - [ ] QA-603 — Tests: design-rule conformance

- **Implements:** FR-603 acceptance
- **Depends on:** DEV-603, QA-000
- **Scope:** Parametrized test over every list-returning tool: no full-source fields outside `get_chunk`; caps + `truncated` flags present; id/path/lines on every result.
- **Done when:** tests pass.

### - [ ] REV-603 — Review: Design rules enforcement

- **Implements:** Review gate for FR-603; [mcp-server.md §Design rules](mcp-server.md#design-rules)
- **Depends on:** DEV-603, QA-603
- **Scope:** Code review agent reviews the DEV-603 implementation and QA-603 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-604 — Staleness & confidence signals

- **Implements:** FR-604; [mcp-server.md §Error and staleness behavior](mcp-server.md#error-and-staleness-behavior)
- **Depends on:** DEV-602
- **Scope:** Every index-backed response includes `index_age_seconds` (`search_structural` exempt); graph tools include `unresolved_edges` counts for the traversed region; `index_status` reports quarantine/rebuild events (from DEV-107's recorded events).
- **Done when:** QA-604 passes.

### - [ ] QA-604 — Tests: signals present

- **Implements:** FR-604 acceptance
- **Depends on:** DEV-604, QA-000
- **Scope:** Tests: `index_age_seconds` on every index-backed tool response and absent from `search_structural`; `unresolved_edges` on graph tool responses matches fixture ground truth; after a forced quarantine, `index_status` reports it.
- **Done when:** tests pass.

### - [ ] REV-604 — Review: Staleness & confidence signals

- **Implements:** Review gate for FR-604; [mcp-server.md §Error and staleness behavior](mcp-server.md#error-and-staleness-behavior)
- **Depends on:** DEV-604, QA-604
- **Scope:** Code review agent reviews the DEV-604 implementation and QA-604 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-704 — CLI: `serve`

- **Implements:** FR-704
- **Depends on:** DEV-601, DEV-705
- **Scope:** `code-index serve [path]` starts the MCP server for the given repo root (dispatch added to the DEV-705 bin).
- **Done when:** QA-704 passes.

### - [ ] QA-704 — Tests: `serve` & registration

- **Implements:** FR-704 / FR-600 acceptance ("the server registers via `.mcp.json` / `claude mcp add` as shown")
- **Depends on:** DEV-704, QA-000
- **Scope:** Tests: spawning the bin with `serve .` yields a server that completes an MCP initialize handshake over stdio — i.e., the exact command shape from the [registration example](mcp-server.md#registration) works.
- **Done when:** tests pass.

### - [ ] REV-704 — Review: CLI: `serve`

- **Implements:** Review gate for FR-704
- **Depends on:** DEV-704, QA-704
- **Scope:** Code review agent reviews the DEV-704 implementation and QA-704 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

---

## M6 — Structural search (parallel-eligible with M3/M4 — needs only DEV-601's server shell)

### - [ ] DEV-501 — ast-grep invocation

- **Implements:** FR-501; [search.md §Structural search](search.md#structural-search-ast-grep)
- **Depends on:** DEV-601
- **Scope:** Shell out to the `ast-grep` CLI with `--json`: `ast-grep run --pattern <p> --lang <lang> --json <paths>` for single-node patterns; `ast-grep scan --inline-rules <yaml> --json <paths>` for YAML rules. Parse JSON into the shared envelope (no `id`; matched text as `preview`). Always parses the live working tree — never the database. Pin/document a minimum ast-grep version (PRD §8 output-drift risk). Registered as the `search_structural` tool when DEV-602's catalog lands (DEV-602 ships the FR-503 stub until then).
- **Done when:** QA-501 passes.

### - [ ] QA-501 — Tests: pattern & rule queries, freshness

- **Implements:** FR-501 / FR-500 acceptance ("a pattern query and an inline-rules query both return normalized results; an edit made after the last index run is found")
- **Depends on:** DEV-501, QA-000
- **Scope:** Tests (ast-grep binary installed in the test environment): a `--pattern` query and an `--inline-rules` query each return normalized envelope results; **freshness drill** — edit a fixture file after the last index run and confirm `search_structural` finds the new code while `search_code` does not.
- **Done when:** tests pass.

### - [ ] REV-501 — Review: ast-grep invocation

- **Implements:** Review gate for FR-501; [search.md §Structural search](search.md#structural-search-ast-grep)
- **Depends on:** DEV-501, QA-501
- **Scope:** Code review agent reviews the DEV-501 implementation and QA-501 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-502 — Scope control

- **Implements:** FR-502
- **Depends on:** DEV-501
- **Scope:** Accept a `paths` filter passed through to ast-grep; optionally pre-filter candidate files via the index (restrict to the pattern's language, or to files matching an FTS keyword) before invoking.
- **Done when:** QA-502 passes.

### - [ ] QA-502 — Tests: scoping

- **Implements:** FR-502 acceptance
- **Depends on:** DEV-502, QA-000
- **Scope:** Tests: `paths` restricts matches to the given subtree; with index pre-filtering enabled, the ast-grep invocation receives only the candidate file list (assert on spawn arguments).
- **Done when:** tests pass.

### - [ ] REV-502 — Review: Scope control

- **Implements:** Review gate for FR-502
- **Depends on:** DEV-502, QA-502
- **Scope:** Code review agent reviews the DEV-502 implementation and QA-502 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-503 — Missing-binary handling

- **Implements:** FR-503
- **Depends on:** DEV-501
- **Scope:** When `ast-grep` is not on PATH, return a distinguishable error naming the missing prerequisite and how to install it. It is a runtime prerequisite for `search_structural` only — never a hard install dependency.
- **Done when:** QA-503 passes.

### - [ ] QA-503 — Tests: graceful degradation

- **Implements:** FR-503 / FR-500 acceptance ("with the binary absent, the error names the missing prerequisite while all other tools keep working")
- **Depends on:** DEV-503, QA-000
- **Scope:** Tests with a PATH lacking ast-grep: `search_structural` returns the named-prerequisite error; every other tool on the server still answers normally.
- **Done when:** tests pass.

### - [ ] REV-503 — Review: Missing-binary handling

- **Implements:** Review gate for FR-503
- **Depends on:** DEV-503, QA-503
- **Scope:** Code review agent reviews the DEV-503 implementation and QA-503 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

---

## M7 — Hardening & dogfood (decomposed from PRD §4 success metrics)

### - [ ] DEV-801 — End-to-end recovery drills

- **Implements:** PRD §4 robustness metric; [schema.md §Health check and recovery](schema.md#health-check-and-recovery)
- **Depends on:** DEV-604
- **Scope:** Automate full-system drills beyond QA-107's unit level: corruption discovered at server startup, foreign `user_version`, copied database (wrong `repo_root`) — each through the running MCP server, ending in a healthy rebuilt index and an `index_status` report. Fix anything the drills expose.
- **Done when:** QA-801 passes.

### - [ ] QA-801 — Tests: recovery drills in CI

- **Implements:** PRD §4 ("a corrupted or foreign database never crashes the server")
- **Depends on:** DEV-801, QA-000
- **Scope:** The three drills as automated tests: server never crashes, quarantine files exist, rebuild completes, event surfaces via `index_status`.
- **Done when:** tests pass.

### - [ ] REV-801 — Review: End-to-end recovery drills

- **Implements:** Review gate for PRD §4 robustness metric; [schema.md §Health check and recovery](schema.md#health-check-and-recovery)
- **Depends on:** DEV-801, QA-801
- **Scope:** Code review agent reviews the DEV-801 implementation and QA-801 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-802 — Limit & truncation audit

- **Implements:** FR-404/FR-603 across the full surface
- **Depends on:** DEV-604
- **Scope:** Audit every list-returning tool and query for missing caps, missing `truncated` flags, or unbounded recursion; fix gaps.
- **Done when:** QA-802 passes.

### - [ ] QA-802 — Tests: exhaustive cap conformance

- **Implements:** PRD §4 token-efficiency metric (supporting)
- **Depends on:** DEV-802, QA-000
- **Scope:** One parametrized suite enumerating **all** tools with oversized fixtures: every response bounded, every truncation flagged.
- **Done when:** tests pass.

### - [ ] REV-802 — Review: Limit & truncation audit

- **Implements:** Review gate for FR-404/FR-603 across the full surface
- **Depends on:** DEV-802, QA-802
- **Scope:** Code review agent reviews the DEV-802 implementation and QA-802 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-803 — Dogfood: self-index

- **Implements:** PRD §4 dogfood metric
- **Depends on:** DEV-704, DEV-503
- **Scope:** Index this repository with its own tool; run every [decision-matrix](search.md#decision-matrix) question against the result; fix whatever gives wrong answers.
- **Done when:** QA-803 passes.

### - [ ] QA-803 — Tests: decision-matrix answers on self

- **Implements:** PRD §4 ("the tool indexes its own repository and answers the decision-matrix questions correctly")
- **Depends on:** DEV-803, QA-000
- **Scope:** Automated test that indexes the repo itself and asserts each decision-matrix row's named tool returns a correct, non-empty answer.
- **Done when:** tests pass.

### - [ ] REV-803 — Review: Dogfood: self-index

- **Implements:** Review gate for PRD §4 dogfood metric
- **Depends on:** DEV-803, QA-803
- **Scope:** Code review agent reviews the DEV-803 implementation and QA-803 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-804 — Worked-example token budget

- **Implements:** PRD §4 token-efficiency metric; [mcp-server.md §Example agent session](mcp-server.md#example-agent-session)
- **Depends on:** DEV-803
- **Scope:** Instrument the worked rename session (`find_symbol` → `who_calls` → `get_chunk` → `reindex`) and measure total response tokens; trim response shapes if materially over the ≈400-token target.
- **Done when:** QA-804 passes.

### - [ ] QA-804 — Tests: token-budget regression guard

- **Implements:** PRD §4 ("the worked rename scenario completes in ≈400 tokens of tool responses")
- **Depends on:** DEV-804, QA-000
- **Scope:** Automated test running the session against a fixture and asserting total response size stays within the documented budget (threshold with headroom, e.g. ≤600 tokens, so it guards regressions without flaking).
- **Done when:** tests pass.

### - [ ] REV-804 — Review: Worked-example token budget

- **Implements:** Review gate for PRD §4 token-efficiency metric; [mcp-server.md §Example agent session](mcp-server.md#example-agent-session)
- **Depends on:** DEV-804, QA-804
- **Scope:** Code review agent reviews the DEV-804 implementation and QA-804 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-805 — README & doc sync

- **Implements:** M7 deliverable (PRD §7)
- **Depends on:** DEV-803
- **Scope:** Update README quick-start (install, `index`, `stats`, `serve`, `.mcp.json` registration) to match reality; reconcile any doc/spec drift discovered during implementation (flag genuine design changes rather than silently editing specs).
- **Done when:** QA-805 passes.

### - [ ] QA-805 — Tests: quick-start commands run

- **Implements:** FR-700 acceptance ("the three README quick-start commands work against a real repo")
- **Depends on:** DEV-805, QA-000
- **Scope:** Test that executes the README's documented commands verbatim against a fixture repo and asserts they succeed.
- **Done when:** tests pass.

### - [ ] REV-805 — Review: README & doc sync

- **Implements:** Review gate for M7 deliverable (PRD §7)
- **Depends on:** DEV-805, QA-805
- **Scope:** Code review agent reviews the DEV-805 implementation and QA-805 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

---

## M8 — Benchmark suite (BENCH-9xx, derived from [benchmark.md](benchmark.md); authoring can start once QA-000 exists — end-to-end with-arm runs need M5)

### - [ ] DEV-901 — Benchmark scaffolding: task registry & targets

- **Implements:** [benchmark.md §Task model](benchmark.md#task-model), [§Targets & fixtures](benchmark.md#targets--fixtures), [§Directory layout](benchmark.md#directory-layout)
- **Depends on:** QA-000
- **Scope:**
  - `benchmarks/` directory layout per the spec; `tasks.ts` typed registry: the `BenchTask` interface verbatim (`id`, `category`, `style: "qa" | "edit"`, `target`, `prompt`, `grader`, `timeoutSec`, `tags`), the six categories, load-time validation (duplicate ids, unknown target/category references rejected).
  - `targets.ts` named targets for the three classes: QA-000 fixture builders (git variant); pinned OSS repos cloned once into `benchmarks/fixtures/` at a fixed commit (path overridable via `BENCH_FIXTURES`); self at a tagged commit.
- **Done when:** QA-901 passes.

### - [ ] QA-901 — Tests: registry validation & target materialization

- **Implements:** benchmark.md §Task model acceptance (typed, validated at load)
- **Depends on:** DEV-901, QA-000
- **Scope:** Tests: the registry loads and validates; bad entries (duplicate id, unknown target, unknown category, missing grader key) are rejected at load; each target class materializes into a temp dir; `BENCH_FIXTURES` override is honored.
- **Done when:** tests pass.

### - [ ] REV-901 — Review: Benchmark scaffolding

- **Implements:** Review gate for [benchmark.md §Task model](benchmark.md#task-model), [§Targets & fixtures](benchmark.md#targets--fixtures)
- **Depends on:** DEV-901, QA-901
- **Scope:** Code review agent reviews the DEV-901 implementation and QA-901 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-902 — Deterministic graders & edit-tier checks

- **Implements:** [benchmark.md §Two tiers, two grading families](benchmark.md#two-tiers-two-grading-families), [§Grading & judges](benchmark.md#grading--judges) (rungs 1–2)
- **Depends on:** DEV-901
- **Scope:**
  - Stdlib-only, no-network matchers: exact match, set match (F1 over expected set), `path:line`-set match with ± line-slop tolerance.
  - Edit-tier grader: run a task's designated test subset in the preserved workspace; apply must-match / must-not-match diff assertions (e.g. a rename must leave no old-name reference outside comments).
  - Graders read preserved workspaces and transcripts only — re-scoring never re-runs agent sessions.
- **Done when:** QA-902 passes.

### - [ ] QA-902 — Tests: matchers & diff assertions

- **Implements:** benchmark.md §Grading & judges acceptance (deterministic-first)
- **Depends on:** DEV-902, QA-000
- **Scope:** Unit tests per matcher (exact; F1 partial credit; line-slop boundary at ± the tolerance); diff assertions catch a planted must-not-match leftover; the test-subset grader passes and fails correctly on seeded workspaces; no network access in any grader path.
- **Done when:** tests pass.

### - [ ] REV-902 — Review: Deterministic graders & edit-tier checks

- **Implements:** Review gate for [benchmark.md §Two tiers, two grading families](benchmark.md#two-tiers-two-grading-families), [§Grading & judges](benchmark.md#grading--judges)
- **Depends on:** DEV-902, QA-902
- **Scope:** Code review agent reviews the DEV-902 implementation and QA-902 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-903 — Hand-authored seed task set

- **Implements:** [benchmark.md §Task generation](benchmark.md#task-generation) (source 1), [§Example task](benchmark.md#example-task-annotated)
- **Depends on:** DEV-901, DEV-902
- **Scope:** 2–4 tasks per category per target class, answer keys derived manually; every Q&A prompt ends with an explicit answer-format instruction so grading stays mechanical; edit-tier tasks only on targets with runnable test suites; entries tagged `authored` plus size class and language.
- **Done when:** QA-903 passes.

### - [ ] QA-903 — Tests: seed set validity

- **Implements:** benchmark.md §Task generation acceptance (hand-authored seed set)
- **Depends on:** DEV-903, QA-000
- **Scope:** Tests over every seed entry: grader reference resolves; key shape matches the grader kind; Q&A prompts end with a format instruction; edit tasks reference test-runnable targets; required tags present; category coverage (each category × target class has its 2–4 tasks).
- **Done when:** tests pass.

### - [ ] REV-903 — Review: Hand-authored seed task set

- **Implements:** Review gate for [benchmark.md §Task generation](benchmark.md#task-generation) (source 1)
- **Depends on:** DEV-903, QA-903
- **Scope:** Code review agent reviews the DEV-903 implementation and QA-903 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-904 — Agent adapter: Claude Code

- **Implements:** [benchmark.md §Agent adapters](benchmark.md#agent-adapters) (Claude Code)
- **Depends on:** DEV-901
- **Scope:** `harness/adapters/claude.ts`: headless invocation via `claude -p "<prompt>" --output-format stream-json`; with-arm via `--mcp-config <bench-mcp.json> --strict-mcp-config` allowing `mcp__code-index__*`; without-arm with no MCP config, baseline tools only (tool-parity rule: the with-arm is strictly additive); `--model` pin; edit-tier permission mode workspace-scoped; extract tokens/cost/turns/tool-call metrics (MCP vs. baseline) from the stream. Flags verified against current CLI docs at implementation time; agent CLI version recorded per run.
- **Done when:** QA-904 passes.

### - [ ] QA-904 — Tests: Claude adapter extraction & arm configs

- **Implements:** benchmark.md §Metrics acceptance (Claude Code sources)
- **Depends on:** DEV-904, QA-000
- **Scope:** Metric extraction tested against recorded/stub stream-json transcripts (tokens in/out/cache, turns, tool-call counts split MCP vs. baseline); arm configuration asserted on spawn arguments (with-arm gets the MCP config, without-arm gets none); optional env-gated live smoke test against the real CLI.
- **Done when:** tests pass.

### - [ ] REV-904 — Review: Agent adapter: Claude Code

- **Implements:** Review gate for [benchmark.md §Agent adapters](benchmark.md#agent-adapters) (Claude Code)
- **Depends on:** DEV-904, QA-904
- **Scope:** Code review agent reviews the DEV-904 implementation and QA-904 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-905 — Agent adapter: Codex CLI

- **Implements:** [benchmark.md §Agent adapters](benchmark.md#agent-adapters) (Codex CLI)
- **Depends on:** DEV-901
- **Scope:** `harness/adapters/codex.ts`: headless invocation via `codex exec "<prompt>" --json` (JSONL event stream); with-arm `mcp_servers.code-index` injected via `-c` config overrides or a dedicated profile; without-arm profile with no MCP servers; `-m` model pin; sandbox mode permitting workspace writes for the edit tier; token extraction from JSONL events, cost computed from published pricing when not CLI-reported. Flags verified against current CLI docs at implementation time; agent CLI version recorded per run.
- **Done when:** QA-905 passes.

### - [ ] QA-905 — Tests: Codex adapter extraction & arm configs

- **Implements:** benchmark.md §Metrics acceptance (Codex sources)
- **Depends on:** DEV-905, QA-000
- **Scope:** Same shape as QA-904 against recorded/stub JSONL streams: token/turn/tool-call extraction, pricing-based cost fallback, arm configuration asserted on spawn arguments; optional env-gated live smoke test.
- **Done when:** tests pass.

### - [ ] REV-905 — Review: Agent adapter: Codex CLI

- **Implements:** Review gate for [benchmark.md §Agent adapters](benchmark.md#agent-adapters) (Codex CLI)
- **Depends on:** DEV-905, QA-905
- **Scope:** Code review agent reviews the DEV-905 implementation and QA-905 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-906 — Harness orchestrator: `bench run`

- **Implements:** [benchmark.md §Harness](benchmark.md#harness), [§Metrics](benchmark.md#metrics), [§Results & reporting](benchmark.md#results--reporting) (record shape)
- **Depends on:** DEV-902, DEV-903, DEV-904, DEV-905 (end-to-end with-arm runs also need DEV-704)
- **Scope:**
  - `harness/run.ts`: `bench run --task <ids|category|all> --arms <arms> --runs 4 --workers 4` (N configurable).
  - Per (task, arm, run): materialize a fresh workspace copy of the pinned target in a temp dir → with-arm only: build the index (`code-index index .`), build time recorded separately and excluded from agent metrics → invoke the agent adapter with per-arm config and timeout → capture transcript + CLI-reported usage → grade → append one record (versions, metrics, score, grader, flags, workspace path per the spec's record shape) to append-only `results/runs.jsonl` → preserve the workspace under `results/runs/<timestamp>/`.
  - Timeout and agent-error flags; isolation invariant: no run ever sees another run's residue.
- **Done when:** QA-906 passes.

### - [ ] QA-906 — Tests: run loop, isolation & record shape

- **Implements:** benchmark.md §Harness acceptance (per-run flow, isolation, preserved workspaces)
- **Depends on:** DEV-906, QA-000
- **Scope:** Tests with a scripted fake adapter: a run's JSONL record contains every documented field; each run gets a fresh workspace, preserved afterward; `index_build_s` recorded on with-arm runs and no index build occurs on without-arm runs; a timed-out run produces a flagged record; records append (never rewrite) across an interrupted-and-resumed suite.
- **Done when:** tests pass.

### - [ ] REV-906 — Review: Harness orchestrator

- **Implements:** Review gate for [benchmark.md §Harness](benchmark.md#harness), [§Metrics](benchmark.md#metrics)
- **Depends on:** DEV-906, QA-906
- **Scope:** Code review agent reviews the DEV-906 implementation and QA-906 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-907 — LLM judge

- **Implements:** [benchmark.md §Grading & judges](benchmark.md#grading--judges) (rung 3)
- **Depends on:** DEV-901, DEV-902
- **Scope:** `benchmarks/judge/`: a separate auditable script; fixed model, temperature 0, per-task rubric; input is the answer key and the agent's final answer **only — never the transcript**; used solely for free-form architecture-comprehension tasks (always the lowest grader rung that can decide a task); `--selftest` fixtures (known-good and known-bad answers that must score correctly); judge cost tracked separately from agent cost.
- **Done when:** QA-907 passes.

### - [ ] QA-907 — Tests: judge self-test & input isolation

- **Implements:** benchmark.md §Grading & judges acceptance (self-testing judges)
- **Depends on:** DEV-907, QA-000
- **Scope:** Tests: `--selftest` passes (known-good answers score high, known-bad score low); the constructed judge input provably excludes transcript content; tasks with deterministic graders never route to the judge.
- **Done when:** tests pass.

### - [ ] REV-907 — Review: LLM judge

- **Implements:** Review gate for [benchmark.md §Grading & judges](benchmark.md#grading--judges) (rung 3)
- **Depends on:** DEV-907, QA-907
- **Scope:** Code review agent reviews the DEV-907 implementation and QA-907 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-908 — Index-driven task generator

- **Implements:** [benchmark.md §Task generation](benchmark.md#task-generation) (source 2 + circularity mitigations)
- **Depends on:** DEV-901, DEV-701, DEV-304
- **Scope:**
  - `generate-tasks.ts`: run `code-index index` on a target, then query `.code-index/index.db` directly — symbols with 2+ resolved callers → who-calls tasks (key = caller list from `edges`); transitive closure over `calls` edges → impact tasks; `imports` edges → architecture/module-relationship tasks; exported symbols → symbol-lookup tasks.
  - Generated entries tagged `generated:<generator-version>` with keys inline, landing in the same registry structure as authored ones.
  - Grep cross-check spot-validation helper for caller-list keys (circularity mitigation; generated tasks never certify index correctness).
- **Done when:** QA-908 passes.

### - [ ] QA-908 — Tests: generated tasks & key cross-check

- **Implements:** benchmark.md §Task generation acceptance (generated entries, spot validation)
- **Depends on:** DEV-908, QA-000
- **Scope:** Tests on the QA-000 fixture: the generator emits tasks of each shape whose keys match direct SQL against the index; the grep cross-check agrees on a sample of caller-list keys; `generated:<version>` tags present; generated entries pass DEV-901's registry validation.
- **Done when:** tests pass.

### - [ ] REV-908 — Review: Index-driven task generator

- **Implements:** Review gate for [benchmark.md §Task generation](benchmark.md#task-generation) (source 2)
- **Depends on:** DEV-908, QA-908
- **Scope:** Code review agent reviews the DEV-908 implementation and QA-908 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

### - [ ] DEV-909 — Reporting: `bench report`

- **Implements:** [benchmark.md §Results & reporting](benchmark.md#results--reporting)
- **Depends on:** DEV-906
- **Scope:**
  - `bench report` reads `results/runs.jsonl` and emits dated markdown (`results/YYYY-MM-DD-<name>.md`): per-category × per-arm median tables (tokens, cost, wall-clock, tool calls, correctness); per-agent with/without token ratio and correctness delta as the headline figures; win/loss/tie counts per task pair; index build time shown alongside, never netted out silently.
  - Gitignore everything under `results/` except committed reports.
- **Done when:** QA-909 passes.

### - [ ] QA-909 — Tests: report correctness

- **Implements:** benchmark.md §Results & reporting acceptance
- **Depends on:** DEV-909, QA-000
- **Scope:** Tests from a synthetic fixture `runs.jsonl`: report medians, with/without ratios, and win/loss/tie counts match hand-computed values; index build time appears in the report; gitignore rules keep `runs.jsonl` and workspaces untracked while reports remain committable.
- **Done when:** tests pass.

### - [ ] REV-909 — Review: Reporting

- **Implements:** Review gate for [benchmark.md §Results & reporting](benchmark.md#results--reporting)
- **Depends on:** DEV-909, QA-909
- **Scope:** Code review agent reviews the DEV-909 implementation and QA-909 tests against the linked spec sections: implementation matches the spec and stays within task scope; tests genuinely encode the acceptance criteria (not weakened to pass); no unrelated changes. Approve, or return findings for rework.
- **Done when:** review approved with no unresolved findings.

---

## Dependency notes

- **Critical path:** DEV-000 → storage (M1) → pipeline (M2) → graph (M3) → queries (M4) → server (M5) → hardening (M7).
- **M6 branch:** structural search depends only on DEV-601 (server shell), not on the index — it can proceed in parallel with M3/M4 work (PRD §7 note); its tool registration slots into DEV-602's catalog when that lands.
- **REV tasks** are review gates layered on the existing graph — they never appear in other tasks' "Depends on" lists, but a milestone is complete only when all its REV tasks are approved.
- **QA-000 fixtures** are shared infrastructure: every QA task depends on it; extend the fixture repos there (not ad-hoc per test) so golden rows stay consistent.
- **Cross-cutting risks to watch** (PRD §8): pin `tree-sitter`/`better-sqlite3` versions at DEV-000 and verify native builds early; cover both `typescript` and `tsx` grammars in every M3 fixture; pin a minimum `ast-grep` version at DEV-501.
- **M8 branch** ([benchmark.md](benchmark.md)): benchmark authoring (DEV-901–905, DEV-907) needs only QA-000; end-to-end `bench run` with-arms need M5 (DEV-704); the task generator (DEV-908) needs the M2 CLI (DEV-701) and M3 resolution (DEV-304). Benchmark runs are manual and deliberate — never CI-scheduled (benchmark.md §Non-goals).
