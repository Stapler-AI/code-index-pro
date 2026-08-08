import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  benchRun,
  executeRun,
  gradeByKind,
  hashTaskSet,
  HarnessDeps,
  RunPlan,
} from "../benchmarks/harness/run";
import type { AgentInvocation, Arm } from "../benchmarks/harness/adapters/types";
import type { BenchTask } from "../benchmarks/tasks";

/**
 * QA-906: the run loop driven by a scripted fake adapter — no real agent
 * sessions or index builds. Covers record shape, isolation + preservation,
 * index_build_s only on with-arms, timeout flagging, and append-only resume.
 */

const TASK: BenchTask = {
  id: "sl-fixture-greet-001",
  category: "symbol-lookup",
  style: "qa",
  target: "fixture-ts",
  prompt: "Where is `greet` defined? Answer with a single line as path:line.",
  grader: { kind: "path-line-set", key: ["src/greet.ts:5"] },
  timeoutSec: 300,
  tags: ["authored", "small", "ts"],
};

const RECORD_FIELDS = [
  "run_id",
  "task_id",
  "arm",
  "rep",
  "versions",
  "metrics",
  "score",
  "grader",
  "flags",
  "workspace",
];
const METRIC_FIELDS = [
  "tokens_in",
  "tokens_out",
  "tokens_cache",
  "cost_usd",
  "wall_s",
  "turns",
  "tool_calls",
  "mcp_calls",
  "index_build_s",
];

describe("harness orchestrator (DEV-906 / QA-906)", () => {
  let root: string;
  let resultsDir: string;
  let materializedDirs: string[];
  let indexBuilds: string[];
  let counter: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-harness-"));
    resultsDir = join(root, "results");
    materializedDirs = [];
    indexBuilds = [];
    counter = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A fake adapter: fresh workspace dir per call, scripted agent output. */
  function fakeDeps(overrides: Partial<HarnessDeps> = {}): HarnessDeps {
    return {
      materialize: () => {
        const dir = join(root, `ws-${counter++}`);
        mkdirSync(dir, { recursive: true });
        materializedDirs.push(dir);
        return { dir, cleanup: () => {} };
      },
      buildIndex: (dir) => {
        indexBuilds.push(dir);
        return 1.5;
      },
      runAgent: async (invocation: AgentInvocation) => ({
        // The agent "answers" correctly; with-arms would carry mcp calls.
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "src/greet.ts:5",
          total_cost_usd: 0.01,
          num_turns: 2,
          duration_ms: 3000,
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        timedOut: false,
        wallSeconds: 3,
        agentCliVersion: `${invocation.command} 1.0.0`,
      }),
      gradeTask: gradeByKind,
      mcpConfigFor: (arm) => (arm.startsWith("claude") ? "/tmp/bench-mcp.json" : "npx code-index serve ."),
      now: () => `2026-01-01T00-00-0${counter}`,
      codeIndexVersion: "1.0.0",
      taskSetHash: hashTaskSet([TASK]),
      resultsDir,
      ...overrides,
    };
  }

  function readRecords(): Record<string, unknown>[] {
    const path = join(resultsDir, "runs.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("a run record contains every documented field", async () => {
    const deps = fakeDeps();
    const record = await executeRun(
      { task: TASK, arm: "claude-with", rep: 1, model: "claude-opus-4", workspaceDir: join(root, "ws"), indexBuildSeconds: 1.5 },
      deps,
    );
    expect(Object.keys(record).sort()).toEqual([...RECORD_FIELDS].sort());
    expect(Object.keys(record.metrics).sort()).toEqual([...METRIC_FIELDS].sort());
    expect(Object.keys(record.versions).sort()).toEqual(
      ["agent_cli", "code_index", "harness", "model", "task_set"].sort(),
    );
    expect(record.run_id).toContain("sl-fixture-greet-001");
    expect(record.run_id).toContain("claude-with");
    expect(record.score).toBe(1); // graded against the correct answer
    expect(record.grader).toBe("path-line-set");
  });

  it("with-arm builds the index (recorded separately); without-arm does not", async () => {
    const plan: RunPlan = {
      tasks: [TASK],
      arms: ["claude-with", "claude-without"],
      runs: 1,
      model: "claude-opus-4",
      workers: 1,
    };
    const records = await benchRun(plan, fakeDeps());

    const withRec = records.find((r) => r.arm === "claude-with")!;
    const withoutRec = records.find((r) => r.arm === "claude-without")!;
    expect(withRec.metrics.index_build_s).toBe(1.5);
    expect(withoutRec.metrics.index_build_s).toBeNull();
    // Exactly one index build happened — for the with-arm only.
    expect(indexBuilds).toHaveLength(1);
  });

  it("each run gets a fresh workspace, preserved afterward (isolation)", async () => {
    const plan: RunPlan = {
      tasks: [TASK],
      arms: ["claude-with"],
      runs: 3,
      model: "claude-opus-4",
      workers: 2,
    };
    await benchRun(plan, fakeDeps());
    expect(new Set(materializedDirs).size).toBe(3); // three distinct workspaces
    for (const dir of materializedDirs) expect(existsSync(dir)).toBe(true); // preserved
  });

  it("a timed-out run produces a flagged, zero-score record", async () => {
    const deps = fakeDeps({
      runAgent: async () => ({ stdout: "", timedOut: true, wallSeconds: 300, agentCliVersion: "claude 1.0.0" }),
    });
    const record = await executeRun(
      { task: TASK, arm: "claude-without", rep: 1, model: "m", workspaceDir: join(root, "ws"), indexBuildSeconds: null },
      deps,
    );
    expect(record.flags).toContain("timeout");
    expect(record.score).toBe(0); // no grading on a timed-out run
  });

  it("records append across an interrupted-and-resumed suite (never rewrite)", async () => {
    const plan: RunPlan = { tasks: [TASK], arms: ["claude-without"], runs: 2, model: "m", workers: 1 };
    await benchRun(plan, fakeDeps());
    expect(readRecords()).toHaveLength(2);

    // A second invocation (resume) appends, preserving the first run's records.
    await benchRun(plan, fakeDeps());
    const all = readRecords();
    expect(all).toHaveLength(4);
    expect(all.every((r) => r.task_id === "sl-fixture-greet-001")).toBe(true);
  });

  it("the task_set hash is stable and changes only when the task set changes", () => {
    expect(hashTaskSet([TASK])).toBe(hashTaskSet([TASK]));
    expect(hashTaskSet([TASK])).not.toBe(hashTaskSet([{ ...TASK, prompt: "different" }]));
  });

  it("Codex arm computes cost from pricing while Claude uses the reported cost", async () => {
    const deps = fakeDeps({
      runAgent: async () => ({
        // A Codex-shaped stream: no cost, cumulative tokens, completion.
        stdout: [
          JSON.stringify({ msg: { type: "token_count", input_tokens: 1_000_000, output_tokens: 1_000_000 } }),
          JSON.stringify({ msg: { type: "agent_message", message: "src/greet.ts:5" } }),
          JSON.stringify({ msg: { type: "task_complete" } }),
        ].join("\n"),
        timedOut: false,
        wallSeconds: 5,
        agentCliVersion: "codex 1.0.0",
      }),
    });
    const record = await executeRun(
      { task: TASK, arm: "codex-with", rep: 1, model: "gpt-5-codex", workspaceDir: join(root, "ws"), indexBuildSeconds: 2 },
      deps,
    );
    // 1M in × $1.25 + 1M out × $10 per 1M = 11.25.
    expect(record.metrics.cost_usd).toBeCloseTo(11.25, 6);
    expect(record.metrics.wall_s).toBe(5); // harness fallback (Codex omits duration)
  });

  it("a judge-grader task refuses deterministic grading with a clear error", () => {
    const judgeTask: BenchTask = {
      ...TASK,
      id: "ar-self-layering-001",
      category: "architecture",
      target: "self",
      grader: { kind: "judge", rubric: "r", key: "k" },
    };
    expect(() => gradeByKind(judgeTask, { answer: "x", workspaceDir: root })).toThrow(/judge/);
  });
});
