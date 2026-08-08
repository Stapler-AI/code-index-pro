import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORIES, Category, validateTasks } from "../benchmarks/tasks";
import { SEED_TASKS } from "../benchmarks/seed-tasks";
import { fixturesDir, SELF_TAG, TARGETS } from "../benchmarks/targets";

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

/**
 * SK-Q11 (FR-801): the SK-D11 structure-heavy expansion. Proves the deepened
 * multi-hop coverage on the two realistic targets — each structure-heavy
 * category (callers-impact, cross-file-navigation, rename-refactor) carries
 * ≥ 2 authored tasks on both oss-zod and self — and mechanically spot-checks a
 * sample of the new grader keys against the pinned target checkouts where the
 * cache/tag is available (skip-guarded otherwise, like the target suite).
 */
describe("structure-heavy seed expansion (SK-D11 / SK-Q11, FR-801)", () => {
  const STRUCTURE_HEAVY = ["callers-impact", "cross-file-navigation", "rename-refactor"] as const;
  const REALISTIC_TARGETS = ["oss-zod", "self"] as const;

  it("each structure-heavy category × {oss-zod, self} has ≥ 2 authored tasks", () => {
    for (const category of STRUCTURE_HEAVY) {
      for (const target of REALISTIC_TARGETS) {
        const authored = SEED_TASKS.filter(
          (t) => t.category === category && t.target === target && t.tags.includes("authored"),
        );
        expect(authored.length, `${category} × ${target}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  // The new ids ship with these targets; pin their exact presence so a rename or
  // accidental drop is caught, and use them as the spot-check sample below.
  const NEW_IDS = [
    "ci-zod-zodparsedtype-importers-001",
    "ci-self-openhealthy-callers-001",
    "cf-zod-geterrormap-default-001",
    "cf-self-hooks-resolveedges-001",
    "cf-self-cli-to-evaluatefile-001",
    "rr-zod-geterrormap-001",
    "rr-self-discoverfiles-001",
  ] as const;

  it("every SK-D11 id is present, well-formed, authored, and validates", () => {
    // Registry validation (incl. SK-D10's tool-agnostic prompt rule) over just
    // the new tasks — a targeted failing-before / passing-after signal for D11.
    const newTasks = NEW_IDS.map((id) => {
      const t = SEED_TASKS.find((task) => task.id === id);
      expect(t, `${id} present`).toBeDefined();
      return t!;
    });
    expect(() => validateTasks(newTasks)).not.toThrow();
    // Id convention: <category-prefix>-<target>-<slug>-NNN, lower-kebab + 3 digits.
    for (const t of newTasks) {
      expect(t.id, t.id).toMatch(/^[a-z]{2}-(zod|self)-[a-z0-9-]+-\d{3}$/);
      expect(t.tags, t.id).toContain("authored");
      expect(STRUCTURE_HEAVY.includes(t.category as (typeof STRUCTURE_HEAVY)[number]), t.id).toBe(true);
    }
  });

  it("the two SK-D11 rename tasks use test-diff graders with non-empty mustMatch/mustNotMatch", () => {
    for (const id of ["rr-zod-geterrormap-001", "rr-self-discoverfiles-001"]) {
      const t = SEED_TASKS.find((task) => task.id === id)!;
      expect(t.style, id).toBe("edit");
      expect(t.grader.kind, id).toBe("test-diff");
      if (t.grader.kind !== "test-diff") throw new Error(`${id}: expected test-diff grader`);
      expect(t.grader.mustMatch.length, `${id} mustMatch`).toBeGreaterThan(0);
      expect(t.grader.mustNotMatch.length, `${id} mustNotMatch`).toBeGreaterThan(0);
    }
  });

  // ── Mechanical key spot-checks against the pinned targets (skip-guarded) ────
  // Keys are ground truth; verify the path half of a sample of new path-line-set
  // keys resolves in the pinned checkout. Guarded on target availability so a
  // missing zod cache / self tag skips rather than fails (target-suite pattern).

  const zodCache = join(fixturesDir(), "zod");
  const zodAvailable = existsSync(join(zodCache, "package.json"));

  it.runIf(zodAvailable)(
    "oss-zod new keys point at files that exist in the pinned checkout",
    () => {
      // ci-zod-zodparsedtype-importers: every importer path resolves.
      const ci = SEED_TASKS.find((t) => t.id === "ci-zod-zodparsedtype-importers-001")!;
      if (ci.grader.kind !== "set") throw new Error("expected set grader");
      for (const rel of ci.grader.key) {
        expect(existsSync(join(zodCache, rel)), rel).toBe(true);
      }
      // cf-zod-geterrormap-default: the path half of the path:line key resolves.
      const cf = SEED_TASKS.find((t) => t.id === "cf-zod-geterrormap-default-001")!;
      if (cf.grader.kind !== "path-line-set") throw new Error("expected path-line-set grader");
      for (const entry of cf.grader.key) {
        const [rel] = entry.split(":");
        expect(existsSync(join(zodCache, rel)), entry).toBe(true);
      }
    },
  );

  const selfTagPresent = (() => {
    try {
      execFileSync("git", ["rev-parse", "--verify", "-q", `refs/tags/${SELF_TAG}`], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(selfTagPresent)("self new path:line keys point at files present at the pinned tag", () => {
    const selfPathTasks = ["ci-self-openhealthy-callers-001", "cf-self-hooks-resolveedges-001", "cf-self-cli-to-evaluatefile-001"];
    for (const id of selfPathTasks) {
      const t = SEED_TASKS.find((task) => task.id === id)!;
      if (t.grader.kind !== "path-line-set") throw new Error(`${id}: expected path-line-set grader`);
      for (const entry of t.grader.key) {
        const [rel] = entry.split(":");
        // `git cat-file -e <tag>:<path>` exits non-zero if the blob is absent.
        expect(() =>
          execFileSync("git", ["cat-file", "-e", `${SELF_TAG}:${rel}`], { stdio: "pipe" }),
          `${id} ${entry}`,
        ).not.toThrow();
      }
    }
  });
});
