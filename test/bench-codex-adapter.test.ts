import { describe, expect, it } from "vitest";
import {
  buildCodexInvocation,
  CODEX_MODEL_PRICING,
  computeCost,
  parseCodexStream,
} from "../benchmarks/harness/adapters/codex";
import type { InvocationOptions } from "../benchmarks/harness/adapters/types";

const BASE: InvocationOptions = {
  prompt: "Where is greet defined?",
  arm: "codex-without",
  model: "gpt-5-codex",
};

/**
 * Stub Codex --json stream. The exact event shape drifts and MUST be
 * re-verified at run time (see codex.ts); this stub is the contract the
 * tolerant parser is written against (msg-wrapped events, cumulative tokens).
 */
const STREAM = [
  JSON.stringify({ msg: { type: "session_start" } }),
  JSON.stringify({ msg: { type: "mcp_tool_call", server: "code-index", tool: "find_symbol" } }),
  JSON.stringify({ msg: { type: "token_count", input_tokens: 900, output_tokens: 30, cached_input_tokens: 400 } }),
  JSON.stringify({ msg: { type: "exec_command", command: ["grep", "-rn", "greet", "src"] } }),
  JSON.stringify({ msg: { type: "mcp_tool_call", server: "code-index", tool: "get_chunk" } }),
  JSON.stringify({
    msg: { type: "token_count", input_tokens: 1400, output_tokens: 55, cached_input_tokens: 900 },
  }),
  JSON.stringify({ msg: { type: "agent_message", message: "src/greet.ts:5" } }),
  JSON.stringify({ msg: { type: "task_complete" } }),
].join("\n");

describe("Codex adapter: arm configuration (DEV-905 / QA-905)", () => {
  it("with-arm injects the code-index MCP server via -c overrides", () => {
    const { command, args } = buildCodexInvocation({
      ...BASE,
      arm: "codex-with",
      mcpConfigPath: "npx code-index serve .",
    });
    expect(command).toBe("codex");
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    const cIndex = args.indexOf("-c");
    expect(cIndex).toBeGreaterThan(-1);
    expect(args[cIndex + 1]).toBe("mcp_servers.code-index.command=npx code-index serve .");
  });

  it("without-arm injects NO mcp_servers override (strictly additive floor)", () => {
    const { args } = buildCodexInvocation({ ...BASE, arm: "codex-without" });
    expect(args.some((a) => a.startsWith("mcp_servers."))).toBe(false);
    expect(args).not.toContain("-c");
  });

  it("pins the model and edit tier flips the sandbox to workspace-write", () => {
    expect(buildCodexInvocation({ ...BASE, model: "o4-mini" }).args).toContain("o4-mini");
    expect(buildCodexInvocation({ ...BASE }).args[buildCodexInvocation({ ...BASE }).args.indexOf("--sandbox") + 1]).toBe(
      "read-only",
    );
    const edit = buildCodexInvocation({ ...BASE, editTier: true });
    expect(edit.args[edit.args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("with-arm without a launch command is a hard error", () => {
    expect(() => buildCodexInvocation({ ...BASE, arm: "codex-with" })).toThrow(/mcpConfigPath/);
  });
});

describe("Codex adapter: metric extraction (DEV-905 / QA-905)", () => {
  it("takes cumulative token counts from the LAST token event", () => {
    const { metrics } = parseCodexStream(STREAM);
    expect(metrics.tokensIn).toBe(1400);
    expect(metrics.tokensOut).toBe(55);
    expect(metrics.tokensCache).toBe(900);
    expect(metrics.turns).toBe(2); // two token events
  });

  it("counts tool calls and splits MCP vs baseline", () => {
    const { metrics } = parseCodexStream(STREAM);
    expect(metrics.toolCalls).toBe(3); // 2 mcp_tool_call + 1 exec_command
    expect(metrics.mcpCalls).toBe(2);
    expect(metrics.baselineCalls).toBe(1);
  });

  it("extracts the final answer from the agent_message event", () => {
    expect(parseCodexStream(STREAM).finalAnswer).toBe("src/greet.ts:5");
  });

  it("leaves costUsd null (Codex self-reports no cost)", () => {
    expect(parseCodexStream(STREAM).metrics.costUsd).toBeNull();
  });

  it("computeCost applies published pricing; unknown model -> null", () => {
    const { metrics } = parseCodexStream(STREAM);
    const cost = computeCost(metrics, "gpt-5-codex");
    const p = CODEX_MODEL_PRICING["gpt-5-codex"];
    expect(cost).toBeCloseTo((1400 / 1e6) * p.inputPerMTok + (55 / 1e6) * p.outputPerMTok, 9);
    expect(computeCost(metrics, "no-such-model")).toBeNull();
  });

  it("flags a completed stream vs a truncated one vs an errored one", () => {
    expect(parseCodexStream(STREAM).flags).toEqual([]);

    const truncated = STREAM.split("\n").slice(0, 3).join("\n");
    expect(parseCodexStream(truncated).flags).toContain("no_result");

    const errored = STREAM.replace('{"type":"task_complete"}', '{"type":"task_error"}');
    const flags = parseCodexStream(errored).flags;
    expect(flags).toContain("agent_error");
    expect(flags).not.toContain("no_result"); // an error is not also a truncation
  });

  it("tolerates top-level (unwrapped) events and malformed lines", () => {
    const unwrapped = [
      JSON.stringify({ type: "token_count", input_tokens: 10, output_tokens: 2 }),
      "{ broken",
      JSON.stringify({ type: "tool_call", name: "mcp__code-index__who_calls" }),
      JSON.stringify({ type: "task_complete" }),
    ].join("\n");
    const { metrics, flags } = parseCodexStream(unwrapped);
    expect(metrics.tokensIn).toBe(10);
    expect(metrics.mcpCalls).toBe(1); // classified by the mcp__ name prefix
    expect(flags).toEqual([]);
  });
});
