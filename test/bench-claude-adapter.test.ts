import { describe, expect, it } from "vitest";
import {
  benchMcpConfig,
  buildClaudeInvocation,
  CLAUDE_BASELINE_TOOLS,
  parseClaudeStream,
} from "../benchmarks/harness/adapters/claude";
import type { Arm, InvocationOptions } from "../benchmarks/harness/adapters/types";
import { hasSkill, isWithArm } from "../benchmarks/harness/adapters/types";

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

/**
 * SK-Q01 (FR-401/FR-402): the six-arm predicate truth table. Per FR-402 the
 * adapter suites own these truth tables. isWithArm is explicit set membership
 * (true for the four *-with* arms), NOT the old endsWith("-with") — under the
 * old semantics the two *-with-skill arms would be false, so these cases pin
 * the post-SK-D01 contract.
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

  it("isWithArm is true for exactly the four *-with* arms (with ∪ with-skill)", () => {
    expect(TABLE.filter((r) => isWithArm(r.arm)).map((r) => r.arm)).toEqual([
      "claude-with",
      "claude-with-skill",
      "codex-with",
      "codex-with-skill",
    ]);
  });

  it("hasSkill is true for exactly the two *-with-skill arms", () => {
    expect(TABLE.filter((r) => hasSkill(r.arm)).map((r) => r.arm)).toEqual([
      "claude-with-skill",
      "codex-with-skill",
    ]);
  });

  it("with-skill arms are a subset of with-arms (parity ladder: without ⊂ with ⊂ with-skill)", () => {
    for (const { arm } of TABLE) {
      if (hasSkill(arm)) expect(isWithArm(arm)).toBe(true);
    }
  });
});

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

/**
 * SK-Q02 (FR-403): argv snapshots for every claude arm. The four pre-change
 * arms must be BYTE-IDENTICAL to their pre-SK-D02 argv (inline expected
 * arrays), and the only skill-arm delta is `Skill` appended to
 * --allowedTools. These are full-array equality checks, not substring probes,
 * so any accidental flag reordering or extra token fails the snapshot.
 */
describe("Claude adapter: six-arm argv snapshot (SK-Q02 / FR-403)", () => {
  const MCP = "/tmp/bench-mcp.json";
  const withAllowed = [...CLAUDE_BASELINE_TOOLS, "mcp__code-index__*"].join(",");
  const skillAllowed = [...CLAUDE_BASELINE_TOOLS, "mcp__code-index__*", "Skill"].join(",");
  const head = ["-p", BASE.prompt, "--output-format", "stream-json", "--verbose", "--model", BASE.model];

  it("claude-without: baseline argv (byte-identical to pre-change)", () => {
    const { command, args } = buildClaudeInvocation({ ...BASE, arm: "claude-without" });
    expect(command).toBe("claude");
    expect(args).toEqual([...head, "--allowedTools", CLAUDE_BASELINE_TOOLS.join(",")]);
  });

  it("claude-with: MCP config + additive allowlist (byte-identical to pre-change)", () => {
    const { args } = buildClaudeInvocation({ ...BASE, arm: "claude-with", mcpConfigPath: MCP });
    expect(args).toEqual([
      ...head,
      "--mcp-config",
      MCP,
      "--strict-mcp-config",
      "--allowedTools",
      withAllowed,
    ]);
  });

  it("claude-with-skill: ONLY delta vs claude-with is `Skill` in --allowedTools", () => {
    const withArgs = buildClaudeInvocation({ ...BASE, arm: "claude-with", mcpConfigPath: MCP }).args;
    const skillArgs = buildClaudeInvocation({ ...BASE, arm: "claude-with-skill", mcpConfigPath: MCP }).args;

    expect(skillArgs).toEqual([
      ...head,
      "--mcp-config",
      MCP,
      "--strict-mcp-config",
      "--allowedTools",
      skillAllowed,
    ]);
    // The two argv arrays are identical except for the single --allowedTools value.
    const diffIdx = skillArgs.findIndex((a, i) => a !== withArgs[i]);
    expect(skillArgs.length).toBe(withArgs.length);
    expect(withArgs[diffIdx - 1]).toBe("--allowedTools");
    expect(skillArgs[diffIdx]).toBe(`${withArgs[diffIdx]},Skill`);
  });

  it("`Skill` appears in --allowedTools ONLY for claude-with-skill", () => {
    const ARMS: Arm[] = ["claude-with", "claude-without", "claude-with-skill"];
    for (const arm of ARMS) {
      const opts: InvocationOptions = { ...BASE, arm, ...(isWithArm(arm) ? { mcpConfigPath: MCP } : {}) };
      const allowed = buildClaudeInvocation(opts).args[
        buildClaudeInvocation(opts).args.indexOf("--allowedTools") + 1
      ];
      const list = allowed.split(",");
      expect(list.includes("Skill")).toBe(arm === "claude-with-skill");
    }
  });

  it("the four existing arms carry no --append-system-prompt regardless of options", () => {
    // Non-skill arms never inject a system prompt even if the field is set.
    for (const arm of ["claude-with", "claude-without"] as Arm[]) {
      const opts: InvocationOptions = {
        ...BASE,
        arm,
        systemPromptSkill: "BODY",
        ...(isWithArm(arm) ? { mcpConfigPath: MCP } : {}),
      };
      expect(buildClaudeInvocation(opts).args).not.toContain("--append-system-prompt");
    }
  });
});

/**
 * SK-Q02 (FR-404): --append-system-prompt is present IFF systemPromptSkill is
 * set on a claude SKILL arm, and NEVER for non-skill arms. The body is passed
 * verbatim as the flag value.
 */
describe("Claude adapter: --append-system-prompt diagnostic mode (SK-Q02 / FR-404)", () => {
  const MCP = "/tmp/bench-mcp.json";
  const BODY = "You have a code-index skill. Use it.";

  it("skill arm + systemPromptSkill set: injects --append-system-prompt <body>", () => {
    const { args } = buildClaudeInvocation({
      ...BASE,
      arm: "claude-with-skill",
      mcpConfigPath: MCP,
      systemPromptSkill: BODY,
    });
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(BODY);
  });

  it("skill arm WITHOUT systemPromptSkill: no --append-system-prompt", () => {
    const { args } = buildClaudeInvocation({ ...BASE, arm: "claude-with-skill", mcpConfigPath: MCP });
    expect(args).not.toContain("--append-system-prompt");
  });

  it("non-skill arm WITH systemPromptSkill set: never injects (guarded by hasSkill)", () => {
    for (const arm of ["claude-with", "claude-without"] as Arm[]) {
      const opts: InvocationOptions = {
        ...BASE,
        arm,
        systemPromptSkill: BODY,
        ...(isWithArm(arm) ? { mcpConfigPath: MCP } : {}),
      };
      expect(buildClaudeInvocation(opts).args).not.toContain("--append-system-prompt");
    }
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

  it("splits cache into read/creation and keeps tokensCache as their sum (SK-Q02 / FR-603)", () => {
    const { metrics } = parseClaudeStream(STREAM);
    expect(metrics.tokensCacheRead).toBe(1000); // cache_read_input_tokens
    expect(metrics.tokensCacheCreation).toBe(200); // cache_creation_input_tokens
    expect(metrics.tokensCache).toBe(metrics.tokensCacheRead + metrics.tokensCacheCreation);
    expect(metrics.tokensCache).toBe(1200);
  });

  it("cache split defaults to 0/0 when the result usage omits cache fields (SK-Q02)", () => {
    const noCache = STREAM.replace('"cache_creation_input_tokens":200,', "").replace(
      ',"cache_read_input_tokens":1000',
      "",
    );
    const { metrics } = parseClaudeStream(noCache);
    expect(metrics.tokensCacheRead).toBe(0);
    expect(metrics.tokensCacheCreation).toBe(0);
    expect(metrics.tokensCache).toBe(0);
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
