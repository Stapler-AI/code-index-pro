import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Arm } from "./adapters/types";
import type { RunRecord } from "./run";

/**
 * Reporting (benchmark.md#results--reporting). `bench report` reads the
 * append-only results/runs.jsonl and emits dated markdown: per-category ×
 * per-arm median tables, per-agent with/without token ratio + correctness
 * delta (the headline), win/loss/tie counts per task pair, and index build
 * time shown ALONGSIDE — never netted out of the token figures.
 *
 * The aggregation (buildReport) is pure and testable; renderMarkdown only
 * formats it.
 */

export type Agent = "claude" | "codex";

function agentOf(arm: Arm): Agent {
  return arm.startsWith("claude") ? "claude" : "codex";
}
function isWith(arm: Arm): boolean {
  return arm.endsWith("-with");
}

/** Total context tokens for the headline ratio (in + out + cache). */
export function totalTokens(r: RunRecord): number {
  return r.metrics.tokens_in + r.metrics.tokens_out + r.metrics.tokens_cache;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianOrNull(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : median(nums);
}

export interface CellStats {
  category: string;
  arm: Arm;
  runs: number;
  tokensMedian: number;
  costMedian: number | null;
  wallMedian: number | null;
  toolCallsMedian: number;
  correctnessMedian: number;
  indexBuildMedian: number | null;
}

export interface AgentHeadline {
  agent: Agent;
  /** with-median-tokens / without-median-tokens; null if a side is missing. */
  tokenRatio: number | null;
  withTokensMedian: number;
  withoutTokensMedian: number;
  /** median(score_with) - median(score_without). */
  correctnessDelta: number;
  /** with-arm index build median (reported alongside, never netted out). */
  indexBuildMedian: number | null;
}

export interface WinLossTie {
  agent: Agent;
  win: number; // with-arm used strictly fewer tokens on the task pair
  loss: number;
  tie: number;
}

export interface ReportData {
  cells: CellStats[];
  headlines: AgentHeadline[];
  winLossTie: WinLossTie[];
  totalRuns: number;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    (map.get(k) ?? map.set(k, []).get(k)!).push(item);
  }
  return map;
}

/** Pure aggregation of raw run records into report figures. */
export function buildReport(records: RunRecord[]): ReportData {
  // Per-category × per-arm median cells.
  const cells: CellStats[] = [];
  for (const [, group] of groupBy(records, (r) => `${categoryOf(r, records)}|${r.arm}`)) {
    const first = group[0];
    cells.push({
      category: categoryOf(first, records),
      arm: first.arm,
      runs: group.length,
      tokensMedian: median(group.map(totalTokens)),
      costMedian: medianOrNull(group.map((r) => r.metrics.cost_usd)),
      wallMedian: medianOrNull(group.map((r) => r.metrics.wall_s)),
      toolCallsMedian: median(group.map((r) => r.metrics.tool_calls)),
      correctnessMedian: median(group.map((r) => r.score)),
      indexBuildMedian: medianOrNull(group.map((r) => r.metrics.index_build_s)),
    });
  }
  cells.sort((a, b) => (a.category === b.category ? a.arm.localeCompare(b.arm) : a.category.localeCompare(b.category)));

  // Per-agent headline: with vs without across all that agent's runs.
  const headlines: AgentHeadline[] = [];
  const winLossTie: WinLossTie[] = [];
  for (const agent of ["claude", "codex"] as Agent[]) {
    const agentRuns = records.filter((r) => agentOf(r.arm) === agent);
    if (agentRuns.length === 0) continue;
    const withRuns = agentRuns.filter((r) => isWith(r.arm));
    const withoutRuns = agentRuns.filter((r) => !isWith(r.arm));
    const withTok = median(withRuns.map(totalTokens));
    const withoutTok = median(withoutRuns.map(totalTokens));
    headlines.push({
      agent,
      tokenRatio: withRuns.length > 0 && withoutRuns.length > 0 && withoutTok !== 0 ? withTok / withoutTok : null,
      withTokensMedian: withTok,
      withoutTokensMedian: withoutTok,
      correctnessDelta: median(withRuns.map((r) => r.score)) - median(withoutRuns.map((r) => r.score)),
      indexBuildMedian: medianOrNull(withRuns.map((r) => r.metrics.index_build_s)),
    });

    // Win/loss/tie per task pair (within agent): with-arm median tokens vs
    // without-arm median tokens for the same task; lower = win for the index.
    let win = 0;
    let loss = 0;
    let tie = 0;
    const tasks = new Set(agentRuns.map((r) => r.task_id));
    for (const taskId of tasks) {
      const w = withRuns.filter((r) => r.task_id === taskId);
      const wo = withoutRuns.filter((r) => r.task_id === taskId);
      if (w.length === 0 || wo.length === 0) continue;
      const wm = median(w.map(totalTokens));
      const wom = median(wo.map(totalTokens));
      if (wm < wom) win += 1;
      else if (wm > wom) loss += 1;
      else tie += 1;
    }
    winLossTie.push({ agent, win, loss, tie });
  }

  return { cells, headlines, winLossTie, totalRuns: records.length };
}

/**
 * Category lookup: records don't carry category, so it's resolved from the
 * task registry by task_id. Pure fallback to "unknown" keeps the report
 * robust to registry drift.
 */
let categoryResolver: (taskId: string) => string = () => "unknown";
export function setCategoryResolver(fn: (taskId: string) => string): void {
  categoryResolver = fn;
}
function categoryOf(record: RunRecord, _all: RunRecord[]): string {
  return categoryResolver(record.task_id);
}

export function readRuns(path: string): RunRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunRecord);
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? "—" : n.toFixed(digits);
}

export function renderMarkdown(data: ReportData, name: string, date: string): string {
  const lines: string[] = [`# Benchmark report: ${name}`, "", `Date: ${date} · Runs: ${data.totalRuns}`, ""];

  lines.push("## Headline — with vs without (per agent)", "");
  lines.push("| Agent | token ratio (with/without) | correctness Δ | index build (s, alongside) |");
  lines.push("|---|---|---|---|");
  for (const h of data.headlines) {
    lines.push(
      `| ${h.agent} | ${fmt(h.tokenRatio)} | ${h.correctnessDelta >= 0 ? "+" : ""}${fmt(h.correctnessDelta)} | ${fmt(h.indexBuildMedian)} |`,
    );
  }
  lines.push("");

  lines.push("## Win / loss / tie per task pair (token cost, per agent)", "");
  lines.push("| Agent | win (index cheaper) | loss | tie |");
  lines.push("|---|---|---|---|");
  for (const w of data.winLossTie) lines.push(`| ${w.agent} | ${w.win} | ${w.loss} | ${w.tie} |`);
  lines.push("");

  lines.push("## Per-category × per-arm medians", "");
  lines.push("| Category | Arm | runs | tokens | cost $ | wall s | tool calls | correctness | index build s |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of data.cells) {
    lines.push(
      `| ${c.category} | ${c.arm} | ${c.runs} | ${c.tokensMedian} | ${fmt(c.costMedian, 4)} | ${fmt(c.wallMedian)} | ${c.toolCallsMedian} | ${fmt(c.correctnessMedian)} | ${fmt(c.indexBuildMedian)} |`,
    );
  }
  lines.push("");
  lines.push("_Index build time is reported alongside and is never subtracted from the token or wall figures._");
  return `${lines.join("\n")}\n`;
}

/** Write a dated report (results/YYYY-MM-DD-<name>.md) and return its path. */
export function writeReport(resultsDir: string, data: ReportData, name: string, date: string): string {
  const path = join(resultsDir, `${date}-${name}.md`);
  writeFileSync(path, renderMarkdown(data, name, date));
  return path;
}
