import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildReport,
  median,
  readRuns,
  renderMarkdown,
  setCategoryResolver,
  totalTokens,
  writeReport,
} from "../benchmarks/harness/report";
import type { RunRecord } from "../benchmarks/harness/run";

const PACKAGE_ROOT = resolve(__dirname, "..");

let recCounter = 0;
function rec(over: Partial<RunRecord> & { arm: RunRecord["arm"]; task_id: string; score: number }): RunRecord {
  const metrics = {
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache: 0,
    cost_usd: null,
    wall_s: null,
    turns: 0,
    tool_calls: 0,
    mcp_calls: 0,
    index_build_s: null,
    ...(over.metrics ?? {}),
  };
  return {
    run_id: `${over.task_id}-${over.arm}-${recCounter++}`,
    rep: 1,
    versions: { harness: "0.1.0", agent_cli: "x", model: "m", code_index: "1.0.0", task_set: "abc" },
    grader: "path-line-set",
    flags: [],
    workspace: "results/runs/x",
    ...over,
    metrics,
  } as RunRecord;
}

/** A synthetic suite: one task, both claude arms, with-arm cheaper + as correct. */
function synthetic(): RunRecord[] {
  const m = (tin: number, tout: number, extra: Partial<RunRecord["metrics"]> = {}) => ({
    tokens_in: tin,
    tokens_out: tout,
    tokens_cache: 0,
    cost_usd: null,
    wall_s: null,
    turns: 0,
    tool_calls: 0,
    mcp_calls: 0,
    index_build_s: null,
    ...extra,
  });
  return [
    // with-arm: 100+100 = 200 tokens median, correct, index build 1.5s
    rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: m(100, 100, { index_build_s: 1.5 }) }),
    rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: m(100, 100, { index_build_s: 1.5 }) }),
    // without-arm: 500+500 = 1000 tokens median, also correct
    rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: m(500, 500) }),
    rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: m(500, 500) }),
  ];
}

describe("bench report aggregation (DEV-909 / QA-909)", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  it("median handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("headline token ratio and correctness delta match hand-computed values", () => {
    const data = buildReport(synthetic());
    const claude = data.headlines.find((h) => h.agent === "claude")!;
    expect(claude.withTokensMedian).toBe(200);
    expect(claude.withoutTokensMedian).toBe(1000);
    expect(claude.tokenRatio).toBeCloseTo(0.2, 6); // 200/1000
    expect(claude.correctnessDelta).toBe(0); // both correct
    expect(claude.indexBuildMedian).toBe(1.5); // reported alongside
  });

  it("win/loss/tie counts the paired task correctly (index cheaper = win)", () => {
    const data = buildReport(synthetic());
    const wlt = data.winLossTie.find((w) => w.agent === "claude")!;
    expect(wlt).toEqual({ agent: "claude", win: 1, loss: 0, tie: 0 });
  });

  it("a task where the index is MORE expensive counts as a loss", () => {
    const records = [
      rec({ task_id: "t2", arm: "claude-with", score: 1, metrics: { tokens_in: 900, tokens_out: 100 } as RunRecord["metrics"] }),
      rec({ task_id: "t2", arm: "claude-without", score: 1, metrics: { tokens_in: 100, tokens_out: 100 } as RunRecord["metrics"] }),
    ];
    const wlt = buildReport(records).winLossTie.find((w) => w.agent === "claude")!;
    expect(wlt).toMatchObject({ win: 0, loss: 1, tie: 0 });
  });

  it("per-category × per-arm cells carry medians and index build alongside", () => {
    const data = buildReport(synthetic());
    const withCell = data.cells.find((c) => c.arm === "claude-with")!;
    expect(withCell.category).toBe("symbol-lookup");
    expect(withCell.tokensMedian).toBe(200);
    expect(withCell.correctnessMedian).toBe(1);
    expect(withCell.indexBuildMedian).toBe(1.5);
    const withoutCell = data.cells.find((c) => c.arm === "claude-without")!;
    expect(withoutCell.indexBuildMedian).toBeNull(); // no build on without-arm
  });

  it("the markdown shows index build alongside and never nets it out", () => {
    const md = renderMarkdown(buildReport(synthetic()), "smoke", "2026-01-01");
    expect(md).toContain("Benchmark report: smoke");
    expect(md).toContain("token ratio");
    expect(md).toContain("win (index cheaper)");
    expect(md).toContain("never subtracted");
    // The with-arm token figure is the raw 200, not 200 minus build cost.
    expect(md).toContain("| symbol-lookup | claude-with | 2 | 200 |");
  });

  it("readRuns round-trips the JSONL the harness writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-report-"));
    try {
      const path = join(dir, "runs.jsonl");
      writeFileSync(path, synthetic().map((r) => JSON.stringify(r)).join("\n") + "\n\n");
      const parsed = readRuns(path);
      expect(parsed).toHaveLength(4);
      expect(totalTokens(parsed[0])).toBe(200);
      const reportPath = writeReport(dir, buildReport(parsed), "smoke", "2026-01-01");
      expect(reportPath.endsWith("2026-01-01-smoke.md")).toBe(true);
      expect(existsSync(reportPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("results gitignore (QA-909)", () => {
  const RESULTS = join(PACKAGE_ROOT, "benchmarks", "results");

  function ignored(relPath: string): boolean {
    try {
      execFileSync("git", ["check-ignore", "-q", join(RESULTS, relPath)], { cwd: PACKAGE_ROOT });
      return true;
    } catch {
      return false;
    }
  }

  it("runs.jsonl and preserved workspaces are ignored; dated reports are committable", () => {
    expect(ignored("runs.jsonl")).toBe(true);
    expect(ignored("runs/2026-01-01/whatever/index.db")).toBe(true);
    expect(ignored("2026-01-01-smoke.md")).toBe(false);
    // The .gitignore itself is tracked.
    expect(ignored(".gitignore")).toBe(false);
  });
});
