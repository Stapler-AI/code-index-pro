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
  }
}

/** Hand-authored seed set (DEV-903) + generated entries (DEV-908). */
import { SEED_TASKS } from "./seed-tasks";

export const TASKS: BenchTask[] = [...SEED_TASKS];

// Validated at load: importing a broken registry is an immediate error.
validateTasks(TASKS);
