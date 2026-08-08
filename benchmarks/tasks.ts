import { TARGETS } from "./targets";

/**
 * Benchmark task registry (benchmark.md#task-model). Tasks live in code, not
 * loose spec files: typed, validated at load, mixing hand-authored entries
 * (DEV-903, tagged "authored") with generated ones (DEV-908, tagged
 * "generated:<version>").
 */

/** The six categories (benchmark.md#task-model), one per indexed capability. */
export const CATEGORIES = [
  "symbol-lookup",
  "callers-impact",
  "bug-localization",
  "architecture",
  "cross-file-navigation",
  "rename-refactor",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Deterministic Q&A graders (DEV-902 implements the matchers). */
export interface ExactGrader {
  kind: "exact";
  key: string;
}
export interface SetGrader {
  kind: "set";
  key: string[];
}
export interface PathLineSetGrader {
  kind: "path-line-set";
  key: string[]; // "path:line" entries
  /** ± line tolerance; default 2. */
  lineSlop?: number;
}
/** Edit-tier grader: designated test subset + diff assertions. */
export interface TestDiffGrader {
  kind: "test-diff";
  /** Command run in the preserved workspace; exit 0 = tests pass. */
  testCommand: string[];
  /** Regex sources that MUST appear in the workspace diff. */
  mustMatch: string[];
  /** Regex sources that MUST NOT appear in the workspace diff. */
  mustNotMatch: string[];
}
/** LLM-judge fallback (DEV-907) — free-form architecture answers only. */
export interface JudgeGrader {
  kind: "judge";
  /** Per-task rubric shown to the judge with the key and the answer. */
  rubric: string;
  key: string;
}

export type GraderRef = ExactGrader | SetGrader | PathLineSetGrader | TestDiffGrader | JudgeGrader;

/** benchmark.md#task-model, verbatim. */
export interface BenchTask {
  id: string;
  category: Category;
  style: "qa" | "edit";
  target: string;
  prompt: string;
  grader: GraderRef;
  timeoutSec: number;
  tags: string[];
}

export class TaskValidationError extends Error {}

/**
 * FR-803: task prompts must be tool-agnostic — they may not name a retrieval
 * mechanism, so no arm is steered toward the index. Forbidden classes:
 *   - the 11 MCP tool names (from the server catalog), incl. `reindex`;
 *   - "MCP";
 *   - "code-index" / "code index";
 *   - "index"-as-mechanism phrasing: "the index", "indexed".
 *
 * False-positive boundary (deliberately NOT flagged): the bare word "index" is
 * allowed, so legitimate prompt vocabulary survives — the repo's own
 * `src/index.ts` path, the product's "indexing pipeline" / "index command"
 * domain terms, and unrelated words like "indexOf" and "indentation". The rule
 * targets mechanism phrases and tool names, never the bare "index" substring.
 * Word-boundary, case-insensitive.
 */
const TOOL_NAMES = [
  "index_status",
  "module_map",
  "file_outline",
  "find_symbol",
  "who_calls",
  "impact_of_change",
  "get_dependencies",
  "search_code",
  "search_structural",
  "get_chunk",
  "reindex",
] as const;

const FORBIDDEN_PROMPT_PATTERNS: RegExp[] = [
  new RegExp(`\\b(${TOOL_NAMES.join("|")})\\b`, "i"),
  /\bMCP\b/i,
  /\bcode[- ]index\b/i,
  /\bthe\s+index\b/i,
  /\bindexed\b/i,
];

function forbiddenPromptMention(prompt: string): string | null {
  for (const re of FORBIDDEN_PROMPT_PATTERNS) {
    const m = prompt.match(re);
    if (m) return m[0];
  }
  return null;
}

function graderKeyMissing(grader: GraderRef): boolean {
  switch (grader.kind) {
    case "exact":
      return grader.key.length === 0;
    case "set":
    case "path-line-set":
      return grader.key.length === 0;
    case "test-diff":
      return grader.testCommand.length === 0;
    case "judge":
      return grader.rubric.length === 0 || grader.key.length === 0;
  }
}

/**
 * Load-time validation (benchmark.md: "typed, validated at load"). Rejects
 * duplicate ids, unknown target/category references, and missing grader keys.
 */
export function validateTasks(tasks: BenchTask[], targetNames: string[] = Object.keys(TARGETS)): void {
  const seen = new Set<string>();
  const targets = new Set(targetNames);
  const categories = new Set<string>(CATEGORIES);
  for (const task of tasks) {
    if (seen.has(task.id)) throw new TaskValidationError(`duplicate task id: ${task.id}`);
    seen.add(task.id);
    if (!targets.has(task.target)) {
      throw new TaskValidationError(`task ${task.id}: unknown target ${task.target}`);
    }
    if (!categories.has(task.category)) {
      throw new TaskValidationError(`task ${task.id}: unknown category ${task.category}`);
    }
    if (graderKeyMissing(task.grader)) {
      throw new TaskValidationError(`task ${task.id}: grader ${task.grader.kind} is missing its key`);
    }
    if (task.style === "edit" && task.grader.kind !== "test-diff") {
      throw new TaskValidationError(`task ${task.id}: edit tasks require the test-diff grader`);
    }
    if (task.style === "qa" && task.grader.kind === "test-diff") {
      throw new TaskValidationError(`task ${task.id}: qa tasks cannot use the test-diff grader`);
    }
    if (!Number.isInteger(task.timeoutSec) || task.timeoutSec <= 0) {
      throw new TaskValidationError(`task ${task.id}: timeoutSec must be a positive integer`);
    }
    const mention = forbiddenPromptMention(task.prompt);
    if (mention !== null) {
      throw new TaskValidationError(
        `task ${task.id}: prompt names a retrieval mechanism (${mention}) — prompts must be tool-agnostic`,
      );
    }
  }
}

/** Hand-authored seed set (DEV-903) + generated entries (DEV-908 / SK-D12). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SEED_TASKS } from "./seed-tasks";

/**
 * Generated-task filter (SK-D12, FR-802). Index-driven generated tasks are
 * EXCLUDED from `TASKS` by default and included ONLY when the filter is engaged
 * via the env var `BENCH_INCLUDE_GENERATED=v1`.
 *
 * Why an env var (the smallest mechanism consistent with `resolveTasks`): the
 * harness's `--task` selector filters an already-assembled `TASKS`; it never
 * decides membership. Membership is decided here, once, at registry load — an
 * env flag keeps that decision in one place with no new selector grammar and no
 * change to `run.ts`. Default-off is airtight: with the var unset (or any value
 * other than "v1"), the generated set is never read, so no run can silently pick
 * up generated tasks.
 *
 * NO import-time DB/index work: generated tasks are read from a checked-in JSON
 * snapshot (`generated-tasks.v1.json`, produced by `npm run bench:generate`).
 * The snapshot is a plain file read — importing this module never builds an
 * index (that would break `npm test`).
 */
export const GENERATED_TASK_SET_VERSION = "v1";
const GENERATED_SNAPSHOT_PATH = resolve(__dirname, `generated-tasks.${GENERATED_TASK_SET_VERSION}.json`);

function loadGeneratedTasks(): BenchTask[] {
  if (process.env.BENCH_INCLUDE_GENERATED !== GENERATED_TASK_SET_VERSION) return [];
  return JSON.parse(readFileSync(GENERATED_SNAPSHOT_PATH, "utf8")) as BenchTask[];
}

export const TASKS: BenchTask[] = [...SEED_TASKS, ...loadGeneratedTasks()];

// Validated at load: importing a broken registry is an immediate error. This
// also enforces id-uniqueness across authored + generated (generated ids are
// `gen-*`-prefixed and so never collide with the authored `<cat>-<target>-*`
// scheme, but the duplicate-id check is the load-time guard either way).
validateTasks(TASKS);
