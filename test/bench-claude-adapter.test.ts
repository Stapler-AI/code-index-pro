import { describe, expect, it } from "vitest";
import {
  benchMcpConfig,
  buildClaudeInvocation,
  CLAUDE_BASELINE_TOOLS,
  parseClaudeStream,
} from "../benchmarks/harness/adapters/claude";
import type { InvocationOptions } from "../benchmarks/harness/adapters/types";

const BASE: InvocationOptions = {
  prompt: "Where is greet defined?",
  arm: "claude-without",
  model: "claude-sonnet-4",
};

/** A realistic stream-json transcript: init, tool uses, then the result. */
const STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "x" }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", name: "mcp__code-index__find_symbol", input: { name: "greet" } },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "greet" } }] },
  }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "mcp__code-index__get_chunk", input: { chunk_id: 1 } }] },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "src/greet.ts:5",
    total_cost_usd: 0.0123,
    num_turns: 3,
    duration_ms: 4200,
    usage: {
      input_tokens: 1500,
      output_tokens: 80,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 1000,
    },
  }),
].join("\n");

describe("Claude adapter: arm configuration (DEV-904 / QA-904)", () => {
  it("with-arm gets the MCP config, strict flag, and additive allowed tools", () => {
    const { command, args } = buildClaudeInvocation({
      ...BASE,
      arm: "claude-with",
      mcpConfigPath: "/tmp/bench-mcp.json",
    });
    expect(command).toBe("claude");
    expect(args).toContain("--mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/bench-mcp.json");
    expect(args).toContain("--strict-mcp-config");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    // Strictly additive: every baseline tool PLUS the code-index MCP glob.
    for (const tool of CLAUDE_BASELINE_TOOLS) expect(allowed).toContain(tool);
    expect(allowed).toContain("mcp__code-index__*");
  });

  it("without-arm gets NO MCP config and only baseline tools", () => {
    const { args } = buildClaudeInvocation({ ...BASE, arm: "claude-without" });
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed).toBe(CLAUDE_BASELINE_TOOLS.join(","));
    expect(allowed).not.toContain("mcp__");
  });

  it("pins the model and requests the stream-json transcript", () => {
    const { args } = buildClaudeInvocation({ ...BASE, model: "claude-opus-4" });
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("-p") + 1]).toBe(BASE.prompt);
  });

  it("edit tier adds a headless write-permission mode; Q&A does not", () => {
    expect(buildClaudeInvocation({ ...BASE, editTier: true }).args).toContain("--permission-mode");
    expect(buildClaudeInvocation({ ...BASE }).args).not.toContain("--permission-mode");
  });

  it("with-arm without a config path is a hard error (no silent bad run)", () => {
    expect(() => buildClaudeInvocation({ ...BASE, arm: "claude-with" })).toThrow(/mcpConfigPath/);
  });

  it("the bench MCP config names the code-index server", () => {
    const config = JSON.parse(benchMcpConfig("npx", ["code-index", "serve", "."])) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(config.mcpServers["code-index"]).toEqual({ command: "npx", args: ["code-index", "serve", "."] });
  });
});

describe("Claude adapter: metric extraction (DEV-904 / QA-904)", () => {
  it("extracts tokens, cost, turns, wall-clock from the result event", () => {
    const { metrics } = parseClaudeStream(STREAM);
    expect(metrics.tokensIn).toBe(1500);
    expect(metrics.tokensOut).toBe(80);
    expect(metrics.tokensCache).toBe(1200); // creation + read
    expect(metrics.costUsd).toBe(0.0123);
    expect(metrics.turns).toBe(3);
    expect(metrics.wallSeconds).toBeCloseTo(4.2, 5);
  });

  it("counts tool calls and splits MCP vs baseline by name prefix", () => {
    const { metrics } = parseClaudeStream(STREAM);
    expect(metrics.toolCalls).toBe(3);
    expect(metrics.mcpCalls).toBe(2); // find_symbol + get_chunk
    expect(metrics.baselineCalls).toBe(1); // Grep
  });

  it("takes the final answer from the result event, never the transcript", () => {
    const { finalAnswer } = parseClaudeStream(STREAM);
    expect(finalAnswer).toBe("src/greet.ts:5");
  });

  it("falls back to the last assistant text when result omits an answer", () => {
    const noResultText = STREAM.replace('"result":"src/greet.ts:5",', "");
    const { finalAnswer } = parseClaudeStream(noResultText);
    expect(finalAnswer).toBe("Let me look.");
  });

  it("flags an errored result", () => {
    const errored = STREAM.replace('"subtype":"success","is_error":false', '"subtype":"error","is_error":true');
    expect(parseClaudeStream(errored).flags).toContain("agent_error");
  });

  it("flags a truncated stream with no result event", () => {
    const truncated = STREAM.split("\n").slice(0, 2).join("\n");
    const { flags, metrics } = parseClaudeStream(truncated);
    expect(flags).toContain("no_result");
    expect(metrics.turns).toBe(0);
  });

  it("tolerates blank lines and never throws on malformed JSON lines", () => {
    const noisy = `\n${STREAM}\n{not json}\n\n`;
    expect(() => parseClaudeStream(noisy)).not.toThrow();
    expect(parseClaudeStream(noisy).metrics.toolCalls).toBe(3);
  });
});
