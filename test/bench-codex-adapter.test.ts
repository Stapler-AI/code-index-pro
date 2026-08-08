import { describe, expect, it } from "vitest";
import {
  buildCodexInvocation,
  CODEX_MODEL_PRICING,
  computeCost,
  parseCodexStream,
} from "../benchmarks/harness/adapters/codex";
import type { Arm, InvocationOptions } from "../benchmarks/harness/adapters/types";
import { hasSkill, isWithArm } from "../benchmarks/harness/adapters/types";

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

/**
 * Codex 0.14x `--json` stream, captured live from codex-cli 0.144.6:
 * thread/turn/item events, per-turn usage on turn.completed, tool calls and
 * messages wrapped in item.completed. item.started must NOT double-count.
 */
const NEW_STREAM = [
  JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "I’ll query the code index for the symbol." },
  }),
  JSON.stringify({
    type: "item.started",
    item: { id: "item_1", type: "mcp_tool_call", server: "code-index", tool: "find_symbol", status: "in_progress" },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "mcp_tool_call", server: "code-index", tool: "find_symbol", status: "completed" },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_2", type: "command_execution", command: "rg -n greet .", exit_code: 0, status: "completed" },
  }),
  JSON.stringify({ type: "item.completed", item: { id: "item_3", type: "reasoning", text: "…" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_4", type: "agent_message", text: "src/greet.ts:5" } }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 89955, cached_input_tokens: 66304, output_tokens: 406, reasoning_output_tokens: 148 },
  }),
].join("\n");

/**
 * SK-Q01 (FR-401/FR-402): six-arm predicate truth table, pinned in the codex
 * suite too (FR-402: the adapter suites own the truth tables). Pins the codex
 * skill arm specifically — under the old endsWith("-with") contract
 * codex-with-skill would report isWithArm=false; here it must be true.
 */
describe("adapter predicates: isWithArm / hasSkill truth table (SK-Q01 / FR-402)", () => {
  const TABLE: { arm: Arm; withArm: boolean; skill: boolean }[] = [
    { arm: "claude-with", withArm: true, skill: false },
    { arm: "claude-without", withArm: false, skill: false },
    { arm: "claude-with-skill", withArm: true, skill: true },
    { arm: "codex-with", withArm: true, skill: false },
    { arm: "codex-without", withArm: false, skill: false },
    { arm: "codex-with-skill", withArm: true, skill: true },
  ];

  it("covers all six arms exactly once", () => {
    expect(new Set(TABLE.map((r) => r.arm)).size).toBe(6);
  });

  for (const { arm, withArm, skill } of TABLE) {
    it(`${arm}: isWithArm=${withArm}, hasSkill=${skill}`, () => {
      expect(isWithArm(arm)).toBe(withArm);
      expect(hasSkill(arm)).toBe(skill);
    });
  }

  it("codex-with-skill takes the with-arm path and carries the skill", () => {
    expect(isWithArm("codex-with-skill")).toBe(true);
    expect(hasSkill("codex-with-skill")).toBe(true);
  });
});

describe("Codex adapter: arm configuration (DEV-905 / QA-905)", () => {
  it("with-arm injects the code-index MCP server via -c overrides (command + args split)", () => {
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
    // Codex treats `command` as a bare executable: the launch command must be
    // split into command + JSON args or the server silently never attaches.
    expect(args[cIndex + 1]).toBe("mcp_servers.code-index.command=npx");
    expect(args).toContain('mcp_servers.code-index.args=["code-index","serve","."]');
  });

  it("without-arm injects NO mcp_servers override (strictly additive floor)", () => {
    const { args } = buildCodexInvocation({ ...BASE, arm: "codex-without" });
    expect(args.some((a) => a.startsWith("mcp_servers."))).toBe(false);
    expect(args).not.toContain("-c");
  });

  it("pins the model and uses danger-full-access on both tiers (openai/codex#16685)", () => {
    expect(buildCodexInvocation({ ...BASE, model: "o4-mini" }).args).toContain("o4-mini");
    // Managed sandbox profiles auto-cancel MCP tool calls in exec mode, so
    // both tiers run unsandboxed until the upstream bug is fixed.
    const qa = buildCodexInvocation({ ...BASE });
    expect(qa.args[qa.args.indexOf("--sandbox") + 1]).toBe("danger-full-access");
    const edit = buildCodexInvocation({ ...BASE, editTier: true });
    expect(edit.args[edit.args.indexOf("--sandbox") + 1]).toBe("danger-full-access");
  });

  it("with-arm without a launch command is a hard error", () => {
    expect(() => buildCodexInvocation({ ...BASE, arm: "codex-with" })).toThrow(/mcpConfigPath/);
  });
});

/**
 * SK-Q02 (FR-403): argv snapshots for every codex arm. The four pre-change
 * arms must be BYTE-IDENTICAL to their pre-SK-D02 argv, and the codex skill
 * arm has NO argv delta at all — codex-with-skill argv is identical to
 * codex-with (file presence, not argv, carries the skill).
 */
describe("Codex adapter: six-arm argv snapshot (SK-Q02 / FR-403)", () => {
  const LAUNCH = "npx code-index serve .";
  const head = ["exec", BASE.prompt, "--json", "-m", BASE.model];
  const sandbox = ["--sandbox", "danger-full-access"];
  const withOverrides = [
    "-c",
    "mcp_servers.code-index.command=npx",
    "-c",
    'mcp_servers.code-index.args=["code-index","serve","."]',
  ];

  it("codex-without: baseline argv (byte-identical to pre-change)", () => {
    const { command, args } = buildCodexInvocation({ ...BASE, arm: "codex-without" });
    expect(command).toBe("codex");
    expect(args).toEqual([...head, ...sandbox]);
  });

  it("codex-with: mcp_servers overrides argv (byte-identical to pre-change)", () => {
    const { args } = buildCodexInvocation({ ...BASE, arm: "codex-with", mcpConfigPath: LAUNCH });
    expect(args).toEqual([...head, ...withOverrides, ...sandbox]);
  });

  it("codex-with-skill argv is IDENTICAL to codex-with (no argv delta)", () => {
    const withArgs = buildCodexInvocation({ ...BASE, arm: "codex-with", mcpConfigPath: LAUNCH }).args;
    const skillArgs = buildCodexInvocation({ ...BASE, arm: "codex-with-skill", mcpConfigPath: LAUNCH }).args;
    expect(skillArgs).toEqual(withArgs);
    expect(skillArgs).toEqual([...head, ...withOverrides, ...sandbox]);
  });

  it("codex adapter never emits --append-system-prompt or a Skill token on any arm", () => {
    for (const arm of ["codex-with", "codex-without", "codex-with-skill"] as Arm[]) {
      const opts: InvocationOptions = {
        ...BASE,
        arm,
        systemPromptSkill: "BODY", // even when set (claude-only field) codex ignores it
        ...(isWithArm(arm) ? { mcpConfigPath: LAUNCH } : {}),
      };
      const { args } = buildCodexInvocation(opts);
      expect(args).not.toContain("--append-system-prompt");
      expect(args).not.toContain("Skill");
    }
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

  it("cache split is read-only: creation==0 and tokensCache mirrors read (SK-Q02 / FR-603)", () => {
    // Old flat schema: cumulative, last token event wins (cached_input_tokens: 900).
    const { metrics } = parseCodexStream(STREAM);
    expect(metrics.tokensCacheRead).toBe(900);
    expect(metrics.tokensCacheCreation).toBe(0); // Codex never reports cache creation
    expect(metrics.tokensCache).toBe(metrics.tokensCacheRead);
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

  it("has published rates for the documented benchmark models", () => {
    expect(CODEX_MODEL_PRICING["gpt-5.6-sol"]).toEqual({
      inputPerMTok: 5,
      cachedInputPerMTok: 0.5,
      outputPerMTok: 30,
    });
    expect(CODEX_MODEL_PRICING["gpt-5.5"]).toEqual({
      inputPerMTok: 5,
      cachedInputPerMTok: 0.5,
      outputPerMTok: 30,
    });
  });

  it("computeCost applies uncached, cached, and output pricing; unknown model -> null", () => {
    const { metrics } = parseCodexStream(STREAM);
    const cost = computeCost(metrics, "gpt-5-codex");
    const p = CODEX_MODEL_PRICING["gpt-5-codex"];
    expect(cost).toBeCloseTo(
      (500 / 1e6) * p.inputPerMTok + (900 / 1e6) * p.cachedInputPerMTok + (55 / 1e6) * p.outputPerMTok,
      9,
    );
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

  it("0.14x schema: sums per-turn usage from turn.completed", () => {
    const { metrics } = parseCodexStream(NEW_STREAM);
    expect(metrics.tokensIn).toBe(89955);
    expect(metrics.tokensOut).toBe(406);
    expect(metrics.tokensCache).toBe(66304);
    expect(metrics.turns).toBe(1);

    const secondTurn = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10045, cached_input_tokens: 3696, output_tokens: 94 },
    });
    const twoTurns = parseCodexStream(`${NEW_STREAM}\n${secondTurn}`).metrics;
    expect(twoTurns.tokensIn).toBe(100000);
    expect(twoTurns.tokensOut).toBe(500);
    expect(twoTurns.tokensCache).toBe(70000);
    expect(twoTurns.turns).toBe(2);
  });

  it("0.14x schema: cache is read-only per turn — creation==0, tokensCache==read (SK-Q02)", () => {
    const { metrics } = parseCodexStream(NEW_STREAM);
    expect(metrics.tokensCacheRead).toBe(66304); // summed cached_input_tokens
    expect(metrics.tokensCacheCreation).toBe(0);
    expect(metrics.tokensCache).toBe(metrics.tokensCacheRead);

    const secondTurn = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10045, cached_input_tokens: 3696, output_tokens: 94 },
    });
    const twoTurns = parseCodexStream(`${NEW_STREAM}\n${secondTurn}`).metrics;
    expect(twoTurns.tokensCacheRead).toBe(70000);
    expect(twoTurns.tokensCacheCreation).toBe(0);
    expect(twoTurns.tokensCache).toBe(70000);
  });

  it("0.14x schema: counts item.completed tool calls (never item.started), MCP vs baseline", () => {
    const { metrics } = parseCodexStream(NEW_STREAM);
    expect(metrics.toolCalls).toBe(2); // 1 mcp_tool_call + 1 command_execution; reasoning ignored
    expect(metrics.mcpCalls).toBe(1);
    expect(metrics.baselineCalls).toBe(1);
  });

  it("0.14x schema: the LAST agent_message item is the final answer", () => {
    expect(parseCodexStream(NEW_STREAM).finalAnswer).toBe("src/greet.ts:5");
  });

  it("0.14x schema: turn.completed marks completion; truncation and turn.failed still flag", () => {
    expect(parseCodexStream(NEW_STREAM).flags).toEqual([]);

    const truncated = NEW_STREAM.split("\n").slice(0, 5).join("\n"); // no turn.completed
    expect(parseCodexStream(truncated).flags).toContain("no_result");

    const failed = `${truncated}\n${JSON.stringify({ type: "turn.failed", error: { message: "boom" } })}`;
    const flags = parseCodexStream(failed).flags;
    expect(flags).toContain("agent_error");
    expect(flags).not.toContain("no_result");
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
