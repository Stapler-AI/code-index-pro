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
 * Codex CLI adapter (benchmark.md#agent-adapters). Headless via
 * `codex exec "<prompt>" --json` (a JSONL event stream). With-arm injects
 * mcp_servers.code-index via `-c` config overrides; without-arm passes no
 * MCP server config (tool-parity: strictly additive). Model pinned via `-m`;
 * edit tier via a workspace-write sandbox. Codex does not report cost, so
 * cost is computed from published pricing (computeCost).
 *
 * NOTE (benchmark.md): Codex's headless flags AND its --json event shape
 * drift; both MUST be re-verified against the current CLI at run time. The
 * parser below is deliberately tolerant of where token/tool fields sit
 * (top-level, under `msg`, or under `usage`); the harness records the Codex
 * CLI version per run.
 */

export const CODEX_MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  // Illustrative published rates (USD per 1M tokens); update at run time.
  "gpt-5-codex": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "o4-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4 },
};

export function buildCodexInvocation(opts: InvocationOptions): AgentInvocation {
  const args = ["exec", opts.prompt, "--json", "-m", opts.model];

  if (isWithArm(opts.arm)) {
    // Inject the code-index MCP server via config overrides. The command
    // string is supplied by the harness through mcpConfigPath (reused here as
    // the server launch command, e.g. "npx code-index serve .").
    if (!opts.mcpConfigPath) {
      throw new Error("codex with-arm requires mcpConfigPath (the MCP server launch command)");
    }
    args.push("-c", `mcp_servers.${MCP_SERVER_NAME}.command=${opts.mcpConfigPath}`);
  }
  // Without-arm: no mcp_servers override at all — the strictly-additive floor.

  // Sandbox: edit tier writes to the workspace; Q&A stays read-only.
  args.push("--sandbox", opts.editTier ? "workspace-write" : "read-only");
  return { command: "codex", args };
}

/** Cost from published pricing (Codex doesn't self-report). null if unknown model. */
export function computeCost(metrics: RunMetrics, model: string): number | null {
  const pricing = CODEX_MODEL_PRICING[model];
  if (!pricing) return null;
  return (
    (metrics.tokensIn / 1_000_000) * pricing.inputPerMTok +
    (metrics.tokensOut / 1_000_000) * pricing.outputPerMTok
  );
}

interface CodexEvent {
  type?: string;
  msg?: CodexEvent;
  usage?: CodexEvent;
  // token fields may appear under any of several names / nestings
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  // tool-call markers
  server?: string;
  tool?: string;
  name?: string;
  command?: unknown;
  // final answer
  message?: string;
  text?: string;
}

const TOKEN_EVENT_TYPES = new Set(["token_count", "token_usage", "usage"]);
const MESSAGE_EVENT_TYPES = new Set(["agent_message", "assistant_message", "message"]);
const TOOL_EVENT_TYPES = new Set([
  "mcp_tool_call",
  "tool_call",
  "function_call",
  "exec_command",
  "command_execution",
  "patch_apply",
]);

function num(...values: unknown[]): number {
  for (const v of values) if (typeof v === "number") return v;
  return 0;
}

/**
 * Parse a Codex `--json` transcript. Tolerant of the msg-wrapper: each line's
 * payload is the object itself or its `.msg`. Token counts are cumulative in
 * Codex, so the LAST token event wins. Cost is left null here (computeCost
 * applies pricing once the model is known). Tool calls split MCP vs baseline:
 * an event naming the code-index server (or an mcp__code-index__ tool) is MCP;
 * every other tool/exec/patch event is baseline.
 */
export function parseCodexStream(stdout: string): ParsedTranscript {
  const metrics: RunMetrics = emptyMetrics();
  const flags: string[] = [];
  let finalAnswer = "";
  let sawCompletion = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let raw: CodexEvent;
    try {
      raw = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue;
    }
    const event = raw.msg ?? raw;
    const type = event.type ?? raw.type ?? "";

    if (TOKEN_EVENT_TYPES.has(type)) {
      const u = event.usage ?? event;
      metrics.tokensIn = num(u.input_tokens, metrics.tokensIn);
      metrics.tokensOut = num(u.output_tokens, metrics.tokensOut);
      metrics.tokensCache = num(u.cached_input_tokens, u.cache_read_input_tokens, metrics.tokensCache);
      metrics.turns += 1; // Codex has no turn field; each token event is a turn boundary
    } else if (TOOL_EVENT_TYPES.has(type)) {
      metrics.toolCalls += 1;
      const isMcp =
        event.server === MCP_SERVER_NAME ||
        (typeof event.name === "string" && isMcpToolName(event.name)) ||
        type === "mcp_tool_call";
      if (isMcp) metrics.mcpCalls += 1;
      else metrics.baselineCalls += 1;
    } else if (MESSAGE_EVENT_TYPES.has(type)) {
      const text = event.message ?? event.text;
      if (typeof text === "string" && text.length > 0) finalAnswer = text;
    } else if (type === "task_complete" || type === "task_finished") {
      sawCompletion = true;
    } else if (type === "error" || type === "task_error") {
      flags.push("agent_error");
    }
  }

  metrics.costUsd = null; // computeCost(model) supplies this downstream
  // A healthy run reaches task_complete; a truncated one (no completion, no
  // error) is flagged no_result. An errored run already carries agent_error.
  if (!sawCompletion && !flags.includes("agent_error")) flags.push("no_result");
  return { metrics, finalAnswer, flags };
}
