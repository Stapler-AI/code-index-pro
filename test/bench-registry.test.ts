import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BenchTask, TASKS, TaskValidationError, validateTasks } from "../benchmarks/tasks";
import { fixturesDir, SELF_TAG, TARGETS } from "../benchmarks/targets";

const VALID_TASK: BenchTask = {
  id: "whocalls-fixture-001",
  category: "callers-impact",
  style: "qa",
  target: "fixture-ts",
  prompt: "List every function that calls `greet`, as path:line, one per line. Answer only with the list.",
  grader: { kind: "path-line-set", key: ["src/component.tsx:3"] },
  timeoutSec: 300,
  tags: ["authored", "small", "ts"],
};

describe("benchmark registry (DEV-901 / QA-901)", () => {
  it("the shipped registry loads and validates", () => {
    expect(() => validateTasks(TASKS)).not.toThrow();
  });

  it("rejects a duplicate id at load", () => {
    expect(() => validateTasks([VALID_TASK, { ...VALID_TASK }])).toThrow(TaskValidationError);
    expect(() => validateTasks([VALID_TASK, { ...VALID_TASK }])).toThrow(/duplicate task id/);
  });

  it("rejects an unknown target reference", () => {
    expect(() => validateTasks([{ ...VALID_TASK, target: "no-such-target" }])).toThrow(/unknown target/);
  });

  it("rejects an unknown category", () => {
    expect(() =>
      validateTasks([{ ...VALID_TASK, category: "vibes" as BenchTask["category"] }]),
    ).toThrow(/unknown category/);
  });

  it("rejects a grader with a missing key", () => {
    expect(() =>
      validateTasks([{ ...VALID_TASK, grader: { kind: "path-line-set", key: [] } }]),
    ).toThrow(/missing its key/);
    expect(() =>
      validateTasks([{ ...VALID_TASK, grader: { kind: "exact", key: "" } }]),
    ).toThrow(/missing its key/);
  });

  it("ties grader family to tier: edit needs test-diff; qa must not use it", () => {
    expect(() => validateTasks([{ ...VALID_TASK, style: "edit" }])).toThrow(/test-diff/);
    expect(() =>
      validateTasks([
        {
          ...VALID_TASK,
          style: "qa",
          grader: { kind: "test-diff", testCommand: ["node", "check.js"], mustMatch: [], mustNotMatch: [] },
        },
      ]),
    ).toThrow(/qa tasks cannot/);
  });
});

describe("tool-agnostic prompt validation (SK-D10 / SK-Q10, FR-803)", () => {
  const withPrompt = (prompt: string): BenchTask => ({ ...VALID_TASK, prompt });

  // Rejection: one case per forbidden class. Each must throw TaskValidationError,
  // and (where practical) the message must name the offending substring.
  const rejections: { name: string; prompt: string; match: RegExp }[] = [
    // The 11 MCP tool names (spot the classes + boundaries).
    { name: "find_symbol tool name", prompt: "Use find_symbol to locate greet.", match: /find_symbol/ },
    { name: "who_calls tool name", prompt: "Run who_calls on greet.", match: /who_calls/ },
    { name: "impact_of_change tool name", prompt: "Check impact_of_change for greet.", match: /impact_of_change/ },
    { name: "search_structural tool name", prompt: "Try search_structural for the pattern.", match: /search_structural/ },
    { name: "reindex tool name", prompt: "First reindex, then answer.", match: /reindex/ },
    { name: "index_status tool name", prompt: "Call index_status before answering.", match: /index_status/ },
    // Literal "MCP".
    { name: "MCP mention", prompt: "Use MCP to find every caller of greet.", match: /MCP/ },
    // code-index / code index.
    { name: "code-index (hyphen)", prompt: "Ask the code-index for callers of greet.", match: /code-index/ },
    { name: "code index (space)", prompt: "Ask the code index for callers of greet.", match: /code index/ },
    // "index"-as-mechanism phrasing.
    { name: "query the index", prompt: "Query the index for every caller of greet.", match: /the index/ },
    { name: "the index (standalone)", prompt: "Consult the index and list callers of greet.", match: /the index/ },
    { name: "indexed phrasing", prompt: "List callers of greet from the indexed symbols.", match: /indexed/ },
  ];

  for (const { name, prompt, match } of rejections) {
    it(`rejects a prompt naming a retrieval mechanism: ${name}`, () => {
      expect(() => validateTasks([withPrompt(prompt)])).toThrow(TaskValidationError);
      // Message names the offending substring.
      expect(() => validateTasks([withPrompt(prompt)])).toThrow(match);
    });
  }

  // Acceptance: near-misses that must NOT throw. The rule targets mechanism phrases
  // and tool names, never the bare "index" substring or unrelated vocabulary.
  const acceptances: { name: string; prompt: string }[] = [
    {
      name: "src/index.ts path",
      prompt: "In `src/index.ts`, which function calls `greet`? Answer as path:line.",
    },
    { name: "indexOf identifier", prompt: "Which functions call `indexOf` in this repo? Answer as path:line." },
    { name: "indentation vocabulary", prompt: "List functions affected by the indentation change, as path:line." },
    { name: "indexing domain word", prompt: "Which module drives the indexing pipeline? Answer as path:line." },
  ];

  for (const { name, prompt } of acceptances) {
    it(`accepts a near-miss that is not a mechanism mention: ${name}`, () => {
      expect(() => validateTasks([withPrompt(prompt)])).not.toThrow();
    });
  }

  it("the full shipped registry validates clean (no forbidden prompt mentions)", () => {
    expect(() => validateTasks(TASKS)).not.toThrow();
  });
});

describe("benchmark targets (DEV-901 / QA-901)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("the registry names exactly the three documented target classes", () => {
    expect(Object.keys(TARGETS).sort()).toEqual(["fixture-ts", "oss-zod", "self"]);
    expect(TARGETS["fixture-ts"].class).toBe("fixture");
    expect(TARGETS["oss-zod"].class).toBe("oss");
    expect(TARGETS["self"].class).toBe("self");
  });

  it("fixture-ts materializes a git-ready fixture repo in a temp dir", () => {
    const ws = TARGETS["fixture-ts"].materialize();
    cleanups.push(ws.cleanup);
    expect(existsSync(join(ws.dir, "src", "greet.ts"))).toBe(true);
    expect(existsSync(join(ws.dir, ".git"))).toBe(true);
    // Isolation: a second materialization is a distinct directory.
    const ws2 = TARGETS["fixture-ts"].materialize();
    cleanups.push(ws2.cleanup);
    expect(ws2.dir).not.toBe(ws.dir);
  });

  it("oss-zod honors BENCH_FIXTURES and materializes from the cache", () => {
    const fakeCacheRoot = mkdtempSync(join(tmpdir(), "bench-fixtures-"));
    cleanups.push(() => rmSync(fakeCacheRoot, { recursive: true, force: true }));
    const original = process.env.BENCH_FIXTURES;
    process.env.BENCH_FIXTURES = fakeCacheRoot;
    cleanups.push(() => {
      if (original === undefined) delete process.env.BENCH_FIXTURES;
      else process.env.BENCH_FIXTURES = original;
    });

    expect(fixturesDir()).toBe(fakeCacheRoot);
    // Seed a fake prepared cache (what ensureCache's one-time clone yields).
    mkdirSync(join(fakeCacheRoot, "zod", "src"), { recursive: true });
    writeFileSync(join(fakeCacheRoot, "zod", "src", "types.ts"), "export type Marker = 1;\n");

    const ws = TARGETS["oss-zod"].materialize();
    cleanups.push(ws.cleanup);
    expect(existsSync(join(ws.dir, "src", "types.ts"))).toBe(true);
    expect(ws.dir).not.toContain(fakeCacheRoot); // a copy, not the cache itself
  });

  it("oss-zod without a cache fails with actionable guidance, not a network call", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "bench-empty-"));
    cleanups.push(() => rmSync(emptyRoot, { recursive: true, force: true }));
    const original = process.env.BENCH_FIXTURES;
    process.env.BENCH_FIXTURES = emptyRoot;
    cleanups.push(() => {
      if (original === undefined) delete process.env.BENCH_FIXTURES;
      else process.env.BENCH_FIXTURES = original;
    });
    expect(() => TARGETS["oss-zod"].materialize()).toThrow(/ensureCache|BENCH_FIXTURES/);
  });

  it("self materializes this repo at the pinned tag", () => {
    const ws = TARGETS["self"].materialize();
    cleanups.push(ws.cleanup);
    expect(existsSync(join(ws.dir, "src", "cli.ts"))).toBe(true);
    expect(existsSync(join(ws.dir, "docs", "prd.md"))).toBe(true);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.dir, encoding: "utf8" }).trim();
    const tagged = execFileSync("git", ["rev-parse", `${SELF_TAG}^{commit}`], {
      cwd: ws.dir,
      encoding: "utf8",
    }).trim();
    expect(head).toBe(tagged);
  });
});
