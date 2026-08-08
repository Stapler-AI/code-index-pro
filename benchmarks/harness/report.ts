import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasSkill, isWithArm } from "./adapters/types";
import type { Arm } from "./adapters/types";
import type { RunRecord } from "./run";

/**
 * Reporting (benchmark.md#results--reporting). `bench report` reads the
 * append-only results/runs.jsonl and emits dated markdown: per-category ×
 * per-arm median tables, a three-way per-agent token-ratio headline
 * (with/without, with-skill/with, with-skill/without) + correctness delta and
 * adoption, a structure-heavy subset row (gate G1), win/loss/tie counts per
 * task pair for two pairings, and index build time shown ALONGSIDE — never
 * netted out of the token figures.
 *
 * The aggregation (buildReport) is pure and testable; renderMarkdown only
 * formats it.
 */

export type Agent = "claude" | "codex";

function agentOf(arm: Arm): Agent {
  return arm.startsWith("claude") ? "claude" : "codex";
}

/**
 * The three arm roles within one agent. `without` = baseline; `with` = tools,
 * no skill (`isWithArm && !hasSkill`); `with-skill` = tools + injected
 * instructions (`hasSkill`). Used to select the two arms of each pairwise ratio.
 */
type ArmRole = "without" | "with" | "with-skill";
function armRole(arm: Arm): ArmRole {
  if (hasSkill(arm)) return "with-skill";
  if (isWithArm(arm)) return "with";
  return "without";
}

/**
 * FR-701 / G1 gated categories: the structure-heavy subset over which the
 * headline ratios are recomputed so the gate is readable directly from the report.
 */
const STRUCTURE_HEAVY_CATEGORIES = ["callers-impact", "cross-file-navigation", "rename-refactor"];

/** Total context tokens for the headline ratio (in + out + cache). */
export function totalTokens(r: RunRecord): number {
  return r.metrics.tokens_in + r.metrics.tokens_out + r.metrics.tokens_cache;
}

/**
 * FR-706 flagged-run exclusion. A run is excluded from all ratio and win/loss
 * aggregation if it carries a failure flag (`no_result` / `agent_error` /
 * `timeout`) or recorded zero tokens (the codex zero-token failure mode). These
 * silently poisoned medians before; they are now dropped and counted.
 */
const EXCLUSION_FLAGS = ["no_result", "agent_error", "timeout"];
export function isExcludedRun(r: RunRecord): boolean {
  if (r.flags.some((f) => EXCLUSION_FLAGS.includes(f))) return true;
  return totalTokens(r) === 0;
}

/**
 * FR-707 diagnostic exclusion. Runs where the skill was injected via
 * `--append-system-prompt` (BENCH_SKILL_MODE=system-prompt) are not headline
 * data; they are pulled out and surfaced separately.
 */
export function isDiagnosticRun(r: RunRecord): boolean {
  return r.flags.includes("skill_mode:system-prompt");
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
  /**
   * FR-703 token composition — medians of the split beside the total.
   * `freshIn` = uncached input (tokens_in), `out` = tokens_out (both always
   * present). `cacheRead` = tokens_cache_read, which legacy records lack; it is
   * `null` there so the renderer (SK-D06) can show `—`.
   */
  freshInMedian: number;
  cacheReadMedian: number | null;
  outMedian: number;
  costMedian: number | null;
  wallMedian: number | null;
  toolCallsMedian: number;
  correctnessMedian: number;
  indexBuildMedian: number | null;
}

/**
 * FR-702 adoption — per arm, median of per-run `mcp_calls / tool_calls`
 * (defined as 0 when a run made no tool calls).
 */
export interface ArmAdoption {
  arm: Arm;
  adoptionMedian: number;
}

/** FR-706 excluded-run counts, surfaced per agent × arm for the report. */
export interface ExcludedCount {
  agent: Agent;
  arm: Arm;
  excluded: number;
}

/**
 * FR-701 three-way per-agent headline. The three token ratios are medians of
 * per-task PAIRED ratios (see `pairedRatio`) within the agent; each is `null`
 * when its required arm is absent (legacy four-arm data lacks the `with-skill`
 * arm, so `withSkillOverWith` / `withSkillOverWithout` are `null` there). The
 * `skillCorrectnessDelta` (skill vs without) drives the FR-705 regression
 * marker; `regression` is a real value < 0 only. It sits structurally beside
 * the headline ratio in the shared row formatter — a ratio is never rendered
 * without its correctness column.
 *
 * The `tokenRatio` / `withTokensMedian` / `withoutTokensMedian` /
 * `correctnessDelta` fields are the pre-D06 with/without figures, retained for
 * back-compat (the with/without column keeps its median-of-medians reading;
 * `withOverWithout` is the paired refinement rendered in the table).
 */
export interface AgentHeadline {
  agent: Agent;
  /** with/without paired-ratio median (FR-701); null if either arm is absent. */
  withOverWithout: number | null;
  /** with-skill/with paired-ratio median; null if either arm is absent. */
  withSkillOverWith: number | null;
  /** with-skill/without paired-ratio median — the project headline; null if absent. */
  withSkillOverWithout: number | null;
  /** median(score_with-skill) - median(score_without); null when the skill arm is absent. */
  skillCorrectnessDelta: number | null;
  /** median mcp_calls/tool_calls over the with-skill arm's included runs; null if absent. */
  adoptionMedian: number | null;
  /** True iff skillCorrectnessDelta is a real value < 0 — FR-705 regression marker. */
  regression: boolean;
  /** Pre-D06 with/without ratio (median of medians); null if a side is missing. */
  tokenRatio: number | null;
  withTokensMedian: number;
  withoutTokensMedian: number;
  /** median(score_with) - median(score_without) (pre-D06 with-arm reading). */
  correctnessDelta: number;
  /** with-family index build median (reported alongside, never netted out). */
  indexBuildMedian: number | null;
}

/**
 * Win/loss/tie for the `with vs without` pairing per agent (numerator strictly
 * cheaper = win). Shape unchanged from pre-D06. The `with-skill vs without`
 * pairing (FR-704) is reported separately in `winLossTieSkill`.
 */
export interface WinLossTie {
  agent: Agent;
  win: number;
  loss: number;
  tie: number;
}

export interface ReportData {
  cells: CellStats[];
  headlines: AgentHeadline[];
  /**
   * FR-701 structure-heavy subset: the same three-way headline recomputed over
   * only `callers-impact` + `cross-file-navigation` + `rename-refactor` task
   * pairs, so gate G1 is readable directly. One entry per agent with such runs.
   */
  structureHeavy: AgentHeadline[];
  /** FR-704 `with vs without` win/loss/tie per agent. */
  winLossTie: WinLossTie[];
  /** FR-704 `with-skill vs without` win/loss/tie per agent. */
  winLossTieSkill: WinLossTie[];
  /** FR-702 adoption per arm (over included, non-diagnostic runs). */
  adoption: ArmAdoption[];
  /** FR-706 excluded-run counts per agent × arm (only non-zero entries). */
  excluded: ExcludedCount[];
  /**
   * FR-707 diagnostic runs (skill_mode:system-prompt), held out of the headline
   * and kept for separate display by SK-D06's render.
   */
  diagnosticRuns: RunRecord[];
  totalRuns: number;
}

/**
 * Adoption of the code-index tools for one run: MCP calls as a fraction of all
 * tool calls. Undefined-safe over legacy records (no cast): `mcp_calls` may be
 * missing on very old rows; a run with no tool calls is 0 adoption by spec.
 */
function runAdoption(r: RunRecord): number {
  const toolCalls = r.metrics.tool_calls ?? 0;
  if (toolCalls === 0) return 0;
  return (r.metrics.mcp_calls ?? 0) / toolCalls;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * Median of per-task PAIRED token ratios for one arm pair within one agent
 * (FR-701). For every `task_id` where BOTH the numerator and denominator arm
 * have at least one included run, the per-task ratio is
 * `median(numerator tokens for task) / median(denominator tokens for task)`
 * (a task whose denominator median is 0 is skipped — undefined ratio). The
 * pair's ratio is the median of those per-task ratios. Returns `null` when no
 * task has runs on both arms (e.g. the numerator arm is absent in legacy data),
 * so the renderer shows `—` rather than a fabricated number.
 *
 * This refines the earlier median-of-medians quotient: pairing per task first
 * keeps each ratio causal (same task, same target) before taking the median.
 * Exported so SK-Q06 can pin the definition directly.
 */
export function pairedRatio(numerator: RunRecord[], denominator: RunRecord[]): number | null {
  const numByTask = groupBy(numerator, (r) => r.task_id);
  const denByTask = groupBy(denominator, (r) => r.task_id);
  const ratios: number[] = [];
  for (const [taskId, numRuns] of numByTask) {
    const denRuns = denByTask.get(taskId);
    if (!denRuns) continue;
    const denMed = median(denRuns.map(totalTokens));
    if (denMed === 0) continue;
    ratios.push(median(numRuns.map(totalTokens)) / denMed);
  }
  return ratios.length === 0 ? null : median(ratios);
}

/**
 * Win/loss/tie over the per-task pairing (FR-704): for each task with runs on
 * both arms, compare numerator-arm median tokens to denominator-arm median
 * tokens. Strictly fewer = win for the numerator (index/skill cheaper).
 */
function winLoss(numerator: RunRecord[], denominator: RunRecord[]): { win: number; loss: number; tie: number } {
  const numByTask = groupBy(numerator, (r) => r.task_id);
  const denByTask = groupBy(denominator, (r) => r.task_id);
  let win = 0;
  let loss = 0;
  let tie = 0;
  for (const [taskId, numRuns] of numByTask) {
    const denRuns = denByTask.get(taskId);
    if (!denRuns) continue;
    const nm = median(numRuns.map(totalTokens));
    const dm = median(denRuns.map(totalTokens));
    if (nm < dm) win += 1;
    else if (nm > dm) loss += 1;
    else tie += 1;
  }
  return { win, loss, tie };
}

/**
 * The three-way headline for one agent over a given run set (all included runs,
 * or the structure-heavy subset). Pure; returns `null` if the set is empty.
 */
function headlineFor(agent: Agent, runs: RunRecord[]): AgentHeadline | null {
  if (runs.length === 0) return null;
  const withoutRuns = runs.filter((r) => armRole(r.arm) === "without");
  const withRuns = runs.filter((r) => armRole(r.arm) === "with");
  const skillRuns = runs.filter((r) => armRole(r.arm) === "with-skill");

  // skillCorrectnessDelta / adoption are only defined when the skill arm is
  // present; the marker (regression) can therefore never fire without a real
  // delta, and the with/without column keeps its correctness reading beside it.
  const skillCorrectnessDelta =
    skillRuns.length > 0 && withoutRuns.length > 0
      ? median(skillRuns.map((r) => r.score)) - median(withoutRuns.map((r) => r.score))
      : null;
  const adoptionMedian = skillRuns.length > 0 ? median(skillRuns.map(runAdoption)) : null;
  // Index build is a with-family property; prefer the skill arm, fall back to plain with.
  const indexBuildMedian = medianOrNull(
    (skillRuns.length > 0 ? skillRuns : withRuns).map((r) => r.metrics.index_build_s ?? null),
  );

  // Pre-D06 with/without figures (median of medians), retained for back-compat.
  const withTok = median(withRuns.map(totalTokens));
  const withoutTok = median(withoutRuns.map(totalTokens));

  return {
    agent,
    withOverWithout: pairedRatio(withRuns, withoutRuns),
    withSkillOverWith: pairedRatio(skillRuns, withRuns),
    withSkillOverWithout: pairedRatio(skillRuns, withoutRuns),
    skillCorrectnessDelta,
    adoptionMedian,
    regression: skillCorrectnessDelta !== null && skillCorrectnessDelta < 0,
    tokenRatio: withRuns.length > 0 && withoutRuns.length > 0 && withoutTok !== 0 ? withTok / withoutTok : null,
    withTokensMedian: withTok,
    withoutTokensMedian: withoutTok,
    correctnessDelta: median(withRuns.map((r) => r.score)) - median(withoutRuns.map((r) => r.score)),
    indexBuildMedian,
  };
}

/** Pure aggregation of raw run records into report figures. */
export function buildReport(records: RunRecord[]): ReportData {
  // FR-707: diagnostic runs are held out of every headline/cell aggregation and
  // surfaced separately. FR-706: flagged / zero-token runs are excluded from all
  // ratio and win/loss aggregation and counted. What remains ("included") is the
  // only data that feeds cells, ratios, win/loss, and adoption.
  const diagnosticRuns = records.filter(isDiagnosticRun);
  const headlinePool = records.filter((r) => !isDiagnosticRun(r));
  const included = headlinePool.filter((r) => !isExcludedRun(r));

  // FR-706: excluded counts per agent × arm (non-zero entries only).
  const excluded: ExcludedCount[] = [];
  for (const [, group] of groupBy(headlinePool.filter(isExcludedRun), (r) => `${agentOf(r.arm)}|${r.arm}`)) {
    excluded.push({ agent: agentOf(group[0].arm), arm: group[0].arm, excluded: group.length });
  }
  excluded.sort((a, b) => (a.agent === b.agent ? a.arm.localeCompare(b.arm) : a.agent.localeCompare(b.agent)));

  // Per-category × per-arm median cells (included runs only).
  const cells: CellStats[] = [];
  for (const [, group] of groupBy(included, (r) => `${categoryResolver(r.task_id)}|${r.arm}`)) {
    const first = group[0];
    cells.push({
      category: categoryResolver(first.task_id),
      arm: first.arm,
      runs: group.length,
      tokensMedian: median(group.map(totalTokens)),
      // FR-703 composition: fresh-in / cache-read / out. tokens_in and
      // tokens_out are present on every record (legacy included); cacheRead
      // uses the split, absent on legacy rows — undefined-safe, contributes
      // null so the renderer shows `—`.
      freshInMedian: median(group.map((r) => r.metrics.tokens_in)),
      cacheReadMedian: medianOrNull(group.map((r) => r.metrics.tokens_cache_read ?? null)),
      outMedian: median(group.map((r) => r.metrics.tokens_out)),
      costMedian: medianOrNull(group.map((r) => r.metrics.cost_usd)),
      wallMedian: medianOrNull(group.map((r) => r.metrics.wall_s)),
      toolCallsMedian: median(group.map((r) => r.metrics.tool_calls)),
      correctnessMedian: median(group.map((r) => r.score)),
      indexBuildMedian: medianOrNull(group.map((r) => r.metrics.index_build_s)),
    });
  }
  cells.sort((a, b) => (a.category === b.category ? a.arm.localeCompare(b.arm) : a.category.localeCompare(b.category)));

  // FR-702 adoption: per arm, median of per-run mcp_calls/tool_calls (included).
  const adoption: ArmAdoption[] = [];
  for (const [, group] of groupBy(included, (r) => r.arm)) {
    adoption.push({ arm: group[0].arm, adoptionMedian: median(group.map(runAdoption)) });
  }
  adoption.sort((a, b) => a.arm.localeCompare(b.arm));

  // Per-agent three-way headline + structure-heavy subset + two-pairing W/L/T,
  // all over paired ratios within one agent's included runs.
  const headlines: AgentHeadline[] = [];
  const structureHeavy: AgentHeadline[] = [];
  const winLossTie: WinLossTie[] = [];
  const winLossTieSkill: WinLossTie[] = [];
  for (const agent of ["claude", "codex"] as Agent[]) {
    const agentRuns = included.filter((r) => agentOf(r.arm) === agent);
    if (agentRuns.length === 0) continue;

    const headline = headlineFor(agent, agentRuns);
    if (headline) headlines.push(headline);

    // Structure-heavy subset: same three-way ratios over the G1 categories only.
    const subsetRuns = agentRuns.filter((r) => STRUCTURE_HEAVY_CATEGORIES.includes(categoryResolver(r.task_id)));
    const subsetHeadline = headlineFor(agent, subsetRuns);
    if (subsetHeadline) structureHeavy.push(subsetHeadline);

    // FR-704 win/loss/tie for both pairings, same per-task pairing as the ratios.
    const withoutRuns = agentRuns.filter((r) => armRole(r.arm) === "without");
    const withRuns = agentRuns.filter((r) => armRole(r.arm) === "with");
    const skillRuns = agentRuns.filter((r) => armRole(r.arm) === "with-skill");
    winLossTie.push({ agent, ...winLoss(withRuns, withoutRuns) });
    winLossTieSkill.push({ agent, ...winLoss(skillRuns, withoutRuns) });
  }

  return {
    cells,
    headlines,
    structureHeavy,
    winLossTie,
    winLossTieSkill,
    adoption,
    excluded,
    diagnosticRuns,
    totalRuns: records.length,
  };
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

export function readRuns(path: string): RunRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunRecord);
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? "—" : n.toFixed(digits);
}

function fmtDelta(n: number | null): string {
  if (n === null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

/** FR-705 marker text; sole source so the marker cannot vary by render path. */
const REGRESSION_MARKER = "⚠ correctness regression";

// The token-ratio columns and the correctness column are one structure: the
// correctness (skill vs without) cell — with its FR-705 marker — is emitted in
// the SAME row as the three ratios by the single formatter below, so no render
// path can print a ratio without the correctness figure beside it.
const HEADLINE_HEADER =
  "| Agent | token ratio with/without | with-skill/with | with-skill/without | correctness Δ (skill vs without) | adoption (skill) | index build s |";
const HEADLINE_SEP = "|---|---|---|---|---|---|---|";

/**
 * Render one three-way headline row. The correctness column (with its FR-705
 * regression marker) is emitted structurally in the SAME row as the ratios, so
 * no ratio can ever be shown without its correctness figure beside it. Shared
 * by the headline and the structure-heavy subset tables (single formatter).
 */
function headlineRow(h: AgentHeadline): string {
  const correctness = `${fmtDelta(h.skillCorrectnessDelta)}${h.regression ? ` ${REGRESSION_MARKER}` : ""}`;
  return `| ${h.agent} | ${fmt(h.withOverWithout)} | ${fmt(h.withSkillOverWith)} | ${fmt(h.withSkillOverWithout)} | ${correctness} | ${fmt(h.adoptionMedian)} | ${fmt(h.indexBuildMedian)} |`;
}

function winLossRow(w: WinLossTie): string {
  return `| ${w.agent} | ${w.win} | ${w.loss} | ${w.tie} |`;
}

export function renderMarkdown(data: ReportData, name: string, date: string): string {
  const lines: string[] = [`# Benchmark report: ${name}`, "", `Date: ${date} · Runs: ${data.totalRuns}`, ""];

  lines.push("## Headline — three-way token ratios (per agent)", "");
  lines.push("Ratios are medians of per-task paired ratios within one agent. `—` = arm absent.", "");
  lines.push(HEADLINE_HEADER, HEADLINE_SEP);
  for (const h of data.headlines) lines.push(headlineRow(h));
  lines.push("");

  lines.push("## Structure-heavy subset (gate G1: callers-impact + cross-file-navigation + rename-refactor)", "");
  if (data.structureHeavy.length > 0) {
    lines.push(HEADLINE_HEADER, HEADLINE_SEP);
    for (const h of data.structureHeavy) lines.push(headlineRow(h));
  } else {
    lines.push("_No runs in the structure-heavy categories._");
  }
  lines.push("");

  lines.push("## Win / loss / tie per task pair (token cost, per agent)", "");
  lines.push("### with vs without", "");
  lines.push("| Agent | win (index cheaper) | loss | tie |");
  lines.push("|---|---|---|---|");
  for (const w of data.winLossTie) lines.push(winLossRow(w));
  lines.push("");
  lines.push("### with-skill vs without", "");
  lines.push("| Agent | win (skill cheaper) | loss | tie |");
  lines.push("|---|---|---|---|");
  for (const w of data.winLossTieSkill) lines.push(winLossRow(w));
  lines.push("");

  lines.push("## Per-category × per-arm medians", "");
  lines.push(
    "| Category | Arm | runs | tokens | fresh-in | cache-read | out | cost $ | wall s | tool calls | correctness | index build s |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of data.cells) {
    lines.push(
      `| ${c.category} | ${c.arm} | ${c.runs} | ${c.tokensMedian} | ${c.freshInMedian} | ${fmt(c.cacheReadMedian, 0)} | ${c.outMedian} | ${fmt(c.costMedian, 4)} | ${fmt(c.wallMedian)} | ${c.toolCallsMedian} | ${fmt(c.correctnessMedian)} | ${fmt(c.indexBuildMedian)} |`,
    );
  }
  lines.push("");

  if (data.excluded.length > 0) {
    lines.push("## Excluded runs (flagged / zero-token; dropped from all ratios)", "");
    lines.push("| Agent | Arm | excluded |");
    lines.push("|---|---|---|");
    for (const e of data.excluded) lines.push(`| ${e.agent} | ${e.arm} | ${e.excluded} |`);
    lines.push("");
  }

  if (data.diagnosticRuns.length > 0) {
    lines.push("## Diagnostic runs — `skill_mode:system-prompt` (excluded from the headline)", "");
    lines.push(`${data.diagnosticRuns.length} run(s) injected the skill via \`--append-system-prompt\`. These are`);
    lines.push("held out of every headline/subset ratio and shown here only for content-vs-trigger diagnosis.", "");
    lines.push("| Run | Task | Arm | tokens | correctness |");
    lines.push("|---|---|---|---|---|");
    for (const r of data.diagnosticRuns) {
      lines.push(`| ${r.run_id} | ${r.task_id} | ${r.arm} | ${totalTokens(r)} | ${fmt(r.score)} |`);
    }
    lines.push("");
  }

  lines.push("_Index build time is reported alongside and is never subtracted from the token or wall figures._");
  return `${lines.join("\n")}\n`;
}

/** Write a dated report (results/YYYY-MM-DD-<name>.md) and return its path. */
export function writeReport(resultsDir: string, data: ReportData, name: string, date: string): string {
  const path = join(resultsDir, `${date}-${name}.md`);
  writeFileSync(path, renderMarkdown(data, name, date));
  return path;
}
