import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { validateTasks, type BenchTask, type Category } from "./tasks";
import { TARGETS } from "./targets";

/**
 * Index-driven task generator (benchmark.md#task-generation source 2):
 * dogfood the tool to scale task count. Runs against a built index
 * (.code-index/index.db) and derives tasks whose keys come from direct SQL:
 *   - exported symbols            -> symbol-lookup tasks
 *   - symbols with 2+ callers     -> who-calls tasks (key = caller list)
 *   - transitive calls closure    -> impact tasks
 *   - imports edges               -> architecture/module-relationship tasks
 *
 * CIRCULARITY (benchmark.md, addressed head-on): the generator's ground truth
 * IS the index, and the with-arm queries that same index. This is neutral for
 * the with-vs-without comparison (both arms graded against the same key), but
 * generated keys are spot-validated independently (grepCrossCheckCallers) and
 * generated tasks NEVER certify index correctness — that is the QA suite's job.
 */

export const GENERATOR_VERSION = "v1";

interface SymbolRow {
  id: number;
  name: string;
  path: string;
  start_line: number;
  language: string;
}

function sizeClass(targetName: string): string {
  return TARGETS[targetName]?.class === "fixture" ? "small" : "medium";
}

function langTag(language: string): string {
  return language === "javascript" ? "js" : language === "tsx" ? "tsx" : "ts";
}

function generatedTags(targetName: string, language: string): string[] {
  return [`generated:${GENERATOR_VERSION}`, sizeClass(targetName), langTag(language)];
}

/** Exported symbols with a repo-unique name -> "Where is X defined?" */
export function generateSymbolLookupTasks(db: Database, targetName: string): BenchTask[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, f.relative_path AS path, s.start_line, f.language
       FROM symbols s JOIN indexed_files f ON f.id = s.file_id
       WHERE s.exported = 1
         AND (SELECT COUNT(*) FROM symbols s2 WHERE s2.name = s.name) = 1
       ORDER BY f.relative_path, s.start_line`,
    )
    .all() as SymbolRow[];
  return rows.map((r) => ({
    id: `gen-symlookup-${targetName}-${r.name}`,
    category: "symbol-lookup" as Category,
    style: "qa" as const,
    target: targetName,
    prompt: `Where is \`${r.name}\` defined? Answer with a single line as path:line.`,
    grader: { kind: "path-line-set" as const, key: [`${r.path}:${r.start_line}`] },
    timeoutSec: 300,
    tags: generatedTags(targetName, r.language),
  }));
}

/** Symbols with 2+ resolved callers -> "List every call site of X." */
export function generateWhoCallsTasks(db: Database, targetName: string): BenchTask[] {
  const candidates = db
    .prepare(
      `SELECT s.id, s.name, f.relative_path AS path, s.start_line, f.language
       FROM symbols s JOIN indexed_files f ON f.id = s.file_id
       WHERE (SELECT COUNT(*) FROM edges e
              WHERE e.target_symbol_id = s.id AND e.edge_type IN ('calls','references')) >= 2
         AND (SELECT COUNT(*) FROM symbols s2 WHERE s2.name = s.name) = 1
       ORDER BY f.relative_path, s.start_line`,
    )
    .all() as SymbolRow[];
  const callerStmt = db.prepare(
    `SELECT f.relative_path AS path, e.line
     FROM edges e JOIN indexed_files f ON f.id = e.source_file_id
     WHERE e.target_symbol_id = ? AND e.edge_type IN ('calls','references')
     ORDER BY f.relative_path, e.line`,
  );
  return candidates.map((r) => {
    const callers = callerStmt.all(r.id) as { path: string; line: number }[];
    return {
      id: `gen-whocalls-${targetName}-${r.name}`,
      category: "callers-impact" as Category,
      style: "qa" as const,
      target: targetName,
      prompt: `List every call site of \`${r.name}\`, as path:line, one per line. Answer only with the list.`,
      grader: { kind: "path-line-set" as const, key: callers.map((c) => `${c.path}:${c.line}`) },
      timeoutSec: 300,
      tags: generatedTags(targetName, r.language),
    };
  });
}

/** Transitive inbound calls/references closure -> impact tasks (name set). */
export function generateImpactTasks(db: Database, targetName: string): BenchTask[] {
  const seeds = db
    .prepare(
      `SELECT s.id, s.name, f.relative_path AS path, s.start_line, f.language
       FROM symbols s JOIN indexed_files f ON f.id = s.file_id
       WHERE (SELECT COUNT(*) FROM edges e
              WHERE e.target_symbol_id = s.id AND e.edge_type IN ('calls','references','extends','implements')) >= 1
         AND (SELECT COUNT(*) FROM symbols s2 WHERE s2.name = s.name) = 1
       ORDER BY f.relative_path, s.start_line`,
    )
    .all() as SymbolRow[];
  const closureStmt = db.prepare(
    `WITH RECURSIVE impact(id) AS (
       SELECT ?
       UNION
       SELECT e.source_symbol_id FROM edges e JOIN impact ON e.target_symbol_id = impact.id
       WHERE e.source_symbol_id IS NOT NULL
         AND e.edge_type IN ('calls','references','extends','implements')
     )
     SELECT DISTINCT s.name FROM impact JOIN symbols s ON s.id = impact.id
     WHERE impact.id != ? ORDER BY s.name`,
  );
  const tasks: BenchTask[] = [];
  for (const r of seeds) {
    const affected = (closureStmt.all(r.id, r.id) as { name: string }[]).map((x) => x.name);
    if (affected.length === 0) continue;
    tasks.push({
      id: `gen-impact-${targetName}-${r.name}`,
      category: "callers-impact",
      style: "qa",
      target: targetName,
      prompt: `If \`${r.name}\` changes, which symbols are transitively affected? List their names, one per line. Answer only with the list.`,
      grader: { kind: "set", key: affected },
      timeoutSec: 300,
      tags: generatedTags(targetName, r.language),
    });
  }
  return tasks;
}

/** imports edges grouped by file -> "What does F import?" (module set). */
export function generateArchitectureTasks(db: Database, targetName: string): BenchTask[] {
  const files = db
    .prepare(
      `SELECT DISTINCT f.relative_path AS path, f.language
       FROM edges e JOIN indexed_files f ON f.id = e.source_file_id
       WHERE e.edge_type = 'imports' AND e.target_module IS NOT NULL
       ORDER BY f.relative_path`,
    )
    .all() as { path: string; language: string }[];
  const importsStmt = db.prepare(
    `SELECT DISTINCT e.target_module AS mod
     FROM edges e JOIN indexed_files f ON f.id = e.source_file_id
     WHERE e.edge_type = 'imports' AND e.target_module IS NOT NULL AND f.relative_path = ?
     ORDER BY e.target_module`,
  );
  return files.map((f) => {
    const modules = (importsStmt.all(f.path) as { mod: string }[]).map((m) => m.mod);
    // A path hash suffix keeps ids collision-proof (two paths can sanitize
    // to the same slug, e.g. a/b.ts and a-b.ts).
    const slug = `${f.path.replace(/[^a-zA-Z0-9]/g, "_")}-${createHash("sha1").update(f.path).digest("hex").slice(0, 8)}`;
    return {
      id: `gen-arch-${targetName}-${slug}`,
      category: "architecture" as Category,
      style: "qa" as const,
      target: targetName,
      prompt: `List every module imported by ${f.path}, as the import specifier string exactly as written, one per line. Answer only with the list.`,
      grader: { kind: "set" as const, key: modules },
      timeoutSec: 300,
      tags: generatedTags(targetName, f.language),
    };
  });
}

/** All generated tasks for one built index. */
export function generateTasks(db: Database, targetName: string): BenchTask[] {
  return [
    ...generateSymbolLookupTasks(db, targetName),
    ...generateWhoCallsTasks(db, targetName),
    ...generateImpactTasks(db, targetName),
    ...generateArchitectureTasks(db, targetName),
  ];
}

/**
 * Circularity mitigation (benchmark.md): independently confirm index-derived
 * caller keys by grepping the working tree for `name(` call sites. Returns
 * the path:line set grep finds (grep-grade, so a superset of resolved calls).
 * A generated who-calls key is trustworthy when every entry it claims is also
 * found here.
 */
export function grepCrossCheckCallers(repoRoot: string, name: string): string[] {
  let out = "";
  try {
    // -n line numbers, -w whole word, then filter to call sites (`name(`).
    out = execFileSync("git", ["grep", "-n", "-w", name], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return []; // git grep exits 1 on no matches
  }
  const callPattern = new RegExp(`\\b${name}\\s*\\(`);
  const hits: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (m && callPattern.test(m[3])) hits.push(`${m[1]}:${m[2]}`);
  }
  return hits;
}

// ── Generate-and-cache: snapshot produced by `npm run bench:generate` ─────────
//
// SK-D12 (FR-802). The registry must NOT build an index at import time — that
// would break `npm test`. So generation is an explicit, offline step: this
// script materializes the target, builds the index via the shipped CLI (no
// import of `src/` pipeline modules — the benchmarks→src boundary permits only
// `src/storage/meta`), reads the resulting `.code-index/index.db` with a raw
// better-sqlite3 handle, derives tasks, validates them, and writes a checked-in
// JSON snapshot. `tasks.ts` then loads that snapshot (a plain file read) behind
// the `BENCH_INCLUDE_GENERATED=v1` filter — never a live index build.

/** Snapshot scope: initially oss-zod only (SK-D12). */
export const GENERATED_TARGETS = ["oss-zod"] as const;

/** Checked-in snapshot the registry loads when the filter is engaged. */
export const GENERATED_SNAPSHOT_PATH = resolve(__dirname, `generated-tasks.${GENERATOR_VERSION}.json`);

const CODE_INDEX_BIN = resolve(__dirname, "..", "dist", "cli.js");

/**
 * Deterministic ordering of a task set: sort by id. `generateTasks` already
 * emits rows in a stable SQL `ORDER BY`, but a final id sort makes the snapshot
 * byte-stable regardless of generator-function call order, so the `task_set`
 * hash is reproducible across regenerations of the same target checkout.
 */
function sortTasks(tasks: BenchTask[]): BenchTask[] {
  return [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Generate the task set for one target checkout: materialize a fresh copy,
 * build its index with the shipped CLI, and derive tasks from the DB. Returns
 * the id-sorted, validated task list. Any generated prompt that would trip
 * `validateTasks` (e.g. a target symbol literally named like an MCP tool) is
 * dropped up front so the snapshot always validates.
 */
export function generateSnapshotForTarget(targetName: string): BenchTask[] {
  if (!existsSync(CODE_INDEX_BIN)) {
    throw new Error(`code-index build not found at ${CODE_INDEX_BIN} — run \`npm run build\` first`);
  }
  const target = TARGETS[targetName];
  if (!target) throw new Error(`unknown target: ${targetName}`);
  target.ensureCache();
  const ws = target.materialize();
  try {
    execFileSync(process.execPath, [CODE_INDEX_BIN, "index", "."], {
      cwd: ws.dir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const db = new BetterSqlite3(join(ws.dir, ".code-index", "index.db"), { readonly: true });
    try {
      const tasks = sortTasks(generateTasks(db, targetName));
      // Drop any task whose prompt would fail the tool-agnostic rule (SK-D10),
      // so the checked-in snapshot always validates cleanly.
      const clean = tasks.filter((t) => {
        try {
          validateTasks([t], [targetName]);
          return true;
        } catch {
          return false;
        }
      });
      validateTasks(clean, [targetName]);
      return clean;
    } finally {
      db.close();
    }
  } finally {
    ws.cleanup();
  }
}

/** Regenerate the checked-in snapshot for every in-scope target and write it. */
export function writeGeneratedSnapshot(): { path: string; count: number } {
  const all: BenchTask[] = [];
  for (const targetName of GENERATED_TARGETS) {
    all.push(...generateSnapshotForTarget(targetName));
  }
  const tasks = sortTasks(all);
  // Trailing newline + 2-space indent keep the checked-in file diff-friendly.
  writeFileSync(GENERATED_SNAPSHOT_PATH, `${JSON.stringify(tasks, null, 2)}\n`);
  return { path: GENERATED_SNAPSHOT_PATH, count: tasks.length };
}

if (require.main === module) {
  try {
    const { path, count } = writeGeneratedSnapshot();
    process.stdout.write(`bench:generate wrote ${count} generated tasks -> ${path}\n`);
  } catch (error) {
    process.stderr.write(`bench:generate: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
