import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LINE_SLOP,
  gradeEdit,
  gradeExact,
  gradePathLineSet,
  gradeSet,
} from "../benchmarks/harness/graders/deterministic";

describe("deterministic matchers (DEV-902 / QA-902)", () => {
  it("exact: whitespace-normalized equality, else 0 with a note", () => {
    expect(gradeExact("  src/storage/writes.ts  \n", { kind: "exact", key: "src/storage/writes.ts" })).toEqual({
      score: 1,
      notes: [],
    });
    const miss = gradeExact("src/wrong.ts", { kind: "exact", key: "src/right.ts" });
    expect(miss.score).toBe(0);
    expect(miss.notes[0]).toContain("expected");
  });

  it("set: full credit, and F1 partial credit for a half answer", () => {
    const grader = { kind: "set" as const, key: ["alpha", "beta"] };
    expect(gradeSet("beta\nalpha\n", grader).score).toBe(1);

    // One right of two expected, nothing extra: P=1, R=0.5 -> F1 = 2/3.
    const half = gradeSet("alpha", grader);
    expect(half.score).toBeCloseTo(2 / 3, 5);
    expect(half.notes).toContain("missing: beta");

    // One right plus one wrong: P=0.5, R=0.5 -> F1 = 0.5.
    const noisy = gradeSet("alpha\ngamma", grader);
    expect(noisy.score).toBeCloseTo(0.5, 5);
    expect(noisy.notes).toContain("extra: gamma");

    expect(gradeSet("", grader).score).toBe(0);
  });

  it("path-line-set: exact boundary behavior at ± the slop", () => {
    const grader = { kind: "path-line-set" as const, key: ["src/a.ts:100"] };
    // Default slop 2: 98 and 102 match; 97 and 103 do not.
    expect(gradePathLineSet("src/a.ts:102", grader).score).toBe(1);
    expect(gradePathLineSet("src/a.ts:98", grader).score).toBe(1);
    expect(gradePathLineSet("src/a.ts:103", grader).score).toBe(0);
    expect(gradePathLineSet("src/a.ts:97", grader).score).toBe(0);
    // Path must match exactly regardless of line.
    expect(gradePathLineSet("src/b.ts:100", grader).score).toBe(0);
    expect(DEFAULT_LINE_SLOP).toBe(2);
  });

  it("path-line-set: custom slop, one-to-one matching, F1 partial credit", () => {
    const tight = { kind: "path-line-set" as const, key: ["src/a.ts:10"], lineSlop: 0 };
    expect(gradePathLineSet("src/a.ts:10", tight).score).toBe(1);
    expect(gradePathLineSet("src/a.ts:11", tight).score).toBe(0);

    // Two expected on the same path: one answer can satisfy only one of them.
    const pair = { kind: "path-line-set" as const, key: ["src/a.ts:10", "src/a.ts:12"] };
    const single = gradePathLineSet("src/a.ts:11", pair);
    expect(single.score).toBeCloseTo(2 / 3, 5); // matched 1: P=1, R=0.5

    // Unparsable lines are ignored as answers.
    expect(gradePathLineSet("not a path line", pair).score).toBe(0);
  });
});

describe("edit-tier grader (DEV-902 / QA-902)", () => {
  let workspace: string;
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  /** A tiny git workspace with a rename-style seeded state. */
  function seedWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "bench-edit-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "lib.js"), `function oldName() { return 7 }\nmodule.exports = { oldName };\n`);
    writeFileSync(
      join(dir, "check.js"),
      `const { oldName } = require('./lib');\nif (oldName() !== 7) process.exit(1);\n`,
    );
    git("init", "-q");
    git("config", "user.email", "bench@test.invalid");
    git("config", "user.name", "Bench");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    return dir;
  }

  const RENAME_GRADER = {
    kind: "test-diff" as const,
    testCommand: ["node", "check.js"],
    mustMatch: ["newName"],
    mustNotMatch: ["\\boldName\\b"],
  };

  it("passes on a correct rename: tests green, diff assertions hold", () => {
    workspace = seedWorkspace();
    writeFileSync(join(workspace, "lib.js"), `function newName() { return 7 }\nmodule.exports = { newName };\n`);
    writeFileSync(
      join(workspace, "check.js"),
      `const { newName } = require('./lib');\nif (newName() !== 7) process.exit(1);\n`,
    );
    expect(gradeEdit(workspace, RENAME_GRADER)).toEqual({ score: 1, notes: [] });
  });

  it("catches a planted must-not-match leftover (stale old-name reference)", () => {
    workspace = seedWorkspace();
    writeFileSync(join(workspace, "lib.js"), `function newName() { return 7 }\nmodule.exports = { newName };\n`);
    // check.js still calls oldName: the leftover the assertion exists for —
    // and it also breaks the test subset.
    const result = gradeEdit(workspace, RENAME_GRADER);
    expect(result.score).toBe(0);
    expect(result.notes.some((n) => n.includes("must-not-match"))).toBe(true);
    expect(result.notes.some((n) => n.includes("test subset failed"))).toBe(true);
  });

  it("fails when the designated test subset fails even with a clean diff", () => {
    workspace = seedWorkspace();
    writeFileSync(
      join(workspace, "lib.js"),
      `function newName() { return 8 }\nmodule.exports = { newName };\n`, // wrong value
    );
    writeFileSync(
      join(workspace, "check.js"),
      `const { newName } = require('./lib');\nif (newName() !== 7) process.exit(1);\n`,
    );
    const result = gradeEdit(workspace, RENAME_GRADER);
    expect(result.score).toBe(0);
    expect(result.notes).toEqual([expect.stringContaining("test subset failed")]);
  });

  it("sees untracked files an agent added (diff assertions cover them)", () => {
    workspace = seedWorkspace();
    writeFileSync(join(workspace, "lib.js"), `function newName() { return 7 }\nmodule.exports = { newName };\n`);
    writeFileSync(
      join(workspace, "check.js"),
      `const { newName } = require('./lib');\nif (newName() !== 7) process.exit(1);\n`,
    );
    writeFileSync(join(workspace, "sneaky.js"), `const alias = oldName;\n`); // real leftover reference
    const result = gradeEdit(workspace, RENAME_GRADER);
    expect(result.score).toBe(0);
    expect(result.notes.some((n) => n.includes("must-not-match"))).toBe(true);
  });

  it("grading is read-only: the workspace git state is untouched", () => {
    workspace = seedWorkspace();
    writeFileSync(join(workspace, "lib.js"), `function newName() { return 7 }\nmodule.exports = { newName };\n`);
    writeFileSync(
      join(workspace, "check.js"),
      `const { newName } = require('./lib');\nif (newName() !== 7) process.exit(1);\n`,
    );
    const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" });
    gradeEdit(workspace, RENAME_GRADER);
    const statusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" });
    expect(statusAfter).toBe(statusBefore);
  });
});

describe("must-not-match tree exclusions (SK-D16 / SK-Q16)", () => {
  let workspace: string;
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  /**
   * A tiny committed git workspace seeded with the OLD name, then renamed to
   * newName in-place — so the diff carries the must-match token, exactly like
   * the passing rename case above. Caller adds index/binary artifacts after.
   */
  function seedRenamedWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "bench-skd16-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "lib.js"), `function oldName() { return 7 }\nmodule.exports = { oldName };\n`);
    writeFileSync(
      join(dir, "check.js"),
      `const { oldName } = require('./lib');\nif (oldName() !== 7) process.exit(1);\n`,
    );
    git("init", "-q");
    git("config", "user.email", "bench@test.invalid");
    git("config", "user.name", "Bench");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    // Perform the correct rename (produces a diff with newName, no oldName in source).
    writeFileSync(join(dir, "lib.js"), `function newName() { return 7 }\nmodule.exports = { newName };\n`);
    writeFileSync(
      join(dir, "check.js"),
      `const { newName } = require('./lib');\nif (newName() !== 7) process.exit(1);\n`,
    );
    return dir;
  }

  const RENAME_GRADER = {
    kind: "test-diff" as const,
    testCommand: ["node", "check.js"],
    mustMatch: ["newName"],
    mustNotMatch: ["\\boldName\\b"],
  };

  it("exclusion: forbidden token only inside .code-index/ does NOT trip must-not-match", () => {
    workspace = seedRenamedWorkspace();
    // The ONLY occurrence of oldName lives under .code-index/ (untracked, not gitignored).
    // Write it as raw bytes to mimic a SQLite DB whose stale pages hold the old name.
    execFileSync("mkdir", ["-p", join(workspace, ".code-index")]);
    writeFileSync(join(workspace, ".code-index", "index.db"), Buffer.from("SQLite\noldName\nstale\n", "utf8"));
    const result = gradeEdit(workspace, RENAME_GRADER);
    expect(result.score).toBe(1);
    expect(result.notes).toEqual([]);
  });

  it("exclusion: forbidden token inside a nested .code-index/ dir is also skipped", () => {
    workspace = seedRenamedWorkspace();
    execFileSync("mkdir", ["-p", join(workspace, "pkg", ".code-index")]);
    writeFileSync(join(workspace, "pkg", ".code-index", "shard.db"), Buffer.from("oldName held here\n", "utf8"));
    const result = gradeEdit(workspace, RENAME_GRADER);
    expect(result.score).toBe(1);
    expect(result.notes).toEqual([]);
  });

  it("exclusion: a binary file (NUL byte + forbidden token) is skipped", () => {
    workspace = seedRenamedWorkspace();
    // Binary artifact NOT under .code-index/ — excluded by the NUL-byte heuristic alone.
    writeFileSync(
      join(workspace, "artifact.bin"),
      Buffer.concat([Buffer.from("oldName"), Buffer.from([0x00]), Buffer.from("tail")]),
    );
    const result = gradeEdit(workspace, RENAME_GRADER);
    expect(result.score).toBe(1);
    expect(result.notes).toEqual([]);
  });

  it("over-exclusion control: forbidden token in a REAL source file STILL trips must-not-match", () => {
    workspace = seedRenamedWorkspace();
    // A genuine straggler in a text .ts source must not be silently excused by the fix.
    writeFileSync(join(workspace, "src-foo.ts"), `export const alias = oldName;\n`);
    const result = gradeEdit(workspace, RENAME_GRADER);
    expect(result.score).toBe(0);
    expect(result.notes.some((n) => n.includes("must-not-match"))).toBe(true);
  });

  it("over-exclusion control: a source file merely NAMED .code-index.ts is still scanned", () => {
    workspace = seedRenamedWorkspace();
    // Only a `.code-index/` DIRECTORY segment is excluded — not a filename substring.
    writeFileSync(join(workspace, "my.code-index.ts"), `export const alias = oldName;\n`);
    const result = gradeEdit(workspace, RENAME_GRADER);
    expect(result.score).toBe(0);
    expect(result.notes.some((n) => n.includes("must-not-match"))).toBe(true);
  });

  it("real-bug mirror: correct rename + .code-index/ DB holding the old name → passes", () => {
    workspace = seedRenamedWorkspace();
    // Source is a fully-correct rename (seed renamed oldName -> newName); the only
    // remaining oldName is inside the index DB the agent's reindex wrote.
    execFileSync("mkdir", ["-p", join(workspace, ".code-index")]);
    writeFileSync(
      join(workspace, ".code-index", "index.db"),
      Buffer.concat([Buffer.from("SQLite format 3\x00pages "), Buffer.from([0x00]), Buffer.from("oldName\x00")]),
    );
    writeFileSync(join(workspace, ".code-index", "index.db-wal"), Buffer.from("wal\x00oldName\x00stale"));
    const result = gradeEdit(workspace, RENAME_GRADER);
    expect(result).toEqual({ score: 1, notes: [] });
  });
});

describe("no network in any grader path (QA-902)", () => {
  it("the grader module imports only node builtins and local files", () => {
    const source = readFileSync(
      resolve(__dirname, "..", "benchmarks", "harness", "graders", "deterministic.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(
        specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../"),
        `unexpected dependency: ${specifier}`,
      ).toBe(true);
    }
    // And no dynamic network primitives anywhere in the module.
    expect(source).not.toMatch(/\bfetch\s*\(|require\(["'](https?|net|dns)/);
  });
});
