import { execFileSync } from "node:child_process";
import type { BenchTask } from "../tasks";

/**
 * LLM judge (benchmark.md#grading--judges, rung 3) — the scoped fallback for
 * free-form architecture-comprehension answers that no deterministic matcher
 * can decide. A separate, auditable script: fixed model, temperature 0, a
 * per-task rubric, and — critically — the judge sees the ANSWER KEY and the
 * agent's FINAL ANSWER ONLY, never the transcript, so verbosity and tool
 * choice can't bias it. JudgeInput has no transcript field: the answer-only
 * contract is enforced by the type, not by discipline.
 *
 * The model call is injected (JudgeInvoke) so `runSelfTest` is deterministic
 * in CI; the default invocation (claudeCliJudge) shells the pinned model.
 */

/** By construction: rubric + key + answer only. No transcript field exists. */
export interface JudgeInput {
  rubric: string;
  key: string;
  answer: string;
}

export interface JudgeResult {
  /** 0..1 */
  score: number;
  reason: string;
  /** Judge cost, tracked SEPARATELY from agent cost (benchmark.md). */
  costUsd: number | null;
}

export interface ModelReply {
  text: string;
  costUsd: number | null;
}

export type JudgeInvoke = (prompt: string) => Promise<ModelReply>;

/** Score at or above this is a pass for the pass/fail self-test fixtures. */
export const JUDGE_PASS_THRESHOLD = 0.7;

/**
 * The judge prompt. Deterministic given its inputs; contains the rubric, the
 * answer key, and the candidate answer — and nothing else. Instructs a
 * temperature-0-style strict JSON reply so parsing stays mechanical.
 */
export function buildJudgePrompt(input: JudgeInput): string {
  return [
    "You are grading one answer against a rubric and a reference answer key.",
    "Score how well the candidate answer satisfies the rubric, from 0.0 to 1.0.",
    "Judge ONLY the answer text below — you are given no transcript, tools, or process.",
    "",
    "## Rubric",
    input.rubric,
    "",
    "## Reference answer key",
    input.key,
    "",
    "## Candidate answer",
    input.answer,
    "",
    'Reply with ONLY a JSON object: {"score": <0..1>, "reason": "<one sentence>"}.',
  ].join("\n");
}

/** Extract {score, reason} from the model's reply; clamps score to [0,1]. */
export function parseJudgeReply(text: string): { score: number; reason: string } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`judge reply is not JSON: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(match[0]) as { score?: unknown; reason?: unknown };
  const score = typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
  if (!Number.isFinite(score)) throw new Error(`judge reply has no numeric score: ${match[0]}`);
  return {
    score: Math.max(0, Math.min(1, score)),
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

/** Run one judgement through the injected model. */
export async function runJudge(input: JudgeInput, invoke: JudgeInvoke): Promise<JudgeResult> {
  const reply = await invoke(buildJudgePrompt(input));
  const { score, reason } = parseJudgeReply(reply.text);
  return { score, reason, costUsd: reply.costUsd };
}

/** Only judge-grader tasks route to the judge (benchmark.md: lowest rung). */
export function shouldUseJudge(task: BenchTask): boolean {
  return task.grader.kind === "judge";
}

/**
 * Self-test fixtures (benchmark.md: "known-good and known-bad answers that
 * must score correctly"). Each pairs a rubric+key with a candidate answer and
 * whether the judge SHOULD pass it. Running these against the real model
 * catches a miscalibrated judge; running them against a stub in CI catches a
 * broken scoring pipeline.
 */
export interface SelfTestFixture {
  name: string;
  input: JudgeInput;
  shouldPass: boolean;
}

const LAYERING_RUBRIC =
  "Full credit only if the answer states the dependency direction CLI -> pipeline -> storage without inverting any edge.";
const LAYERING_KEY = "The CLI depends on the pipeline, which depends on the storage layer: CLI -> pipeline -> storage.";

export const JUDGE_SELFTEST_FIXTURES: SelfTestFixture[] = [
  {
    name: "layering-correct",
    input: {
      rubric: LAYERING_RUBRIC,
      key: LAYERING_KEY,
      answer: "The CLI calls into the pipeline, and the pipeline persists via the storage layer. Direction: CLI -> pipeline -> storage.",
    },
    shouldPass: true,
  },
  {
    name: "layering-inverted",
    input: {
      rubric: LAYERING_RUBRIC,
      key: LAYERING_KEY,
      answer: "Storage drives the pipeline, which drives the CLI: storage -> pipeline -> CLI.",
    },
    shouldPass: false,
  },
  {
    name: "layering-empty",
    input: { rubric: LAYERING_RUBRIC, key: LAYERING_KEY, answer: "I'm not sure how these relate." },
    shouldPass: false,
  },
];

export interface SelfTestResult {
  passed: boolean;
  cases: { name: string; score: number; shouldPass: boolean; ok: boolean }[];
}

/**
 * Run the self-test fixtures through a judge. `passed` is true only if EVERY
 * fixture lands on the correct side of the threshold — a judge that scores a
 * known-bad answer high fails the self-test.
 */
export async function runSelfTest(invoke: JudgeInvoke): Promise<SelfTestResult> {
  const cases = [];
  for (const fixture of JUDGE_SELFTEST_FIXTURES) {
    const { score } = await runJudge(fixture.input, invoke);
    const didPass = score >= JUDGE_PASS_THRESHOLD;
    cases.push({ name: fixture.name, score, shouldPass: fixture.shouldPass, ok: didPass === fixture.shouldPass });
  }
  return { passed: cases.every((c) => c.ok), cases };
}

export const JUDGE_MODEL = "claude-opus-4";

/**
 * `judge --selftest [model]` runs the fixtures through the live judge and
 * exits non-zero if any lands on the wrong side of the threshold — the
 * auditable calibration check the spec asks the judge to ship with.
 */
export async function main(argv: string[]): Promise<number> {
  if (argv[0] !== "--selftest") {
    process.stderr.write("usage: judge --selftest [model]\n");
    return 1;
  }
  const result = await runSelfTest(claudeCliJudge(argv[1] ?? JUDGE_MODEL));
  for (const c of result.cases) {
    process.stdout.write(`${c.ok ? "PASS" : "FAIL"} ${c.name} score=${c.score.toFixed(2)} (want ${c.shouldPass ? "≥" : "<"}${JUDGE_PASS_THRESHOLD})\n`);
  }
  process.stdout.write(result.passed ? "selftest: PASS\n" : "selftest: FAIL\n");
  return result.passed ? 0 : 1;
}

/**
 * Default judge invocation: the pinned model via the Claude CLI, headless,
 * NO tools (the judge only reasons over the prompt text). Temperature 0 is
 * requested through the strict-JSON instruction; the CLI version and model
 * are recorded by the caller. Not exercised in CI (needs the live CLI).
 */
export function claudeCliJudge(model: string = JUDGE_MODEL): JudgeInvoke {
  return async (prompt) => {
    const stdout = execFileSync(
      "claude",
      ["-p", prompt, "--model", model, "--output-format", "json", "--allowedTools", ""],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as { result?: string; total_cost_usd?: number };
    return { text: result.result ?? stdout, costUsd: result.total_cost_usd ?? null };
  };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`judge: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
