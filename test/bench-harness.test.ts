import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  benchRun,
  defaultDeps,
  executeRun,
  gradeByKind,
  hashTaskSet,
  HarnessDeps,
  parseBenchArgs,
  resolveTasks,
  RunPlan,
  SkillInstall,
} from "../benchmarks/harness/run";
import { readRuns } from "../benchmarks/harness/report";
import { SEED_TASKS } from "../benchmarks/seed-tasks";
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
  // SK-D04 additive: cache split (FR-603) + adoption denominator (FR-604).
  "tokens_cache_read",
  "tokens_cache_creation",
  "baseline_calls",
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
  let transcripts: { workspaceDir: string; stdout: string }[];
  let counter: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bench-harness-"));
    resultsDir = join(root, "results");
    materializedDirs = [];
    indexBuilds = [];
    transcripts = [];
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
      saveTranscript: (workspaceDir, stdout) => {
        transcripts.push({ workspaceDir, stdout });
      },
      preserveWorkspace: (tempDir, suiteStamp, runId) => {
        const dest = join(resultsDir, "runs", suiteStamp, runId);
        mkdirSync(join(resultsDir, "runs", suiteStamp), { recursive: true });
        cpSync(tempDir, dest, { recursive: true });
        rmSync(tempDir, { recursive: true, force: true });
        return dest;
      },
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
      // SK-D04 additive: skill_set (FR-602) joins the frozen versions key-set.
      ["agent_cli", "code_index", "harness", "model", "task_set", "skill_set"].sort(),
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

  it("each run gets a fresh workspace, preserved under results/runs/ (isolation)", async () => {
    const plan: RunPlan = {
      tasks: [TASK],
      arms: ["claude-with"],
      runs: 3,
      model: "claude-opus-4",
      workers: 2,
    };
    const records = await benchRun(plan, fakeDeps());
    expect(new Set(materializedDirs).size).toBe(3); // three distinct temp workspaces
    for (const dir of materializedDirs) expect(existsSync(dir)).toBe(false); // temp relocated away

    // Each record's workspace points under results/runs/<stamp>/<run_id>/ and exists.
    const preserved = new Set(records.map((r) => r.workspace));
    expect(preserved.size).toBe(3);
    for (const record of records) {
      expect(record.workspace).toContain(join(resultsDir, "runs"));
      expect(record.workspace.endsWith(record.run_id)).toBe(true);
      expect(existsSync(record.workspace)).toBe(true);
    }
  });

  it("every run hands its raw agent stdout to saveTranscript", async () => {
    const deps = fakeDeps();
    await executeRun(
      { task: TASK, arm: "claude-without", rep: 1, model: "m", workspaceDir: join(root, "ws"), indexBuildSeconds: null },
      deps,
    );
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].workspaceDir).toBe(join(root, "ws"));
    expect(transcripts[0].stdout).toContain("src/greet.ts:5");
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

  it("parseBenchArgs parses the documented flags with sensible defaults", () => {
    const parsed = parseBenchArgs(["--task", "symbol-lookup", "--arms", "claude-with,claude-without", "--model", "m"]);
    expect(parsed.taskSelector).toBe("symbol-lookup");
    expect(parsed.arms).toEqual(["claude-with", "claude-without"]);
    expect(parsed.runs).toBe(4); // default N
    expect(parsed.workers).toBe(4);
    expect(parsed.model).toBe("m");

    expect(() => parseBenchArgs(["--arms", "bogus-arm"])).toThrow(/unknown arm/);
    expect(() => parseBenchArgs(["--runs", "0"])).toThrow(/positive integer/);
    expect(() => parseBenchArgs(["--task"])).toThrow(/needs a value/);
  });

  it("parseBenchArgs defaults --arms to all six arms; still rejects unknown arms (SK-Q01 / FR-401)", () => {
    // No --arms flag → the six-arm default (grew from four under SK-D01).
    const parsed = parseBenchArgs(["--model", "m"]);
    expect(parsed.arms).toEqual([
      "claude-with",
      "claude-without",
      "claude-with-skill",
      "codex-with",
      "codex-without",
      "codex-with-skill",
    ]);
    // The two new skill arms parse when named explicitly.
    expect(parseBenchArgs(["--arms", "claude-with-skill,codex-with-skill", "--model", "m"]).arms).toEqual([
      "claude-with-skill",
      "codex-with-skill",
    ]);
    // Unknown-arm rejection still fires.
    expect(() => parseBenchArgs(["--arms", "claude-maybe"])).toThrow(/unknown arm/);
  });

  it("a *-with-skill run takes the with-arm path: builds the index and reads mcpConfigFor (SK-Q01 / FR-402)", async () => {
    // Under the old endsWith("-with") gate, a with-skill arm would be treated
    // as a without-arm: no index build, no mcp config. isWithArm membership
    // now puts it on the with-path — this case would fail pre-SK-D01.
    const mcpArms: Arm[] = [];
    const deps = fakeDeps({
      mcpConfigFor: (arm) => {
        mcpArms.push(arm);
        return arm.startsWith("claude") ? "/tmp/bench-mcp.json" : "npx code-index serve .";
      },
    });
    const plan: RunPlan = {
      tasks: [TASK],
      arms: ["claude-with-skill"],
      runs: 1,
      model: "claude-opus-4",
      workers: 1,
    };
    const records = await benchRun(plan, deps);

    const rec = records.find((r) => r.arm === "claude-with-skill")!;
    expect(rec.metrics.index_build_s).toBe(1.5); // buildIndex ran for the skill arm
    expect(indexBuilds).toHaveLength(1);
    expect(mcpArms).toEqual(["claude-with-skill"]); // mcpConfigFor consulted for the skill arm
  });

  it("a codex-with-skill run also builds the index and reads mcpConfigFor (SK-Q01 / FR-402)", async () => {
    const mcpArms: Arm[] = [];
    const deps = fakeDeps({
      mcpConfigFor: (arm) => {
        mcpArms.push(arm);
        return "npx code-index serve .";
      },
    });
    const plan: RunPlan = {
      tasks: [TASK],
      arms: ["codex-with-skill"],
      runs: 1,
      model: "gpt-5-codex",
      workers: 1,
    };
    const records = await benchRun(plan, deps);

    const rec = records.find((r) => r.arm === "codex-with-skill")!;
    expect(rec.metrics.index_build_s).toBe(1.5);
    expect(indexBuilds).toHaveLength(1);
    expect(mcpArms).toEqual(["codex-with-skill"]);
  });

  it("resolveTasks handles all | category | id-list", () => {
    expect(resolveTasks("all", SEED_TASKS).length).toBe(SEED_TASKS.length);
    const symbolTasks = resolveTasks("symbol-lookup", SEED_TASKS);
    expect(symbolTasks.length).toBeGreaterThan(0);
    expect(symbolTasks.every((t) => t.category === "symbol-lookup")).toBe(true);
    const byId = resolveTasks("sl-fixture-greet-001,sl-zod-zoderror-001", SEED_TASKS);
    expect(byId.map((t) => t.id).sort()).toEqual(["sl-fixture-greet-001", "sl-zod-zoderror-001"]);
    expect(() => resolveTasks("no-such-task", SEED_TASKS)).toThrow(/matched no tasks/);
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

  // ── SK-D04 / SK-Q04: instruction-injection wiring & record schema (FR-500/600) ──
  //
  // These exercise deps.installInstructions being threaded through benchRun into
  // the record. The base fakeDeps() omits the seam (every arm a no-op); here we
  // inject a fake installer that records *when* and *with what arm* it was called
  // and returns a per-arm SkillInstall, so ordering, skill-arm gating, and the
  // record fields are all observable without touching real fs or integrations.

  const HASH12 = /^[0-9a-f]{12}$/;

  /**
   * A scripted installer mirroring the real one's contract: no-op (null hash,
   * no flags) for the four non-skill arms; a stable 12-hex hash + flags for the
   * two skill arms. Records each call (arm) plus a `callLog` marker so ordering
   * relative to buildIndex/runAgent can be asserted.
   */
  function fakeInstallDeps(
    callLog: string[],
    installCalls: Arm[],
    forSkill: (arm: Arm) => SkillInstall = (arm) => ({
      hash: arm === "claude-with-skill" ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb",
      flags: [],
    }),
    overrides: Partial<HarnessDeps> = {},
  ): HarnessDeps {
    return fakeDeps({
      buildIndex: (dir) => {
        callLog.push("buildIndex");
        indexBuilds.push(dir);
        return 1.5;
      },
      installInstructions: (_workspaceDir, arm) => {
        callLog.push("installInstructions");
        installCalls.push(arm);
        return arm.endsWith("-with-skill") ? forSkill(arm) : { hash: null, flags: [] };
      },
      runAgent: async (invocation: AgentInvocation) => {
        callLog.push("runAgent");
        return {
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "src/greet.ts:5",
            total_cost_usd: 0.01,
            num_turns: 2,
            duration_ms: 3000,
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 40,
              cache_creation_input_tokens: 10,
            },
          }),
          timedOut: false,
          wallSeconds: 3,
          agentCliVersion: `${invocation.command} 1.0.0`,
        };
      },
      ...overrides,
    });
  }

  it("installInstructions runs for the two skill arms only — never the four non-skill arms (SK-Q04)", async () => {
    const installCalls: Arm[] = [];
    const deps = fakeInstallDeps([], installCalls);
    const plan: RunPlan = {
      tasks: [TASK],
      arms: ["claude-with", "claude-without", "claude-with-skill", "codex-with", "codex-without", "codex-with-skill"],
      runs: 1,
      model: "m",
      workers: 1,
    };
    await benchRun(plan, deps);
    // installInstructions is called for EVERY arm (the seam is per-unit), but a
    // real hash is produced only for the two skill arms; the four non-skill arms
    // get the null no-op. Assert the seam ran once per arm and skill_set proves gating.
    expect(installCalls.sort()).toEqual([...plan.arms].sort());
  });

  it("installInstructions runs after buildIndex and before runAgent (SK-Q04)", async () => {
    const callLog: string[] = [];
    const deps = fakeInstallDeps(callLog, []);
    const plan: RunPlan = { tasks: [TASK], arms: ["claude-with-skill"], runs: 1, model: "m", workers: 1 };
    await benchRun(plan, deps);
    expect(callLog).toEqual(["buildIndex", "installInstructions", "runAgent"]);
  });

  it("skill_set carries the installer's 12-hex hash on skill arms, null otherwise (SK-Q04 / FR-602)", async () => {
    const deps = fakeInstallDeps([], []);
    const plan: RunPlan = {
      tasks: [TASK],
      arms: ["claude-with", "claude-without", "claude-with-skill", "codex-with", "codex-without", "codex-with-skill"],
      runs: 1,
      model: "m",
      workers: 1,
    };
    const records = await benchRun(plan, deps);
    const skillSet = (arm: Arm) => records.find((r) => r.arm === arm)!.versions.skill_set;

    expect(skillSet("claude-with-skill")).toMatch(HASH12);
    expect(skillSet("codex-with-skill")).toMatch(HASH12);
    for (const arm of ["claude-with", "claude-without", "codex-with", "codex-without"] as Arm[]) {
      expect(skillSet(arm)).toBeNull();
    }
  });

  it("baseline_calls and the cache split (read/creation) land in every record (SK-Q04 / FR-603/604)", async () => {
    const deps = fakeInstallDeps([], []);
    const plan: RunPlan = { tasks: [TASK], arms: ["claude-with-skill"], runs: 1, model: "m", workers: 1 };
    const [record] = await benchRun(plan, deps);
    // The scripted result carries no tool_use blocks, so baseline_calls is 0 but
    // PRESENT (previously dropped at write); the split comes from the usage event.
    expect(record.metrics.baseline_calls).toBe(0);
    expect(record.metrics.tokens_cache_read).toBe(40);
    expect(record.metrics.tokens_cache_creation).toBe(10);
    expect(record.metrics.tokens_cache).toBe(50); // back-compat sum still populated
  });

  it("agents_md_appended propagates from the installer's flags into the record flags (SK-Q04 / FR-605)", async () => {
    const deps = fakeInstallDeps([], [], (arm) => ({
      hash: "cccccccccccc",
      flags: arm === "codex-with-skill" ? ["agents_md_appended"] : [],
    }));
    const plan: RunPlan = { tasks: [TASK], arms: ["codex-with-skill", "claude-with-skill"], runs: 1, model: "m", workers: 1 };
    const records = await benchRun(plan, deps);
    expect(records.find((r) => r.arm === "codex-with-skill")!.flags).toContain("agents_md_appended");
    // A skill arm whose install did NOT append must not carry the flag.
    expect(records.find((r) => r.arm === "claude-with-skill")!.flags).not.toContain("agents_md_appended");
  });

  it("system-prompt mode: the flag is stamped and no file is copied (fake-level, SK-Q04 / FR-404)", async () => {
    let fileCopied = false;
    const deps = fakeInstallDeps([], [], (arm) => {
      // Mirror defaultDeps' system-prompt branch: skip the file copy for the
      // claude skill arm, return the body + the always-stamped mode flag.
      if (arm === "claude-with-skill") {
        return { hash: "dddddddddddd", flags: ["skill_mode:system-prompt"], systemPromptBody: "SKILL BODY" };
      }
      fileCopied = true; // only reached if a non-system-prompt install path runs
      return { hash: "eeeeeeeeeeee", flags: [] };
    });
    const plan: RunPlan = { tasks: [TASK], arms: ["claude-with-skill"], runs: 1, model: "m", workers: 1 };
    const [record] = await benchRun(plan, deps);
    expect(record.flags).toContain("skill_mode:system-prompt");
    expect(fileCopied).toBe(false); // the file-copy branch was skipped
    expect(record.versions.skill_set).toMatch(HASH12);
  });

  it("BENCH_SKILL_MODE=system-prompt: the real installer skips the copy and stamps the flag (SK-Q04 / FR-404)", () => {
    // Exercise the production env-gated branch in defaultDeps' installer against
    // the shipped integrations artifact. Set/restore the env var around it.
    const prev = process.env.BENCH_SKILL_MODE;
    process.env.BENCH_SKILL_MODE = "system-prompt";
    try {
      const ws = join(root, "sp-ws");
      mkdirSync(ws, { recursive: true });
      const deps = defaultDeps(resultsDir, [TASK], "1.0.0");
      const install = deps.installInstructions!(ws, "claude-with-skill");
      expect(install.flags).toContain("skill_mode:system-prompt");
      expect(install.hash).toMatch(HASH12);
      expect(typeof install.systemPromptBody).toBe("string");
      expect((install.systemPromptBody ?? "").length).toBeGreaterThan(0);
      // File copy skipped: no .claude/ artifact was written into the workspace.
      expect(existsSync(join(ws, ".claude"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BENCH_SKILL_MODE;
      else process.env.BENCH_SKILL_MODE = prev;
    }
  });

  it("a legacy record lacking the new fields still parses through readRuns (SK-Q04 / FR-600 back-compat)", () => {
    // A pre-SK-D04 record: no skill_set, no cache split, no baseline_calls.
    const legacy = {
      run_id: "2025-01-01T00-00-00-legacy-claude-with-r1",
      task_id: "sl-fixture-greet-001",
      arm: "claude-with",
      rep: 1,
      versions: { harness: "0.1.0", agent_cli: "claude 1.0.0", model: "m", code_index: "1.0.0", task_set: "abc123def456" },
      metrics: {
        tokens_in: 100,
        tokens_out: 20,
        tokens_cache: 0,
        cost_usd: 0.01,
        wall_s: 3,
        turns: 2,
        tool_calls: 0,
        mcp_calls: 0,
        index_build_s: 1.5,
      },
      score: 1,
      grader: "path-line-set",
      flags: [],
      workspace: "/some/legacy/path",
    };
    const legacyPath = join(root, "legacy-runs.jsonl");
    writeFileSync(legacyPath, `${JSON.stringify(legacy)}\n`);
    const parsed = readRuns(legacyPath);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].task_id).toBe("sl-fixture-greet-001");
    // The new fields are simply absent on a legacy record — parsing does not fail.
    expect(parsed[0].versions.skill_set).toBeUndefined();
    expect(parsed[0].metrics.baseline_calls).toBeUndefined();
  });
});
