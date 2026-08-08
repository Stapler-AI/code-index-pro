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
 * sandbox is danger-full-access on both tiers (see buildCodexInvocation).
 * Codex does not report cost, so cost is computed from published pricing
 * (computeCost).
 *
 * NOTE (benchmark.md): Codex's headless flags AND its --json event shape
 * drift; both MUST be re-verified against the current CLI at run time. The
 * parser below is deliberately tolerant of where token/tool fields sit
 * (top-level, under `msg`, or under `usage`); the harness records the Codex
 * CLI version per run.
 */

export const CODEX_MODEL_PRICING: Record<
  string,
  { inputPerMTok: number; cachedInputPerMTok: number; outputPerMTok: number }
> = {
  // Published standard rates (USD per 1M tokens), verified 2026-08-08.
  "gpt-5.6-sol": { inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 30 },
  "gpt-5.5": { inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 30 },
  "gpt-5-codex": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "o4-mini": { inputPerMTok: 1.1, cachedInputPerMTok: 0.275, outputPerMTok: 4.4 },
};

export function buildCodexInvocation(opts: InvocationOptions): AgentInvocation {
  const args = ["exec", opts.prompt, "--json", "-m", opts.model];

  if (isWithArm(opts.arm)) {
    // Inject the code-index MCP server via config overrides. The command
    // string is supplied by the harness through mcpConfigPath (reused here as
    // the server launch command, e.g. "node /path/cli.js serve ."). Codex
    // treats `command` as a bare executable — passing the whole string leaves
    // the server silently unattached — so split it into command + args (the
    // -c value for args is parsed as JSON).
    if (!opts.mcpConfigPath) {
      throw new Error("codex with-arm requires mcpConfigPath (the MCP server launch command)");
    }
    const [serverCommand, ...serverArgs] = opts.mcpConfigPath.split(" ");
    args.push("-c", `mcp_servers.${MCP_SERVER_NAME}.command=${serverCommand}`);
    args.push("-c", `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify(serverArgs)}`);
  }
  // Without-arm: no mcp_servers override at all — the strictly-additive floor.

  // Sandbox: danger-full-access on both tiers. The managed profiles
  // (read-only / workspace-write) auto-cancel every MCP tool call in exec
  // mode (openai/codex#16685), which would silence the with-arm's index
  // tools entirely. Comparable posture to the Claude arm (tool allowlist,
  // no OS sandbox); workspaces are disposable. Revert to
  // editTier ? workspace-write : read-only once the upstream bug is fixed.
  args.push("--sandbox", "danger-full-access");
  return { command: "codex", args };
}

/** Cost from published pricing (Codex doesn't self-report). null if unknown model. */
export function computeCost(metrics: RunMetrics, model: string): number | null {
  const pricing = CODEX_MODEL_PRICING[model];
  if (!pricing) return null;
  const cachedInputTokens = Math.min(metrics.tokensCache, metrics.tokensIn);
  const uncachedInputTokens = metrics.tokensIn - cachedInputTokens;
  return (
    (uncachedInputTokens / 1_000_000) * pricing.inputPerMTok +
    (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMTok +
    (metrics.tokensOut / 1_000_000) * pricing.outputPerMTok
  );
}

interface CodexEvent {
  type?: string;
  msg?: CodexEvent;
  usage?: CodexEvent;
  /** 0.14x schema: item.started / item.completed wrap the payload in `item`. */
  item?: CodexEvent;
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
/** 0.14x schema: item.completed payloads counted as baseline tool calls. */
const BASELINE_ITEM_TYPES = new Set(["command_execution", "file_change", "patch_apply", "web_search"]);

function num(...values: unknown[]): number {
  for (const v of values) if (typeof v === "number") return v;
  return 0;
}

/**
 * Parse a Codex `--json` transcript. Handles the 0.14x schema (thread/turn/
 * item events: `turn.completed` carries per-turn usage, `item.completed`
 * wraps messages and tool calls in `item`) plus the older flat schema for
 * back-compat. Old-schema token counts are cumulative, so the LAST token
 * event wins; 0.14x usage is per-turn and summed. Cost is left null here
 * (computeCost applies pricing once the model is known). Tool calls split
 * MCP vs baseline: an event naming the code-index server (or an
 * mcp__code-index__ tool) is MCP; every other tool/exec/patch event is
 * baseline.
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

    if (type === "turn.completed") {
      // 0.14x schema: per-turn usage totals — sum across turns. A completed
      // turn is the healthy-run signal (this schema has no task_complete).
      const u = event.usage ?? {};
      metrics.tokensIn += num(u.input_tokens);
      metrics.tokensOut += num(u.output_tokens);
      // Codex reports only cache reads (cached/cache_read); it never reports
      // cache creation, so tokensCacheCreation stays 0 and tokensCache (kept
      // for back-compat) equals tokensCacheRead.
      const cacheRead = num(u.cached_input_tokens, u.cache_read_input_tokens);
      metrics.tokensCacheRead += cacheRead;
      metrics.tokensCache += cacheRead;
      metrics.turns += 1;
      sawCompletion = true;
    } else if (type === "item.completed") {
      // 0.14x schema: the payload sits under `item`; item.started is skipped
      // so tool calls aren't double-counted.
      const item = event.item ?? {};
      if (item.type === "agent_message") {
        if (typeof item.text === "string" && item.text.length > 0) finalAnswer = item.text;
      } else if (item.type === "mcp_tool_call") {
        metrics.toolCalls += 1;
        const isMcp =
          item.server === MCP_SERVER_NAME || (typeof item.tool === "string" && isMcpToolName(item.tool));
        if (isMcp) metrics.mcpCalls += 1;
        else metrics.baselineCalls += 1;
      } else if (typeof item.type === "string" && BASELINE_ITEM_TYPES.has(item.type)) {
        metrics.toolCalls += 1;
        metrics.baselineCalls += 1;
      }
    } else if (type === "turn.failed") {
      flags.push("agent_error");
    } else if (TOKEN_EVENT_TYPES.has(type)) {
      const u = event.usage ?? event;
      metrics.tokensIn = num(u.input_tokens, metrics.tokensIn);
      metrics.tokensOut = num(u.output_tokens, metrics.tokensOut);
      // Old-schema counts are cumulative (last event wins). Codex reports only
      // cache reads; cache creation is never reported, so tokensCacheCreation
      // stays 0 and tokensCache mirrors tokensCacheRead.
      metrics.tokensCacheRead = num(u.cached_input_tokens, u.cache_read_input_tokens, metrics.tokensCacheRead);
      metrics.tokensCache = metrics.tokensCacheRead;
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
