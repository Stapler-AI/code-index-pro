import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { benchMcpConfig, buildClaudeInvocation, parseClaudeStream } from "./adapters/claude";
import { buildCodexInvocation, computeCost, parseCodexStream } from "./adapters/codex";
import type { AgentInvocation, Arm, ParsedTranscript, RunMetrics } from "./adapters/types";
import { gradeExact, gradePathLineSet, gradeSet, gradeEdit, GradeResult } from "./graders/deterministic";
import { CATEGORIES, TASKS, type BenchTask } from "../tasks";
import { TARGETS, type Materialized } from "../targets";
import { toolVersion } from "../../src/storage/meta";
import { buildReport, readRuns, setCategoryResolver, writeReport } from "./report";

/**
 * Harness orchestrator (benchmark.md#harness, #metrics, #results--reporting).
 * `bench run` drives, per (task, arm, run): materialize a fresh workspace ->
 * with-arm only: build the index (time recorded separately, excluded from
 * agent metrics) -> invoke the agent adapter with per-arm config + timeout ->
 * grade -> append one record to results/runs.jsonl -> preserve the workspace.
 *
 * The orchestration is dependency-injected (HarnessDeps) so the run loop is
 * testable with a fake adapter — no real agent sessions or index builds.
 */

export const HARNESS_VERSION = "0.1.0";

/** The append-only record shape from benchmark.md#results--reporting. */
export interface RunRecord {
  run_id: string;
  task_id: string;
  arm: Arm;
  rep: number;
  versions: {
    harness: string;
    agent_cli: string;
    model: string;
    code_index: string;
    task_set: string;
  };
  metrics: {
    tokens_in: number;
    tokens_out: number;
    tokens_cache: number;
    cost_usd: number | null;
    wall_s: number | null;
    turns: number;
    tool_calls: number;
    mcp_calls: number;
    index_build_s: number | null;
  };
  score: number;
  grader: string;
  flags: string[];
  workspace: string;
}

export interface AgentRunResult {
  stdout: string;
  timedOut: boolean;
  /** Harness wall-clock (authoritative fallback if the CLI omits duration). */
  wallSeconds: number;
  agentCliVersion: string;
}

export interface RunContext {
  task: BenchTask;
  arm: Arm;
  rep: number;
  model: string;
  workspaceDir: string;
  /** null for without-arm runs (no index is built). */
  indexBuildSeconds: number | null;
}

/** Injected seams; defaultDeps() supplies the real implementations. */
export interface HarnessDeps {
  materialize(targetName: string): Materialized;
  /** Build the index in a with-arm workspace; returns build seconds. */
  buildIndex(workspaceDir: string): number;
  runAgent(invocation: AgentInvocation, opts: { cwd: string; timeoutSec: number }): Promise<AgentRunResult>;
  gradeTask(task: BenchTask, input: { answer: string; workspaceDir: string }): GradeResult;
  /**
   * The MCP config value for a with-arm, or undefined for without-arms. The
   * two CLIs read this field differently (REV-905): Claude wants a path to a
   * written --mcp-config JSON file; Codex wants the server launch command.
   * defaultDeps resolves each; without-arms never call this.
   */
  mcpConfigFor(arm: Arm): string | undefined;
  /**
   * Relocate the just-run workspace under results/runs/<suiteStamp>/<runId>/
   * for offline re-scoring (benchmark.md KEEP node) and return its final
   * path, which becomes record.workspace. Grading has already read the temp
   * workspace by this point.
   */
  preserveWorkspace(tempDir: string, suiteStamp: string, runId: string): string;
  now(): string;
  codeIndexVersion: string;
  taskSetHash: string;
  resultsDir: string;
}

function adapterFor(arm: Arm) {
  return arm.startsWith("claude")
    ? { build: buildClaudeInvocation, parse: parseClaudeStream }
    : { build: buildCodexInvocation, parse: parseCodexStream };
}

/** Deterministic grader dispatch by grader kind (judge is DEV-907's module). */
export function gradeByKind(task: BenchTask, input: { answer: string; workspaceDir: string }): GradeResult {
  const g = task.grader;
  switch (g.kind) {
    case "exact":
      return gradeExact(input.answer, g);
    case "set":
      return gradeSet(input.answer, g);
    case "path-line-set":
      return gradePathLineSet(input.answer, g);
    case "test-diff":
      return gradeEdit(input.workspaceDir, g);
    case "judge":
      throw new Error(`task ${task.id}: judge grading requires the DEV-907 judge module (not wired into bench run)`);
  }
}

/** Stable content hash of the task set (benchmark.md: versions.task_set). */
export function hashTaskSet(tasks: BenchTask[]): string {
  return createHash("sha256").update(JSON.stringify(tasks)).digest("hex").slice(0, 12);
}

function finalizeMetrics(arm: Arm, parsed: ParsedTranscript, model: string, wallSeconds: number): RunMetrics {
  const m = { ...parsed.metrics };
  if (m.wallSeconds === null) m.wallSeconds = wallSeconds;
  // Codex self-reports no cost: apply published pricing.
  if (m.costUsd === null && arm.startsWith("codex")) m.costUsd = computeCost(m, model);
  return m;
}

/** Execute one (task, arm, rep) run and return its record — appends nothing. */
export async function executeRun(ctx: RunContext, deps: HarnessDeps): Promise<RunRecord> {
  const { task, arm, rep, model, workspaceDir } = ctx;
  const { build, parse } = adapterFor(arm);
  const mcpConfigPath = arm.endsWith("-with") ? deps.mcpConfigFor(arm) : undefined;
  const invocation = build({ prompt: task.prompt, arm, model, mcpConfigPath, editTier: task.style === "edit" });

  const agent = await deps.runAgent(invocation, { cwd: workspaceDir, timeoutSec: task.timeoutSec });
  const parsed = parse(agent.stdout);
  const flags = [...parsed.flags];
  if (agent.timedOut) flags.push("timeout");

  let score = 0;
  if (!agent.timedOut) {
    const graded = deps.gradeTask(task, { answer: parsed.finalAnswer, workspaceDir });
    score = graded.score;
  }

  const metrics = finalizeMetrics(arm, parsed, model, agent.wallSeconds);
  const stamp = deps.now();
  return {
    run_id: `${stamp}-${task.id}-${arm}-r${rep}`,
    task_id: task.id,
    arm,
    rep,
    versions: {
      harness: HARNESS_VERSION,
      agent_cli: agent.agentCliVersion,
      model,
      code_index: deps.codeIndexVersion,
      task_set: deps.taskSetHash,
    },
    metrics: {
      tokens_in: metrics.tokensIn,
      tokens_out: metrics.tokensOut,
      tokens_cache: metrics.tokensCache,
      cost_usd: metrics.costUsd,
      wall_s: metrics.wallSeconds,
      turns: metrics.turns,
      tool_calls: metrics.toolCalls,
      mcp_calls: metrics.mcpCalls,
      index_build_s: ctx.indexBuildSeconds,
    },
    score,
    grader: task.grader.kind,
    flags,
    workspace: workspaceDir,
  };
}

export interface RunPlan {
  tasks: BenchTask[];
  arms: Arm[];
  runs: number;
  model: string;
  workers: number;
}

/** Append one record to the append-only results/runs.jsonl. */
export function appendRecord(resultsDir: string, record: RunRecord): void {
  mkdirSync(resultsDir, { recursive: true });
  appendFileSync(join(resultsDir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
}

/** Run a bounded-concurrency pool over units, preserving nothing but order-free. */
async function pool<T>(units: (() => Promise<T>)[], workers: number): Promise<T[]> {
  const results: T[] = new Array(units.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= units.length) return;
      results[i] = await units[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, units.length)) }, worker));
  return results;
}

/**
 * The full `bench run` loop. Each unit materializes its own fresh workspace
 * (isolation invariant: no run sees another's residue), builds the index for
 * with-arms only (time recorded separately), runs, grades, appends, and
 * preserves the workspace under results/runs/<timestamp>/.
 */
export async function benchRun(plan: RunPlan, deps: HarnessDeps): Promise<RunRecord[]> {
  const suiteStamp = deps.now(); // one timestamp groups the whole suite's runs
  const units: (() => Promise<RunRecord>)[] = [];
  for (const task of plan.tasks) {
    for (const arm of plan.arms) {
      for (let rep = 1; rep <= plan.runs; rep++) {
        units.push(async () => {
          const ws = deps.materialize(task.target);
          const indexBuildSeconds = arm.endsWith("-with") ? deps.buildIndex(ws.dir) : null;
          const record = await executeRun(
            { task, arm, rep, model: plan.model, workspaceDir: ws.dir, indexBuildSeconds },
            deps,
          );
          // Relocate the workspace under results/runs/ and record its final
          // path (benchmark.md KEEP node) — grading already read the temp dir.
          record.workspace = deps.preserveWorkspace(ws.dir, suiteStamp, record.run_id);
          appendRecord(deps.resultsDir, record);
          return record;
        });
      }
    }
  }
  return pool(units, plan.workers);
}

/** Real dependencies for a live `bench run`. */
export function defaultDeps(resultsDir: string, taskSet: BenchTask[], codeIndexVersion: string): HarnessDeps {
  return {
    materialize: (targetName) => {
      const target = TARGETS[targetName];
      if (!target) throw new Error(`unknown target: ${targetName}`);
      target.ensureCache();
      return target.materialize();
    },
    buildIndex: (workspaceDir) => {
      const started = Date.now();
      execFileSync("npx", ["code-index", "index", "."], { cwd: workspaceDir, stdio: "ignore" });
      return (Date.now() - started) / 1000;
    },
    runAgent: async (invocation, opts) => {
      const started = Date.now();
      let stdout = "";
      let timedOut = false;
      try {
        stdout = execFileSync(invocation.command, invocation.args, {
          cwd: opts.cwd,
          encoding: "utf8",
          timeout: opts.timeoutSec * 1000,
          maxBuffer: 128 * 1024 * 1024,
        });
      } catch (error) {
        const e = error as { signal?: string; stdout?: string };
        timedOut = e.signal === "SIGTERM";
        stdout = e.stdout?.toString() ?? "";
      }
      let agentCliVersion = "unknown";
      try {
        agentCliVersion = execFileSync(invocation.command, ["--version"], { encoding: "utf8" }).trim();
      } catch {
        /* version probe best-effort */
      }
      return { stdout, timedOut, wallSeconds: (Date.now() - started) / 1000, agentCliVersion };
    },
    gradeTask: gradeByKind,
    mcpConfigFor: (arm) => {
      // Claude reads a written JSON config file; Codex reads the launch command.
      if (arm.startsWith("claude")) {
        const path = join(resolve(resultsDir), "bench-mcp.json");
        mkdirSync(resolve(resultsDir), { recursive: true });
        writeFileSync(path, benchMcpConfig("npx", ["code-index", "serve", "."]));
        return path;
      }
      return "npx code-index serve .";
    },
    preserveWorkspace: (tempDir, suiteStamp, runId) => {
      const dest = join(resolve(resultsDir), "runs", suiteStamp, runId);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(tempDir, dest, { recursive: true });
      rmSync(tempDir, { recursive: true, force: true });
      return dest;
    },
    now: () => new Date().toISOString().replace(/[:.]/g, "-"),
    codeIndexVersion,
    taskSetHash: hashTaskSet(taskSet),
    resultsDir: resolve(resultsDir),
  };
}

// ── bench run CLI ───────────────────────────────────────────────────────────

export interface BenchArgs {
  taskSelector: string;
  arms: Arm[];
  runs: number;
  workers: number;
  model: string;
  resultsDir: string;
}

const ALL_ARMS: Arm[] = ["claude-with", "claude-without", "codex-with", "codex-without"];

/** Parse `bench run --task <ids|category|all> --arms <a,b> --runs N --workers N`. */
export function parseBenchArgs(argv: string[]): BenchArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`expected a --flag at "${argv[i]}"`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`flag ${argv[i]} needs a value`);
    flags.set(argv[i].slice(2), value);
  }
  const arms = (flags.get("arms") ?? ALL_ARMS.join(",")).split(",") as Arm[];
  for (const arm of arms) {
    if (!ALL_ARMS.includes(arm)) throw new Error(`unknown arm: ${arm}`);
  }
  const runs = Number(flags.get("runs") ?? 4);
  const workers = Number(flags.get("workers") ?? 4);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(workers) || workers < 1) throw new Error("--workers must be a positive integer");
  return {
    taskSelector: flags.get("task") ?? "all",
    arms,
    runs,
    workers,
    model: flags.get("model") ?? "",
    resultsDir: flags.get("results") ?? resolve(__dirname, "..", "results"),
  };
}

/** Resolve --task: "all" | a category name | a comma-separated id list. */
export function resolveTasks(selector: string, all: BenchTask[] = TASKS): BenchTask[] {
  if (selector === "all") return all;
  if ((CATEGORIES as readonly string[]).includes(selector)) {
    return all.filter((t) => t.category === selector);
  }
  const ids = new Set(selector.split(","));
  const matched = all.filter((t) => ids.has(t.id));
  if (matched.length === 0) throw new Error(`--task matched no tasks: ${selector}`);
  return matched;
}

/** `bench report [--name <name>] [--date <YYYY-MM-DD>] [--results <dir>]`. */
function benchReport(argv: string[]): void {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) flags.set(argv[i].replace(/^--/, ""), argv[i + 1] ?? "");
  const resultsDir = resolve(flags.get("results") ?? join(__dirname, "..", "results"));
  const name = flags.get("name") ?? "report";
  const date = flags.get("date") ?? new Date().toISOString().slice(0, 10);
  // Resolve categories from the task registry so rows aren't labelled "unknown".
  setCategoryResolver((taskId) => TASKS.find((t) => t.id === taskId)?.category ?? "unknown");
  const records = readRuns(join(resultsDir, "runs.jsonl"));
  const path = writeReport(resultsDir, buildReport(records), name, date);
  process.stdout.write(`bench report written: ${path}\n`);
}

/** `bench run` / `bench report` entry point. */
export async function main(argv: string[]): Promise<void> {
  if (argv[0] === "report") {
    benchReport(argv.slice(1));
    return;
  }
  if (argv[0] !== "run") {
    throw new Error(
      `usage: bench run --task <ids|category|all> --arms <arms> --runs N --workers N --model <id>\n` +
        `       bench report [--name <name>] [--date <YYYY-MM-DD>] [--results <dir>]`,
    );
  }
  const parsed = parseBenchArgs(argv.slice(1));
  if (parsed.model.length === 0) throw new Error("--model is required (pin the model per agent)");
  const tasks = resolveTasks(parsed.taskSelector);
  const deps = defaultDeps(parsed.resultsDir, TASKS, toolVersion());
  const records = await benchRun(
    { tasks, arms: parsed.arms, runs: parsed.runs, model: parsed.model, workers: parsed.workers },
    deps,
  );
  process.stdout.write(`bench run complete: ${records.length} records appended to ${deps.resultsDir}/runs.jsonl\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`bench: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
