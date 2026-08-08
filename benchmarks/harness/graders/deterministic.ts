import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExactGrader, PathLineSetGrader, SetGrader, TestDiffGrader } from "../../tasks";

/**
 * Deterministic graders (benchmark.md#grading--judges, rungs 1–2). Stdlib
 * only, no network: matchers are pure functions over the agent's final
 * answer; the edit grader reads a PRESERVED workspace (test command + diff
 * assertions) — re-scoring never re-runs agent sessions.
 */

export interface GradeResult {
  /** 0..1 */
  score: number;
  /** Human-readable failure detail for reports; empty when perfect. */
  notes: string[];
}

/** Answer lines: trimmed, blanks dropped — every Q&A prompt pins a one-per-line format. */
function answerLines(answer: string): string[] {
  return answer
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Rung 1a: exact match (whitespace-normalized single value). */
export function gradeExact(answer: string, grader: ExactGrader): GradeResult {
  const got = answer.trim();
  if (got === grader.key.trim()) return { score: 1, notes: [] };
  return { score: 0, notes: [`expected ${JSON.stringify(grader.key)}, got ${JSON.stringify(got)}`] };
}

function f1(matched: number, answered: number, expected: number): number {
  if (answered === 0 || expected === 0) return 0;
  const precision = matched / answered;
  const recall = matched / expected;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** Rung 1b: set match — F1 over the expected set (partial credit). */
export function gradeSet(answer: string, grader: SetGrader): GradeResult {
  const got = new Set(answerLines(answer));
  const expected = new Set(grader.key.map((k) => k.trim()));
  let matched = 0;
  for (const entry of expected) if (got.has(entry)) matched += 1;
  const score = f1(matched, got.size, expected.size);
  const notes: string[] = [];
  for (const entry of expected) if (!got.has(entry)) notes.push(`missing: ${entry}`);
  for (const entry of got) if (!expected.has(entry)) notes.push(`extra: ${entry}`);
  return { score, notes: score === 1 ? [] : notes };
}

export const DEFAULT_LINE_SLOP = 2;

interface PathLine {
  path: string;
  line: number;
  raw: string;
}

function parsePathLine(raw: string): PathLine | null {
  const match = /^(.+):(\d+)$/.exec(raw);
  return match ? { path: match[1], line: Number(match[2]), raw } : null;
}

/**
 * Rung 1c: path:line-set match with ± line-slop tolerance. Greedy one-to-one
 * matching after sorting both sides by (path, line) — the sort makes the
 * greedy pass optimal, so overlapping slop windows on one path can't
 * under-credit. Each expected entry consumes at most one answered entry.
 *
 * Parse tolerance: answer lines that are not `path:line` are counted as
 * (unmatchable) extras against precision, so verbose prose padding a correct
 * list still costs F1 — no free leniency.
 */
export function gradePathLineSet(answer: string, grader: PathLineSetGrader): GradeResult {
  const slop = grader.lineSlop ?? DEFAULT_LINE_SLOP;
  const rawAnswers = answerLines(answer);
  const parsedAnswers = rawAnswers.map(parsePathLine);
  const unparsable = parsedAnswers.filter((p) => p === null).length;
  const byPathLine = (a: PathLine, b: PathLine): number =>
    a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1;
  const answered = parsedAnswers.filter((p): p is PathLine => p !== null).sort(byPathLine);
  const expected = grader.key
    .map(parsePathLine)
    .filter((p): p is PathLine => p !== null)
    .sort(byPathLine);

  const used = new Set<number>();
  let matched = 0;
  const notes: string[] = [];
  for (const want of expected) {
    const index = answered.findIndex(
      (got, i) => !used.has(i) && got.path === want.path && Math.abs(got.line - want.line) <= slop,
    );
    if (index === -1) {
      notes.push(`missing: ${want.raw} (±${slop})`);
    } else {
      used.add(index);
      matched += 1;
    }
  }
  answered.forEach((got, i) => {
    if (!used.has(i)) notes.push(`extra: ${got.raw}`);
  });
  // Unparsable answer lines count against precision (extras in the denominator).
  const score = f1(matched, answered.length + unparsable, expected.length);
  return { score, notes: score === 1 ? [] : notes };
}

/**
 * The workspace diff the edit-tier assertions run against: tracked changes
 * versus HEAD plus the full content of untracked files (an agent may add
 * files). Read-only — the workspace's git index is never touched.
 */
export function workspaceDiff(workspaceDir: string): string {
  const run = (...args: string[]): string =>
    execFileSync("git", args, { cwd: workspaceDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let diff = run("diff", "HEAD");
  const untracked = run("ls-files", "--others", "--exclude-standard")
    .split("\n")
    .filter((l) => l.length > 0);
  for (const file of untracked) {
    const content = readFileSync(join(workspaceDir, file), "utf8");
    diff += `\n+++ b/${file} (untracked)\n${content
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n")}\n`;
  }
  return diff;
}

/**
 * The resulting workspace tree (tracked + untracked file contents), for
 * must-not-match assertions.
 */
export function workspaceContent(workspaceDir: string): string {
  const run = (...args: string[]): string =>
    execFileSync("git", args, { cwd: workspaceDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = [
    ...run("ls-files").split("\n"),
    ...run("ls-files", "--others", "--exclude-standard").split("\n"),
  ].filter((l) => l.length > 0);
  return files
    .map((file) => `=== ${file} ===\n${readFileSync(join(workspaceDir, file), "utf8")}`)
    .join("\n");
}

/**
 * Rung 2: edit-tier grader — the task's designated test subset must pass in
 * the preserved workspace, and the diff assertions must hold. Binary score.
 *
 * Assertion semantics: must-match asserts the change HAPPENED, so it runs
 * against the diff; must-not-match asserts nothing was LEFT BEHIND, so it
 * runs against the resulting tree — the spec's own example (a rename must
 * leave no old-name reference) is a final-state property, and a plain diff
 * check would false-positive on the rename's legitimate deletion lines.
 */
export function gradeEdit(workspaceDir: string, grader: TestDiffGrader): GradeResult {
  const notes: string[] = [];

  // Capture the agent's edit BEFORE running the test subset, so a test that
  // writes non-gitignored artifacts can't pollute the diff/tree assertions.
  const diff = workspaceDiff(workspaceDir);
  const tree = workspaceContent(workspaceDir);

  const [command, ...args] = grader.testCommand;
  try {
    execFileSync(command, args, { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (error) {
    notes.push(`test subset failed: ${(error as Error).message.split("\n")[0]}`);
  }

  for (const source of grader.mustMatch) {
    if (!new RegExp(source, "m").test(diff)) notes.push(`must-match absent from diff: /${source}/`);
  }
  for (const source of grader.mustNotMatch) {
    if (new RegExp(source, "m").test(tree)) notes.push(`must-not-match present in workspace: /${source}/`);
  }

  return { score: notes.length === 0 ? 1 : 0, notes };
}
