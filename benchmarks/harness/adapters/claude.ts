import {
  AgentInvocation,
  emptyMetrics,
  InvocationOptions,
  isMcpToolName,
  isWithArm,
  MCP_SERVER_NAME,
  ParsedTranscript,
  RunMetrics,
} from "./types";

/**
 * Claude Code adapter (benchmark.md#agent-adapters). Headless via
 * `claude -p "<prompt>" --output-format stream-json --verbose`; per-turn
 * events carry usage. With-arm adds `--mcp-config <bench-mcp.json>
 * --strict-mcp-config` and allows mcp__code-index__*; without-arm passes no
 * MCP config and allows only baseline tools (tool-parity: the with-arm is
 * strictly additive). Model pinned via `--model`; edit tier via a headless
 * permission mode.
 *
 * NOTE (benchmark.md): these flags MUST be re-verified against the current
 * Claude Code CLI at run time — the headless interface drifts; the CLI
 * version is recorded per run by the harness.
 */

export const CLAUDE_BASELINE_TOOLS = ["Read", "Grep", "Glob", "Bash"];

/** The bench MCP config content (written to disk by the harness for with-arms). */
export function benchMcpConfig(serverCommand: string, serverArgs: string[]): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: { command: serverCommand, args: serverArgs } } },
    null,
    2,
  );
}

export function buildClaudeInvocation(opts: InvocationOptions): AgentInvocation {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
  ];

  if (isWithArm(opts.arm)) {
    if (!opts.mcpConfigPath) {
      throw new Error("claude with-arm requires mcpConfigPath");
    }
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
    // Strictly additive: baseline tools PLUS the code-index MCP tools.
    args.push("--allowedTools", [...CLAUDE_BASELINE_TOOLS, `mcp__${MCP_SERVER_NAME}__*`].join(","));
  } else {
    // Parity floor: identical baseline tools, no MCP config at all.
    args.push("--allowedTools", CLAUDE_BASELINE_TOOLS.join(","));
  }

  if (opts.editTier) {
    args.push("--permission-mode", "acceptEdits");
  }
  return { command: "claude", args };
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: { type?: string; name?: string; text?: string }[] };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
  result?: string;
}

/**
 * Parse a stream-json transcript into metrics + final answer. The `result`
 * event is authoritative for usage/cost/turns/duration; tool-call counts are
 * tallied from tool_use blocks across assistant events and split MCP vs
 * baseline by the mcp__code-index__* name prefix.
 */
export function parseClaudeStream(stdout: string): ParsedTranscript {
  const metrics: RunMetrics = emptyMetrics();
  const flags: string[] = [];
  let finalAnswer = "";
  let sawResult = false;
  let lastAssistantText = "";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue; // non-JSON noise (never on stdout in practice) is ignored
    }

    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          metrics.toolCalls += 1;
          if (isMcpToolName(block.name)) metrics.mcpCalls += 1;
          else metrics.baselineCalls += 1;
        } else if (block.type === "text" && typeof block.text === "string") {
          lastAssistantText = block.text;
        }
      }
    }

    if (event.type === "result") {
      sawResult = true;
      const u = event.usage ?? {};
      metrics.tokensIn = u.input_tokens ?? 0;
      metrics.tokensOut = u.output_tokens ?? 0;
      metrics.tokensCache = (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      metrics.costUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
      metrics.turns = event.num_turns ?? 0;
      metrics.wallSeconds = typeof event.duration_ms === "number" ? event.duration_ms / 1000 : null;
      // The result event's `result` field is the final answer text; fall back
      // to the last assistant text block if the CLI omitted it.
      finalAnswer = typeof event.result === "string" && event.result.length > 0 ? event.result : lastAssistantText;
      if (event.is_error || event.subtype !== "success") flags.push("agent_error");
    }
  }

  if (!sawResult) flags.push("no_result");
  if (finalAnswer.length === 0) finalAnswer = lastAssistantText;
  return { metrics, finalAnswer, flags };
}
