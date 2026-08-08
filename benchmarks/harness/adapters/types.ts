/**
 * Shared adapter surface (benchmark.md#agent-adapters, #metrics). One module
 * per agent CLI isolates invocation + metric extraction, since both CLIs'
 * headless flags and output formats drift (decision-log 11). The metric
 * record shape is common so the harness (DEV-906) writes one JSONL schema.
 */

export type Arm = "claude-with" | "claude-without" | "codex-with" | "codex-without";

/** True for the arms that get the code-index MCP tools (strictly additive). */
export function isWithArm(arm: Arm): boolean {
  return arm.endsWith("-with");
}

/** Per-run metrics (benchmark.md#metrics), extraction source noted per CLI. */
export interface RunMetrics {
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
  /** null when neither CLI-reported nor computable from pricing. */
  costUsd: number | null;
  /** CLI-reported wall-clock; the harness also keeps its own timer. */
  wallSeconds: number | null;
  turns: number;
  toolCalls: number;
  /** code-index MCP tool calls (mcp__code-index__*). */
  mcpCalls: number;
  /** Baseline (non-MCP) tool calls. */
  baselineCalls: number;
}

/** A ready-to-spawn command; the harness owns the actual child process. */
export interface AgentInvocation {
  command: string;
  args: string[];
}

export interface InvocationOptions {
  prompt: string;
  arm: Arm;
  model: string;
  /** Path to the bench MCP config; required for with-arms, ignored otherwise. */
  mcpConfigPath?: string;
  /** Edit-tier tasks need headless file-write permission, workspace-scoped. */
  editTier?: boolean;
}

export interface ParsedTranscript {
  metrics: RunMetrics;
  /** The agent's final answer text, for grading (never the transcript). */
  finalAnswer: string;
  /** "agent_error" | "no_result" — harness merges with its own timeout flag. */
  flags: string[];
}

/** The code-index MCP server name used in bench configs; tools are mcp__<name>__*. */
export const MCP_SERVER_NAME = "code-index";

export function isMcpToolName(name: string): boolean {
  return name.startsWith(`mcp__${MCP_SERVER_NAME}__`);
}

export function emptyMetrics(): RunMetrics {
  return {
    tokensIn: 0,
    tokensOut: 0,
    tokensCache: 0,
    costUsd: null,
    wallSeconds: null,
    turns: 0,
    toolCalls: 0,
    mcpCalls: 0,
    baselineCalls: 0,
  };
}
