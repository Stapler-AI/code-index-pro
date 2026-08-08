import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildReport,
  isDiagnosticRun,
  isExcludedRun,
  median,
  readRuns,
  renderMarkdown,
  setCategoryResolver,
  totalTokens,
  writeReport,
} from "../benchmarks/harness/report";
import type { RunRecord } from "../benchmarks/harness/run";
import { SEED_TASKS } from "../benchmarks/seed-tasks";

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

describe("bench report resolves categories from the registry (REV-909 follow-up)", () => {
  it("a real seed task_id resolves to its category, not 'unknown'", () => {
    // Wire the resolver the way the `bench report` subcommand does.
    setCategoryResolver((taskId) => SEED_TASKS.find((t) => t.id === taskId)?.category ?? "unknown");
    const records = [
      rec({ task_id: "sl-fixture-greet-001", arm: "claude-with", score: 1 }),
      rec({ task_id: "sl-fixture-greet-001", arm: "claude-without", score: 1 }),
    ];
    const data = buildReport(records);
    expect(data.cells.every((c) => c.category === "symbol-lookup")).toBe(true);
    expect(data.cells.some((c) => c.category === "unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SK-Q05 — aggregation coverage: exclusions, diagnostics, adoption, composition,
// legacy parity. Author-independent; these pin SK-D05's aggregation only and
// leave render-specific assertions to SK-Q06.
// ---------------------------------------------------------------------------

describe("SK-Q05 flagged/zero-token exclusion from ratios & win/loss", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  const m = (tin: number, tout: number): RunRecord["metrics"] =>
    ({
      tokens_in: tin,
      tokens_out: tout,
      tokens_cache: 0,
      cost_usd: null,
      wall_s: null,
      turns: 0,
      tool_calls: 0,
      mcp_calls: 0,
      index_build_s: null,
    }) as RunRecord["metrics"];

  // One paired task: the with-arm is strictly cheaper (would be a win) and the
  // without-arm anchors the pair. We flag the with-arm run in each case so the
  // pair collapses — proving the flagged run never reaches a ratio or win/loss.
  function pair(withOver: Partial<RunRecord>): RunRecord[] {
    return [
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: m(100, 100), ...withOver }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: m(500, 500) }),
    ];
  }

  for (const flag of ["no_result", "agent_error", "timeout"]) {
    it(`'${flag}' flag drops the run from ratios & win/loss and counts it`, () => {
      const records = pair({ flags: [flag] });
      // Predicate agrees the flagged run is excluded.
      expect(isExcludedRun(records[0])).toBe(true);
      expect(isExcludedRun(records[1])).toBe(false);

      const data = buildReport(records);

      // The pair collapsed: no with-arm run survives, so no paired ratio and
      // no win/loss/tie entry for the pairing.
      const claude = data.headlines.find((h) => h.agent === "claude")!;
      expect(claude.withOverWithout).toBeNull();
      expect(claude.withTokensMedian).toBe(0); // no included with-arm runs
      const wlt = data.winLossTie.find((w) => w.agent === "claude")!;
      expect(wlt).toMatchObject({ win: 0, loss: 0, tie: 0 });

      // No with-arm cell survives; the excluded run did not poison a median.
      expect(data.cells.some((c) => c.arm === "claude-with")).toBe(false);

      // Counted exactly once, per agent × arm.
      expect(data.excluded).toContainEqual({ agent: "claude", arm: "claude-with", excluded: 1 });
    });
  }

  it("zero-token run (no failure flag) is excluded and counted just like a flagged run", () => {
    // Same shape, but the with-arm run simply recorded zero tokens — the codex
    // zero-token failure mode. No flag present; exclusion is by token count.
    const records = pair({ metrics: m(0, 0) });
    expect(records[0].flags).toEqual([]);
    expect(isExcludedRun(records[0])).toBe(true);

    const data = buildReport(records);
    const claude = data.headlines.find((h) => h.agent === "claude")!;
    expect(claude.withOverWithout).toBeNull();
    expect(data.winLossTie.find((w) => w.agent === "claude")!).toMatchObject({ win: 0, loss: 0, tie: 0 });
    expect(data.cells.some((c) => c.arm === "claude-with")).toBe(false);
    expect(data.excluded).toContainEqual({ agent: "claude", arm: "claude-with", excluded: 1 });
  });

  it("excluded counts are reported PER agent × arm, only for non-zero classes", () => {
    const records = [
      // claude-with: one no_result + one timeout excluded (2 total)
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: m(100, 100), flags: ["no_result"] }),
      rec({ task_id: "t2", arm: "claude-with", score: 1, metrics: m(100, 100), flags: ["timeout"] }),
      // codex-without: one zero-token excluded (1 total)
      rec({ task_id: "t1", arm: "codex-without", score: 1, metrics: m(0, 0) }),
      // a clean run so the report is non-degenerate
      rec({ task_id: "t3", arm: "claude-without", score: 1, metrics: m(500, 500) }),
    ];
    const data = buildReport(records);
    expect(data.excluded).toContainEqual({ agent: "claude", arm: "claude-with", excluded: 2 });
    expect(data.excluded).toContainEqual({ agent: "codex", arm: "codex-without", excluded: 1 });
    // The clean arm is not listed (only non-zero exclusion buckets appear).
    expect(data.excluded.some((e) => e.arm === "claude-without")).toBe(false);
  });
});

describe("SK-Q05 diagnostic runs held out of the headline but retrievable", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  const m = (tin: number, tout: number): RunRecord["metrics"] =>
    ({
      tokens_in: tin,
      tokens_out: tout,
      tokens_cache: 0,
      cost_usd: null,
      wall_s: null,
      turns: 0,
      tool_calls: 0,
      mcp_calls: 0,
      index_build_s: null,
    }) as RunRecord["metrics"];

  it("'skill_mode:system-prompt' runs never feed cells/ratios but are on diagnosticRuns", () => {
    const diag = rec({
      task_id: "t1",
      arm: "claude-with-skill",
      score: 1,
      metrics: m(100, 100),
      flags: ["skill_mode:system-prompt"],
    });
    const records = [
      diag,
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: m(100, 100) }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: m(500, 500) }),
    ];
    expect(isDiagnosticRun(diag)).toBe(true);

    const data = buildReport(records);

    // Retrievable: exactly the diagnostic run, preserved as a full RunRecord.
    expect(data.diagnosticRuns).toHaveLength(1);
    expect(data.diagnosticRuns[0].run_id).toBe(diag.run_id);
    expect(data.diagnosticRuns[0].arm).toBe("claude-with-skill");

    // Held out of the headline: the with-skill arm contributed nothing, so the
    // skill ratios/delta/adoption are all null (arm absent from the pool).
    const claude = data.headlines.find((h) => h.agent === "claude")!;
    expect(claude.withSkillOverWith).toBeNull();
    expect(claude.withSkillOverWithout).toBeNull();
    expect(claude.skillCorrectnessDelta).toBeNull();
    expect(claude.adoptionMedian).toBeNull();

    // Held out of cells and per-arm adoption too.
    expect(data.cells.some((c) => c.arm === "claude-with-skill")).toBe(false);
    expect(data.adoption.some((a) => a.arm === "claude-with-skill")).toBe(false);
  });

  it("a diagnostic run is held out even when it also carries a failure flag", () => {
    // Diagnostic classification takes precedence: it lands in diagnosticRuns and
    // never in the excluded-count bucket (it was already removed from the pool).
    const records = [
      rec({
        task_id: "t1",
        arm: "claude-with-skill",
        score: 1,
        metrics: m(100, 100),
        flags: ["skill_mode:system-prompt", "timeout"],
      }),
    ];
    const data = buildReport(records);
    expect(data.diagnosticRuns).toHaveLength(1);
    expect(data.excluded).toEqual([]);
  });
});

describe("SK-Q05 adoption medians (0-tool-calls & legacy records)", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  it("adoption is mcp_calls/tool_calls, and 0 when a run made no tool calls", () => {
    const records = [
      // adoption 4/8 = 0.5 and 2/8 = 0.25 → per-arm median 0.375
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: { tokens_in: 100, tokens_out: 100, tokens_cache: 0, cost_usd: null, wall_s: null, turns: 0, tool_calls: 8, mcp_calls: 4, index_build_s: null } as RunRecord["metrics"] }),
      rec({ task_id: "t2", arm: "claude-with", score: 1, metrics: { tokens_in: 100, tokens_out: 100, tokens_cache: 0, cost_usd: null, wall_s: null, turns: 0, tool_calls: 8, mcp_calls: 2, index_build_s: null } as RunRecord["metrics"] }),
    ];
    const data = buildReport(records);
    const adoption = data.adoption.find((a) => a.arm === "claude-with")!;
    expect(adoption.adoptionMedian).toBeCloseTo(0.375, 6);
  });

  it("a run with 0 tool_calls contributes 0 adoption (no divide-by-zero)", () => {
    const records = [
      // tool_calls = 0 → adoption 0 by spec, even though mcp_calls is 0 too.
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: { tokens_in: 100, tokens_out: 100, tokens_cache: 0, cost_usd: null, wall_s: null, turns: 0, tool_calls: 0, mcp_calls: 0, index_build_s: null } as RunRecord["metrics"] }),
      // a real 4/8 = 0.5 run so the median of [0, 0.5] = 0.25
      rec({ task_id: "t2", arm: "claude-with", score: 1, metrics: { tokens_in: 100, tokens_out: 100, tokens_cache: 0, cost_usd: null, wall_s: null, turns: 0, tool_calls: 8, mcp_calls: 4, index_build_s: null } as RunRecord["metrics"] }),
    ];
    const data = buildReport(records);
    const adoption = data.adoption.find((a) => a.arm === "claude-with")!;
    expect(Number.isFinite(adoption.adoptionMedian)).toBe(true);
    expect(adoption.adoptionMedian).toBeCloseTo(0.25, 6);
  });

  it("legacy record missing mcp_calls/tool_calls aggregates as 0 adoption without throwing", () => {
    // Legacy row: strip mcp_calls & tool_calls entirely (pre-FR-604 shape). The
    // undefined-safe runAdoption must treat it as 0, not NaN or a throw.
    const legacyMetrics: Record<string, unknown> = {
      tokens_in: 100,
      tokens_out: 100,
      tokens_cache: 0,
      cost_usd: null,
      wall_s: null,
      turns: 0,
      index_build_s: null,
    };
    const legacy = rec({ task_id: "t1", arm: "claude-with", score: 1 });
    (legacy as { metrics: unknown }).metrics = legacyMetrics;

    let data!: ReturnType<typeof buildReport>;
    expect(() => {
      data = buildReport([legacy]);
    }).not.toThrow();
    const adoption = data.adoption.find((a) => a.arm === "claude-with")!;
    expect(adoption.adoptionMedian).toBe(0);
  });
});

describe("SK-Q05 token-composition medians incl. missing-split legacy rows", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  it("freshIn/out are always present; cacheRead is the split median", () => {
    const withSplit = (tin: number, tout: number, cacheRead: number): RunRecord["metrics"] =>
      ({
        tokens_in: tin,
        tokens_out: tout,
        tokens_cache: cacheRead,
        tokens_cache_read: cacheRead,
        cost_usd: null,
        wall_s: null,
        turns: 0,
        tool_calls: 0,
        mcp_calls: 0,
        index_build_s: null,
      }) as unknown as RunRecord["metrics"];
    const records = [
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: withSplit(100, 40, 300) }),
      rec({ task_id: "t2", arm: "claude-with", score: 1, metrics: withSplit(200, 60, 500) }),
    ];
    const cell = buildReport(records).cells.find((c) => c.arm === "claude-with")!;
    expect(cell.freshInMedian).toBe(150); // median(100,200)
    expect(cell.outMedian).toBe(50); // median(40,60)
    expect(cell.cacheReadMedian).toBe(400); // median(300,500)
  });

  it("legacy rows missing the cache-read split yield cacheReadMedian === null (renders '—')", () => {
    // The `rec` helper omits tokens_cache_read entirely — the pre-FR-603 shape.
    const records = [
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: { tokens_in: 100, tokens_out: 40, tokens_cache: 0, cost_usd: null, wall_s: null, turns: 0, tool_calls: 0, mcp_calls: 0, index_build_s: null } as RunRecord["metrics"] }),
      rec({ task_id: "t2", arm: "claude-with", score: 1, metrics: { tokens_in: 200, tokens_out: 60, tokens_cache: 0, cost_usd: null, wall_s: null, turns: 0, tool_calls: 0, mcp_calls: 0, index_build_s: null } as RunRecord["metrics"] }),
    ];
    const cell = buildReport(records).cells.find((c) => c.arm === "claude-with")!;
    // freshIn/out still computed from the always-present fields.
    expect(cell.freshInMedian).toBe(150);
    expect(cell.outMedian).toBe(50);
    // No split anywhere → null, so SK-D06 can render the em-dash.
    expect(cell.cacheReadMedian).toBeNull();
  });

  it("a mix of split-bearing and legacy rows takes the median of the present splits only", () => {
    const legacy: RunRecord["metrics"] = { tokens_in: 100, tokens_out: 40, tokens_cache: 0, cost_usd: null, wall_s: null, turns: 0, tool_calls: 0, mcp_calls: 0, index_build_s: null } as RunRecord["metrics"];
    const modern = { ...legacy, tokens_cache_read: 300 } as unknown as RunRecord["metrics"];
    const records = [
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: legacy }),
      rec({ task_id: "t2", arm: "claude-with", score: 1, metrics: modern }),
    ];
    const cell = buildReport(records).cells.find((c) => c.arm === "claude-with")!;
    // Only the modern row carries a split → its value is the median (legacy null dropped).
    expect(cell.cacheReadMedian).toBe(300);
  });
});

describe("SK-Q05 legacy fixture aggregates identically to pre-change behavior", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  // A pre-extension fixture: four runs on the with/without pairing carrying ONLY
  // the fields that existed before FR-602/603/604/606 (no tokens_cache_read,
  // no baseline_calls, no skill_set, no new flags). Aggregation must not throw
  // and must produce the same with/without ratio & win/loss it would have then.
  const legacyMetrics = (tin: number, tout: number): RunRecord["metrics"] =>
    ({
      tokens_in: tin,
      tokens_out: tout,
      tokens_cache: 0,
      cost_usd: null,
      wall_s: null,
      turns: 0,
      tool_calls: 4,
      mcp_calls: 2,
      index_build_s: null,
    }) as RunRecord["metrics"];

  function legacyFixture(): RunRecord[] {
    // Build via rec (which already omits the new split/baseline fields) and then
    // strip versions.skill_set to mirror a genuinely old record.
    const runs = [
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: legacyMetrics(100, 100) }),
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: legacyMetrics(100, 100) }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: legacyMetrics(500, 500) }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: legacyMetrics(500, 500) }),
    ];
    for (const r of runs) {
      delete (r.versions as { skill_set?: unknown }).skill_set;
    }
    return runs;
  }

  it("does not throw and yields the expected with/without ratio & win/loss", () => {
    let data!: ReturnType<typeof buildReport>;
    expect(() => {
      data = buildReport(legacyFixture());
    }).not.toThrow();

    const claude = data.headlines.find((h) => h.agent === "claude")!;
    // 200 median with-arm, 1000 median without-arm → paired ratio 0.2.
    expect(claude.withTokensMedian).toBe(200);
    expect(claude.withoutTokensMedian).toBe(1000);
    expect(claude.withOverWithout).toBeCloseTo(0.2, 6);
    expect(claude.tokenRatio).toBeCloseTo(0.2, 6);
    expect(claude.correctnessDelta).toBe(0);
    // Skill arm is absent in legacy four-arm data → its columns are null.
    expect(claude.withSkillOverWith).toBeNull();
    expect(claude.skillCorrectnessDelta).toBeNull();
    expect(claude.regression).toBe(false);

    // With-arm strictly cheaper on the one paired task → a win.
    expect(data.winLossTie.find((w) => w.agent === "claude")!).toMatchObject({ win: 1, loss: 0, tie: 0 });
    // No new-field artifacts: no exclusions, no diagnostics.
    expect(data.excluded).toEqual([]);
    expect(data.diagnosticRuns).toEqual([]);
    // Composition split is null everywhere (legacy) but totals are intact.
    for (const c of data.cells) expect(c.cacheReadMedian).toBeNull();
  });

  it("adding the new split/baseline fields (same token totals) does not change the ratio or win/loss", () => {
    // Parity anchor: a MODERN fixture with identical token totals but carrying
    // the new fields (tokens_cache_read, baseline_calls) must produce the same
    // with/without ratio, win/loss, and total token medians as the legacy one.
    // Same totals in, same headline out ⇒ the new fields are additive only.
    function modernFixture(): RunRecord[] {
      const withNew = (tin: number, tout: number): RunRecord["metrics"] =>
        ({
          ...legacyMetrics(tin, tout),
          tokens_cache_read: 0,
          tokens_cache_creation: 0,
          baseline_calls: 2,
        }) as unknown as RunRecord["metrics"];
      return [
        rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: withNew(100, 100) }),
        rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: withNew(100, 100) }),
        rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: withNew(500, 500) }),
        rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: withNew(500, 500) }),
      ];
    }

    const legacy = buildReport(legacyFixture());
    const modern = buildReport(modernFixture());
    const lc = legacy.headlines.find((h) => h.agent === "claude")!;
    const mc = modern.headlines.find((h) => h.agent === "claude")!;
    expect(lc.withOverWithout).toEqual(mc.withOverWithout);
    expect(lc.withTokensMedian).toEqual(mc.withTokensMedian);
    expect(lc.withoutTokensMedian).toEqual(mc.withoutTokensMedian);
    expect(legacy.winLossTie).toEqual(modern.winLossTie);
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

// ---------------------------------------------------------------------------
// SK-Q06 — three-way headline & render coverage. Author-independent; pins
// SK-D06's paired-ratio-median definition, the three-way ratio math, the
// structure-heavy subset's exact three categories, both win/loss pairings, and
// the RENDERED markdown (regression-marker-beside-ratio, excluded/diagnostic
// sections, legacy-only no-NaN). Render assertions read `renderMarkdown` output.
// ---------------------------------------------------------------------------

/** Metrics builder local to SK-Q06 (mirrors the aggregation-block helpers). */
function mt(tin: number, tout: number, extra: Partial<RunRecord["metrics"]> = {}): RunRecord["metrics"] {
  return {
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
  } as RunRecord["metrics"];
}

describe("SK-Q06 paired-ratio median definition (per-task pairing, NOT median-of-medians)", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  it("pins per-task-pairing-then-median and distinguishes it from median-of-medians", () => {
    // Three tasks, one run per arm per task. Chosen so the two definitions DIVERGE:
    //   per-task ratios: A 100/200=0.5, B 100/1000=0.1, C 900/1000=0.9
    //     → median([0.5,0.1,0.9]) = 0.5   (the paired-ratio-median definition)
    //   median-of-medians: median(with 100,100,900)=100, median(without 200,1000,1000)=1000
    //     → 100/1000 = 0.1                (the OLD quotient — must NOT be produced)
    const records = [
      rec({ task_id: "A", arm: "claude-with", score: 1, metrics: mt(100, 0) }),
      rec({ task_id: "A", arm: "claude-without", score: 1, metrics: mt(200, 0) }),
      rec({ task_id: "B", arm: "claude-with", score: 1, metrics: mt(100, 0) }),
      rec({ task_id: "B", arm: "claude-without", score: 1, metrics: mt(1000, 0) }),
      rec({ task_id: "C", arm: "claude-with", score: 1, metrics: mt(900, 0) }),
      rec({ task_id: "C", arm: "claude-without", score: 1, metrics: mt(1000, 0) }),
    ];
    const claude = buildReport(records).headlines.find((h) => h.agent === "claude")!;
    expect(claude.withOverWithout).toBeCloseTo(0.5, 6); // per-task-pairing-then-median
    expect(claude.withOverWithout).not.toBeCloseTo(0.1, 6); // NOT the median-of-medians quotient
  });

  it("per-task ratio uses the MEDIAN of each arm's runs for that task before pairing", () => {
    // Single task, multiple runs per arm. Per-task numerator median = median(100,300)=200,
    // denominator median = median(400,600)=500 → task ratio 0.4 → pair median 0.4.
    const records = [
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: mt(100, 0) }),
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: mt(300, 0) }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: mt(400, 0) }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: mt(600, 0) }),
    ];
    const claude = buildReport(records).headlines.find((h) => h.agent === "claude")!;
    expect(claude.withOverWithout).toBeCloseTo(0.4, 6);
  });

  it("a task present on only one arm is dropped from the paired ratio", () => {
    // Task A has both arms (ratio 0.5); task B has ONLY the with-arm (no denominator).
    // Only A contributes → pair ratio 0.5, unaffected by B's lone with-arm run.
    const records = [
      rec({ task_id: "A", arm: "claude-with", score: 1, metrics: mt(100, 0) }),
      rec({ task_id: "A", arm: "claude-without", score: 1, metrics: mt(200, 0) }),
      rec({ task_id: "B", arm: "claude-with", score: 1, metrics: mt(9999, 0) }),
    ];
    const claude = buildReport(records).headlines.find((h) => h.agent === "claude")!;
    expect(claude.withOverWithout).toBeCloseTo(0.5, 6);
  });
});

describe("SK-Q06 three-way ratio math on synthetic six-arm records", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  /** One task, all THREE claude arms present (a "six-arm" suite adds codex too). */
  function sixArm(): RunRecord[] {
    return [
      // claude: without 1000, with 500 (0.5×), with-skill 200 (0.2× of without, 0.4× of with)
      rec({ task_id: "t1", arm: "claude-without", score: 0.5, metrics: mt(500, 500) }),
      rec({ task_id: "t1", arm: "claude-with", score: 0.5, metrics: mt(250, 250, { index_build_s: 2.0 }) }),
      rec({ task_id: "t1", arm: "claude-with-skill", score: 1, metrics: mt(100, 100, { tool_calls: 4, mcp_calls: 2, index_build_s: 2.0 }) }),
      // codex: without 1000, with 800, with-skill 600
      rec({ task_id: "t1", arm: "codex-without", score: 0.5, metrics: mt(500, 500) }),
      rec({ task_id: "t1", arm: "codex-with", score: 0.5, metrics: mt(400, 400) }),
      rec({ task_id: "t1", arm: "codex-with-skill", score: 0.5, metrics: mt(300, 300) }),
    ];
  }

  it("computes all three ratios per agent from paired per-task medians", () => {
    const data = buildReport(sixArm());
    const claude = data.headlines.find((h) => h.agent === "claude")!;
    expect(claude.withOverWithout).toBeCloseTo(0.5, 6); // 500/1000
    expect(claude.withSkillOverWith).toBeCloseTo(0.4, 6); // 200/500
    expect(claude.withSkillOverWithout).toBeCloseTo(0.2, 6); // 200/1000 — the headline
    // The skill delta beats the baseline (1 vs 0.5) → no regression.
    expect(claude.skillCorrectnessDelta).toBeCloseTo(0.5, 6);
    expect(claude.regression).toBe(false);
    // Adoption over the skill arm: 2/4 = 0.5.
    expect(claude.adoptionMedian).toBeCloseTo(0.5, 6);
    // Index build reported alongside (with-family), never netted out.
    expect(claude.indexBuildMedian).toBe(2.0);

    const codex = data.headlines.find((h) => h.agent === "codex")!;
    expect(codex.withOverWithout).toBeCloseTo(0.8, 6); // 800/1000
    expect(codex.withSkillOverWith).toBeCloseTo(0.75, 6); // 600/800
    expect(codex.withSkillOverWithout).toBeCloseTo(0.6, 6); // 600/1000
  });

  it("a missing arm makes only the ratios that need it null (others still compute)", () => {
    // Drop the with-skill arm for claude → skill ratios/delta/adoption null, but
    // with/without still computes. Codex keeps all three arms.
    const records = sixArm().filter((r) => r.arm !== "claude-with-skill");
    const data = buildReport(records);
    const claude = data.headlines.find((h) => h.agent === "claude")!;
    expect(claude.withOverWithout).toBeCloseTo(0.5, 6);
    expect(claude.withSkillOverWith).toBeNull();
    expect(claude.withSkillOverWithout).toBeNull();
    expect(claude.skillCorrectnessDelta).toBeNull();
    expect(claude.adoptionMedian).toBeNull();
    expect(claude.regression).toBe(false); // null delta never fires the marker
    // Codex is unaffected.
    const codex = data.headlines.find((h) => h.agent === "codex")!;
    expect(codex.withSkillOverWithout).toBeCloseTo(0.6, 6);
  });

  it("dropping the without-arm nulls with/without and with-skill/without but keeps with-skill/with", () => {
    const records = sixArm().filter((r) => r.arm !== "claude-without");
    const claude = buildReport(records).headlines.find((h) => h.agent === "claude")!;
    expect(claude.withOverWithout).toBeNull();
    expect(claude.withSkillOverWithout).toBeNull();
    expect(claude.withSkillOverWith).toBeCloseTo(0.4, 6); // 200/500 survives
    expect(claude.skillCorrectnessDelta).toBeNull(); // needs the without baseline
  });
});

describe("SK-Q06 structure-heavy subset uses EXACTLY the three G1 categories", () => {
  // Category resolver keyed off task_id prefix so we can place tasks in different
  // categories: `ci-*`→callers-impact, `cfn-*`→cross-file-navigation,
  // `rr-*`→rename-refactor (the three G1 categories), `sl-*`→symbol-lookup (a 4th).
  beforeEach(() =>
    setCategoryResolver((id) => {
      if (id.startsWith("ci-")) return "callers-impact";
      if (id.startsWith("cfn-")) return "cross-file-navigation";
      if (id.startsWith("rr-")) return "rename-refactor";
      return "symbol-lookup";
    }),
  );

  it("a run in a 4th (non-G1) category does not affect the subset row", () => {
    // Three G1 tasks: each with/without pair has ratio 0.5 → subset withOverWithout 0.5.
    // Plus a symbol-lookup task with a WILDLY different ratio (0.01) that would move
    // the number if it leaked into the subset — it must not.
    const g1 = (prefix: string) => [
      rec({ task_id: `${prefix}-1`, arm: "claude-with", score: 1, metrics: mt(500, 0) }),
      rec({ task_id: `${prefix}-1`, arm: "claude-without", score: 1, metrics: mt(1000, 0) }),
    ];
    const records = [
      ...g1("ci"),
      ...g1("cfn"),
      ...g1("rr"),
      // 4th category — extreme ratio; must be excluded from the subset row.
      rec({ task_id: "sl-1", arm: "claude-with", score: 1, metrics: mt(10, 0) }),
      rec({ task_id: "sl-1", arm: "claude-without", score: 1, metrics: mt(1000, 0) }),
    ];
    const data = buildReport(records);
    const subset = data.structureHeavy.find((h) => h.agent === "claude")!;
    // Only the three 0.5 ratios → median 0.5. The 0.01 sl-1 ratio is absent.
    expect(subset.withOverWithout).toBeCloseTo(0.5, 6);

    // The FULL headline DOES include sl-1: median([0.5,0.5,0.5,0.01]) = 0.5
    // (even count → mean of the two middle 0.5s), confirming sl-1 is only in the
    // full pool. Sanity: the headline saw 4 tasks, the subset saw 3.
    const full = data.headlines.find((h) => h.agent === "claude")!;
    expect(full.withOverWithout).toBeCloseTo(0.5, 6);
  });

  it("with ONLY a 4th-category task there is no structure-heavy row for the agent", () => {
    const records = [
      rec({ task_id: "sl-1", arm: "claude-with", score: 1, metrics: mt(500, 0) }),
      rec({ task_id: "sl-1", arm: "claude-without", score: 1, metrics: mt(1000, 0) }),
    ];
    const data = buildReport(records);
    expect(data.structureHeavy.some((h) => h.agent === "claude")).toBe(false);
    // But the plain headline exists.
    expect(data.headlines.some((h) => h.agent === "claude")).toBe(true);
  });
});

describe("SK-Q06 win/loss/tie for BOTH pairings", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  it("with-vs-without and with-skill-vs-without are counted independently", () => {
    const records = [
      // Task t1: with cheaper than without (with wins), skill cheaper than without (skill wins).
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: mt(1000, 0) }),
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: mt(400, 0) }),
      rec({ task_id: "t1", arm: "claude-with-skill", score: 1, metrics: mt(200, 0) }),
      // Task t2: with MORE expensive than without (with loses), but skill cheaper (skill wins).
      rec({ task_id: "t2", arm: "claude-without", score: 1, metrics: mt(500, 0) }),
      rec({ task_id: "t2", arm: "claude-with", score: 1, metrics: mt(900, 0) }),
      rec({ task_id: "t2", arm: "claude-with-skill", score: 1, metrics: mt(100, 0) }),
      // Task t3: with ties without (tie), skill ties without (tie).
      rec({ task_id: "t3", arm: "claude-without", score: 1, metrics: mt(300, 0) }),
      rec({ task_id: "t3", arm: "claude-with", score: 1, metrics: mt(300, 0) }),
      rec({ task_id: "t3", arm: "claude-with-skill", score: 1, metrics: mt(300, 0) }),
    ];
    const data = buildReport(records);
    // with vs without: t1 win, t2 loss, t3 tie.
    expect(data.winLossTie.find((w) => w.agent === "claude")!).toMatchObject({ win: 1, loss: 1, tie: 1 });
    // with-skill vs without: t1 win, t2 win, t3 tie.
    expect(data.winLossTieSkill.find((w) => w.agent === "claude")!).toMatchObject({ win: 2, loss: 0, tie: 1 });
  });
});

describe("SK-Q06 regression marker renders BESIDE the ratio iff Δ < 0", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  /** A three-arm claude suite where the with-skill correctness is `skillScore`. */
  function suite(skillScore: number): RunRecord[] {
    return [
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: mt(500, 500) }),
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: mt(250, 250) }),
      rec({ task_id: "t1", arm: "claude-with-skill", score: skillScore, metrics: mt(100, 100) }),
    ];
  }

  it("Δ < 0: marker present AND on the SAME rendered line as the ratios", () => {
    const data = buildReport(suite(0.4)); // skill 0.4 vs without 1.0 → Δ = -0.6 < 0
    const claude = data.headlines.find((h) => h.agent === "claude")!;
    expect(claude.skillCorrectnessDelta).toBeCloseTo(-0.6, 6);
    expect(claude.regression).toBe(true);

    const md = renderMarkdown(data, "reg", "2026-01-01");
    expect(md).toContain("⚠ correctness regression");
    // The marker must sit BESIDE the ratio: find the claude headline row and assert
    // that same line carries both a ratio (0.20 = with-skill/without) and the marker.
    const claudeRow = md
      .split("\n")
      .find((l) => l.startsWith("| claude |") && l.includes("0.20") && l.includes("⚠"))!;
    expect(claudeRow).toBeDefined();
    // Same row: the ratio and the marker coexist (marker cannot be split off).
    expect(claudeRow).toContain("0.20");
    expect(claudeRow).toContain("-0.60 ⚠ correctness regression");
  });

  it("Δ >= 0: no marker anywhere in the render", () => {
    const data = buildReport(suite(1)); // skill 1.0 vs without 1.0 → Δ = 0
    const claude = data.headlines.find((h) => h.agent === "claude")!;
    expect(claude.regression).toBe(false);
    const md = renderMarkdown(data, "noreg", "2026-01-01");
    expect(md).not.toContain("⚠ correctness regression");
    // The correctness column is still present beside the ratios (Δ shown, no marker).
    const claudeRow = md.split("\n").find((l) => l.startsWith("| claude |"))!;
    expect(claudeRow).toContain("+0.00");
    expect(claudeRow).toContain("0.20"); // with-skill/without ratio still beside it
  });
});

describe("SK-Q06 excluded counts & diagnostic section render in markdown", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  it("excluded-run section appears with the per agent×arm counts when present", () => {
    const records = [
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: mt(100, 100), flags: ["timeout"] }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: mt(500, 500) }),
    ];
    const md = renderMarkdown(buildReport(records), "excl", "2026-01-01");
    expect(md).toContain("## Excluded runs");
    expect(md).toContain("| claude | claude-with | 1 |");
  });

  it("no excluded section when there are no exclusions", () => {
    const md = renderMarkdown(buildReport(synthetic()), "clean", "2026-01-01");
    expect(md).not.toContain("## Excluded runs");
  });

  it("diagnostic section renders the system-prompt runs when present", () => {
    const diag = rec({
      task_id: "t1",
      arm: "claude-with-skill",
      score: 1,
      metrics: mt(120, 80),
      flags: ["skill_mode:system-prompt"],
    });
    const records = [
      diag,
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: mt(100, 100) }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: mt(500, 500) }),
    ];
    const md = renderMarkdown(buildReport(records), "diag", "2026-01-01");
    expect(md).toContain("## Diagnostic runs");
    expect(md).toContain("skill_mode:system-prompt");
    // The diagnostic run's own id and its total tokens (200) appear in its row.
    expect(md).toContain(diag.run_id);
    expect(md).toContain(`| ${diag.run_id} | t1 | claude-with-skill | 200 |`);
  });

  it("no diagnostic section when there are no system-prompt runs", () => {
    const md = renderMarkdown(buildReport(synthetic()), "clean", "2026-01-01");
    expect(md).not.toContain("## Diagnostic runs");
  });
});

describe("SK-Q06 legacy-only (four-arm) record set renders a VALID report", () => {
  beforeEach(() => setCategoryResolver(() => "symbol-lookup"));

  it("no NaN/undefined in the output and skill columns show the em-dash", () => {
    // Legacy four-arm data: only with/without arms, no skill arm, no cache split.
    const records = [
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: mt(100, 100) }),
      rec({ task_id: "t1", arm: "claude-with", score: 1, metrics: mt(100, 100) }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: mt(500, 500) }),
      rec({ task_id: "t1", arm: "claude-without", score: 1, metrics: mt(500, 500) }),
      rec({ task_id: "t2", arm: "codex-with", score: 1, metrics: mt(200, 100) }),
      rec({ task_id: "t2", arm: "codex-without", score: 1, metrics: mt(400, 100) }),
    ];
    const data = buildReport(records);
    const md = renderMarkdown(data, "legacy", "2026-01-01");

    // A valid report never leaks a NaN or undefined into the rendered string.
    expect(md).not.toContain("NaN");
    expect(md).not.toContain("undefined");

    // The absent skill arm renders as `—` in the headline row's skill columns.
    // Row shape: | agent | with/without | with-skill/with | with-skill/without | Δ | adoption | build |
    const claudeRow = md.split("\n").find((l) => l.startsWith("| claude |"))!;
    const cells = claudeRow.split("|").map((c) => c.trim());
    // cells: ["", agent, w/wo, wskill/w, wskill/wo, Δ, adoption, build, ""]
    expect(cells[1]).toBe("claude");
    expect(cells[2]).toBe("0.20"); // with/without present
    expect(cells[3]).toBe("—"); // with-skill/with absent
    expect(cells[4]).toBe("—"); // with-skill/without absent
    expect(cells[5]).toBe("—"); // correctness Δ absent (no skill arm)
    expect(cells[6]).toBe("—"); // adoption absent

    // And no regression marker can appear when the skill arm is absent.
    expect(md).not.toContain("⚠ correctness regression");
  });
});
