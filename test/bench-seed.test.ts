import { describe, expect, it } from "vitest";
import { CATEGORIES, Category, validateTasks } from "../benchmarks/tasks";
import { SEED_TASKS } from "../benchmarks/seed-tasks";
import { TARGETS } from "../benchmarks/targets";

/**
 * QA-903: validity of the hand-authored seed set. Structural — never runs
 * agents or executes graders (that is the harness's job); it checks that
 * every entry is well-formed, format-instructed, correctly tiered, tagged,
 * and that every (category × target class) cell carries its 2–4 tasks.
 */

const SIZE_CLASSES = new Set(["small", "medium", "large"]);
const LANGUAGES = new Set(["js", "ts", "tsx", "mixed"]);
const PATH_LINE = /^.+:\d+$/;

function targetClassOf(target: string): string {
  return TARGETS[target].class;
}

describe("hand-authored seed task set (DEV-903 / QA-903)", () => {
  it("the whole seed set passes registry validation", () => {
    expect(() => validateTasks(SEED_TASKS)).not.toThrow();
    expect(SEED_TASKS.length).toBeGreaterThanOrEqual(CATEGORIES.length * 3 * 2);
  });

  it("every grader reference resolves and its key shape matches its kind", () => {
    for (const task of SEED_TASKS) {
      const g = task.grader;
      switch (g.kind) {
        case "exact":
          expect(typeof g.key, task.id).toBe("string");
          expect(g.key.length, task.id).toBeGreaterThan(0);
          break;
        case "set":
          expect(Array.isArray(g.key), task.id).toBe(true);
          expect(g.key.length, task.id).toBeGreaterThan(0);
          break;
        case "path-line-set":
          expect(g.key.length, task.id).toBeGreaterThan(0);
          for (const entry of g.key) expect(entry, `${task.id}: ${entry}`).toMatch(PATH_LINE);
          break;
        case "test-diff":
          expect(g.testCommand.length, task.id).toBeGreaterThan(0);
          expect(Array.isArray(g.mustMatch) && Array.isArray(g.mustNotMatch), task.id).toBe(true);
          break;
        case "judge":
          expect(g.rubric.length, task.id).toBeGreaterThan(0);
          expect(g.key.length, task.id).toBeGreaterThan(0);
          break;
        default:
          throw new Error(`${task.id}: unknown grader kind`);
      }
    }
  });

  it("every Q&A prompt ends with an explicit answer-format instruction", () => {
    for (const task of SEED_TASKS.filter((t) => t.style === "qa")) {
      expect(task.prompt.trim(), task.id).toMatch(/Answer (only with|with|in|exactly)\b[^.]*\.$/);
    }
  });

  it("edit tasks use the test-diff grader and target a test-runnable repo", () => {
    for (const task of SEED_TASKS.filter((t) => t.style === "edit")) {
      expect(task.grader.kind, task.id).toBe("test-diff");
      expect(TARGETS[task.target].testRunnable, task.id).toBe(true);
    }
  });

  it("every entry carries the required tags: authored + size class + language", () => {
    for (const task of SEED_TASKS) {
      expect(task.tags, task.id).toContain("authored");
      expect(task.tags.some((t) => SIZE_CLASSES.has(t)), `${task.id} size`).toBe(true);
      expect(task.tags.some((t) => LANGUAGES.has(t)), `${task.id} language`).toBe(true);
    }
  });

  it("category coverage: each (category × target class) has 2–4 tasks", () => {
    const classes = ["fixture", "oss", "self"];
    for (const category of CATEGORIES) {
      for (const cls of classes) {
        const n = SEED_TASKS.filter(
          (t) => t.category === category && targetClassOf(t.target) === cls,
        ).length;
        expect(n, `${category} × ${cls}`).toBeGreaterThanOrEqual(2);
        expect(n, `${category} × ${cls}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it("task ids are unique and every category is exercised", () => {
    expect(new Set(SEED_TASKS.map((t) => t.id)).size).toBe(SEED_TASKS.length);
    const used = new Set<Category>(SEED_TASKS.map((t) => t.category));
    for (const category of CATEGORIES) expect(used.has(category), category).toBe(true);
  });
});
