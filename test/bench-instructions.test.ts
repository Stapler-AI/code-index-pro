import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installInstructions,
  planInstructions,
} from "../benchmarks/harness/instructions";
import type { Arm } from "../benchmarks/harness/adapters/types";

/**
 * SK-Q03 — proves SK-D03's `instructions.ts` completion criteria (FR-501/503/504):
 * the pure plan truth table, the fs install (verbatim SKILL.md copy, codex header
 * strip + append-on-collision), the stable 12-hex post-transform hash, the
 * non-skill no-op, and the pre-existing-`.claude/` isolation guard.
 *
 * Runs against the real shipped `integrations/` artifacts (the module's default
 * root) — no fixtures needed. Each fs case uses a fresh temp workspace, cleaned up
 * after every test.
 */

const ALL_ARMS: Arm[] = [
  "claude-with",
  "claude-without",
  "claude-with-skill",
  "codex-with",
  "codex-without",
  "codex-with-skill",
];

const SKILL_ARMS: Arm[] = ["claude-with-skill", "codex-with-skill"];
const NON_SKILL_ARMS: Arm[] = ALL_ARMS.filter((a) => !SKILL_ARMS.includes(a));

const tmpDirs: string[] = [];
function freshWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "bench-instr-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("planInstructions (pure truth table, FR-501)", () => {
  it("claude-with-skill plans the SKILL.md copy to .claude/skills/code-index/", () => {
    expect(planInstructions("claude-with-skill")).toEqual([
      {
        source: "claude/skills/code-index/SKILL.md",
        destRelPath: ".claude/skills/code-index/SKILL.md",
      },
    ]);
  });

  it("codex-with-skill plans the AGENTS.md copy to the workspace root", () => {
    expect(planInstructions("codex-with-skill")).toEqual([
      { source: "codex/AGENTS.md", destRelPath: "AGENTS.md" },
    ]);
  });

  it.each(NON_SKILL_ARMS)("%s plans nothing", (arm) => {
    expect(planInstructions(arm)).toEqual([]);
  });
});

describe("installInstructions — claude (FR-502/504)", () => {
  it("copies SKILL.md verbatim to .claude/skills/code-index/SKILL.md", () => {
    const ws = freshWorkspace();
    const result = installInstructions(ws, "claude-with-skill");

    const dest = join(ws, ".claude", "skills", "code-index", "SKILL.md");
    expect(existsSync(dest)).toBe(true);

    const source = join(
      __dirname,
      "..",
      "integrations",
      "claude",
      "skills",
      "code-index",
      "SKILL.md",
    );
    // Verbatim copy: on-disk content matches the shipped artifact byte-for-byte.
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(source, "utf8"));
    expect(result.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(result.flags).toEqual([]);
  });

  it("throws when the workspace already contains a .claude/ dir (isolation violation)", () => {
    const ws = freshWorkspace();
    mkdirSync(join(ws, ".claude"), { recursive: true });

    expect(() => installInstructions(ws, "claude-with-skill")).toThrow(
      /isolation violation/i,
    );
  });
});

describe("installInstructions — codex header strip & append (FR-503/504)", () => {
  it("writes root AGENTS.md with the leading HTML comment header stripped", () => {
    const ws = freshWorkspace();
    const result = installInstructions(ws, "codex-with-skill");

    const dest = join(ws, "AGENTS.md");
    expect(existsSync(dest)).toBe(true);

    const written = readFileSync(dest, "utf8");
    // The shipped source ships a leading <!-- ... --> header; install strips it.
    expect(written).not.toContain("<!--");
    expect(written.trimStart().startsWith("<!--")).toBe(false);
    expect(result.flags).toEqual([]);
    expect(result.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("confirms the shipped source actually carries a header to strip", () => {
    // Guards the strip assertion above from becoming vacuous if the artifact changes.
    const source = join(__dirname, "..", "integrations", "codex", "AGENTS.md");
    expect(readFileSync(source, "utf8").trimStart().startsWith("<!--")).toBe(
      true,
    );
  });

  it("appends after a separator and flags agents_md_appended when AGENTS.md pre-exists", () => {
    const ws = freshWorkspace();
    const preExisting = "# Existing project agents\n\nkeep me\n";
    writeFileSync(join(ws, "AGENTS.md"), preExisting, "utf8");

    const result = installInstructions(ws, "codex-with-skill");

    const written = readFileSync(join(ws, "AGENTS.md"), "utf8");
    expect(result.flags).toContain("agents_md_appended");
    // Pre-existing content preserved, section appended after a \n\n---\n\n separator.
    expect(written).toContain("keep me");
    expect(written).toContain("\n\n---\n\n");
    expect(written).not.toContain("<!--");

    // Hash is over the injected (post-transform) section only, NOT the merged
    // on-disk file — so it matches a fresh (non-append) install of the same arm.
    const freshWs = freshWorkspace();
    const fresh = installInstructions(freshWs, "codex-with-skill");
    expect(result.hash).toBe(fresh.hash);
  });
});

describe("hash stability (FR-504)", () => {
  it("returns the same 12-hex hash for the same shipped content across fresh workspaces", () => {
    const a = installInstructions(freshWorkspace(), "codex-with-skill");
    const b = installInstructions(freshWorkspace(), "codex-with-skill");

    expect(a.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(a.hash).toBe(b.hash);
  });

  it("returns a different hash when the source content is edited (fixture root)", () => {
    // Point the installer at a fixture integrations root so we can mutate the
    // source without touching the shipped artifact.
    const rootA = freshWorkspace();
    const rootB = freshWorkspace();
    const rel = join("codex", "AGENTS.md");
    for (const [root, body] of [
      [rootA, "## Nav\n\nfirst body\n"],
      [rootB, "## Nav\n\nsecond body — edited\n"],
    ] as const) {
      mkdirSync(join(root, "codex"), { recursive: true });
      writeFileSync(join(root, rel), body, "utf8");
    }

    const hashA = installInstructions(
      freshWorkspace(),
      "codex-with-skill",
      rootA,
    ).hash;
    const hashB = installInstructions(
      freshWorkspace(),
      "codex-with-skill",
      rootB,
    ).hash;

    expect(hashA).toMatch(/^[0-9a-f]{12}$/);
    expect(hashB).toMatch(/^[0-9a-f]{12}$/);
    expect(hashA).not.toBe(hashB);
    // Same content ⇒ same hash, re-proven against the fixture root.
    expect(
      installInstructions(freshWorkspace(), "codex-with-skill", rootA).hash,
    ).toBe(hashA);
  });
});

describe("non-skill arms are a no-op (FR-502)", () => {
  it.each(NON_SKILL_ARMS)("%s returns { hash: null, flags: [] } and writes nothing", (arm) => {
    const ws = freshWorkspace();
    const result = installInstructions(ws, arm);

    expect(result).toEqual({ hash: null, flags: [] });
    expect(readdirSync(ws)).toEqual([]);
  });
});

describe("idempotent-safe across fresh workspaces", () => {
  it.each(SKILL_ARMS)("%s installs cleanly and identically into repeated fresh workspaces", (arm) => {
    const first = installInstructions(freshWorkspace(), arm);
    const second = installInstructions(freshWorkspace(), arm);

    expect(first.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(second.hash).toBe(first.hash);
    expect(second.flags).toEqual(first.flags);
  });
});
