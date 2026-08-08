import { describe, expect, it } from "vitest";
import {
  buildJudgePrompt,
  JUDGE_PASS_THRESHOLD,
  JUDGE_SELFTEST_FIXTURES,
  JudgeInvoke,
  parseJudgeReply,
  runJudge,
  runSelfTest,
  shouldUseJudge,
} from "../benchmarks/judge/judge";
import type { BenchTask } from "../benchmarks/tasks";

/**
 * QA-907: --selftest passes/fails correctly; the judge input provably
 * excludes transcript content; deterministic-grader tasks never route to
 * the judge.
 */

/** A plausible judge: rewards the correct dependency direction, else low. */
const calibratedJudge: JudgeInvoke = async (prompt) => {
  const answerSection = prompt.split("## Candidate answer")[1] ?? "";
  const good = /CLI\s*->\s*pipeline\s*->\s*storage/i.test(answerSection);
  return { text: JSON.stringify({ score: good ? 0.95 : 0.1, reason: "test" }), costUsd: 0.002 };
};

describe("LLM judge (DEV-907 / QA-907)", () => {
  it("buildJudgePrompt includes rubric, key, and answer — and cannot include a transcript", () => {
    const prompt = buildJudgePrompt({ rubric: "R-TEXT", key: "K-TEXT", answer: "A-TEXT" });
    expect(prompt).toContain("R-TEXT");
    expect(prompt).toContain("K-TEXT");
    expect(prompt).toContain("A-TEXT");
    // The JudgeInput type has no transcript field, so nothing else can leak;
    // the prompt explicitly tells the judge it has no transcript.
    expect(prompt).toContain("no transcript");
  });

  it("the judge input, by type, carries only the final answer (never the transcript)", () => {
    // A "run" with a verbose transcript: only finalAnswer may reach the judge.
    const run = { finalAnswer: "CLI -> pipeline -> storage", transcript: "SECRET-TOOL-CALLS-AND-THOUGHTS" };
    const prompt = buildJudgePrompt({ rubric: "r", key: "k", answer: run.finalAnswer });
    expect(prompt).toContain("CLI -> pipeline -> storage");
    expect(prompt).not.toContain("SECRET-TOOL-CALLS-AND-THOUGHTS");
  });

  it("parseJudgeReply extracts and clamps the score, tolerating surrounding prose", () => {
    expect(parseJudgeReply('{"score": 0.8, "reason": "ok"}')).toEqual({ score: 0.8, reason: "ok" });
    expect(parseJudgeReply('Here is my verdict: {"score": 1.5, "reason": "x"} done').score).toBe(1); // clamped
    expect(parseJudgeReply('{"score": -3, "reason": "y"}').score).toBe(0); // clamped
    expect(() => parseJudgeReply("no json here")).toThrow(/not JSON/);
    expect(() => parseJudgeReply('{"reason":"no score"}')).toThrow(/numeric score/);
  });

  it("runJudge returns score, reason, and a SEPARATELY-tracked cost", async () => {
    const result = await runJudge(
      { rubric: "r", key: "k", answer: "CLI -> pipeline -> storage" },
      calibratedJudge,
    );
    expect(result.score).toBeCloseTo(0.95, 5);
    expect(result.costUsd).toBe(0.002); // judge cost, tracked apart from agent cost
  });

  it("--selftest PASSES against a calibrated judge (known-good high, known-bad low)", async () => {
    const result = await runSelfTest(calibratedJudge);
    expect(result.passed).toBe(true);
    for (const c of result.cases) expect(c.ok, c.name).toBe(true);
    // The fixtures genuinely include both sides.
    expect(JUDGE_SELFTEST_FIXTURES.some((f) => f.shouldPass)).toBe(true);
    expect(JUDGE_SELFTEST_FIXTURES.some((f) => !f.shouldPass)).toBe(true);
  });

  it("--selftest FAILS against a miscalibrated judge (catches a broken judge)", async () => {
    const alwaysHigh: JudgeInvoke = async () => ({ text: '{"score": 1, "reason": "rubber stamp"}', costUsd: 0 });
    const result = await runSelfTest(alwaysHigh);
    expect(result.passed).toBe(false);
    // The known-bad fixtures are the ones it fails on.
    const failed = result.cases.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain("layering-inverted");
    expect(failed).toContain("layering-empty");
  });

  it("the pass threshold sits strictly between the calibrated good/bad scores", async () => {
    const good = await runJudge(JUDGE_SELFTEST_FIXTURES[0].input, calibratedJudge);
    const bad = await runJudge(JUDGE_SELFTEST_FIXTURES[1].input, calibratedJudge);
    expect(good.score).toBeGreaterThanOrEqual(JUDGE_PASS_THRESHOLD);
    expect(bad.score).toBeLessThan(JUDGE_PASS_THRESHOLD);
  });

  it("only judge-grader tasks route to the judge", () => {
    const base: BenchTask = {
      id: "x",
      category: "architecture",
      style: "qa",
      target: "self",
      prompt: "p Answer with a single line.",
      grader: { kind: "judge", rubric: "r", key: "k" },
      timeoutSec: 300,
      tags: ["authored", "medium", "ts"],
    };
    expect(shouldUseJudge(base)).toBe(true);
    expect(shouldUseJudge({ ...base, grader: { kind: "exact", key: "a" } })).toBe(false);
    expect(shouldUseJudge({ ...base, grader: { kind: "path-line-set", key: ["a:1"] } })).toBe(false);
    expect(shouldUseJudge({ ...base, grader: { kind: "set", key: ["a"] } })).toBe(false);
  });
});
