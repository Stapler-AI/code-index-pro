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
