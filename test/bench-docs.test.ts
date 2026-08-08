import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBenchArgs } from "../benchmarks/harness/run";

/**
 * SK-Q14 — mechanical docs-accuracy checks for SK-D14's docs (not prose review):
 *  1. Every `bench run` command in benchmarks/README.md's fenced blocks parses
 *     via the shipped `parseBenchArgs` (arms valid, --runs numeric, --model present).
 *     The `bench report` command's flags are asserted against the documented parser
 *     surface (there is no exported report-arg parser — benchReport is private).
 *  2. The two pointer files reference a `docs/skills/` path that exists on disk.
 */

const REPO_ROOT = resolve(__dirname, "..");
const README = resolve(REPO_ROOT, "benchmarks/README.md");

/** Extract the text inside every ```-fenced code block. */
function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) blocks.push(m[1]);
  return blocks;
}

/**
 * Join shell backslash-continuation lines within a block into single logical
 * command lines, so a multi-line `bench run … \` invocation is one line.
 */
function logicalLines(block: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.endsWith("\\")) {
      buf += line.slice(0, -1) + " ";
      continue;
    }
    buf += line;
    out.push(buf.trim());
    buf = "";
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Tokenize a shell command on whitespace (the doc commands use no quoting). */
function tokenize(line: string): string[] {
  return line.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Strip a doc invocation down to the harness args parseBenchArgs sees.
 * Drops any leading `ENV=val` assignments, the `npm run bench --` (or
 * `npm run bench:generate`) wrapper, and the `run` subcommand — mirroring
 * main()'s `parseBenchArgs(argv.slice(1))` after the `run` dispatch.
 */
function harnessArgsAfter(subcommand: "run" | "report", tokens: string[]): string[] {
  let t = tokens.slice();
  while (t.length > 0 && /^[A-Z_][A-Z0-9_]*=/.test(t[0])) t = t.slice(1); // env prefixes
  const sep = t.indexOf("--"); // npm run bench -- <sub> …
  if (sep !== -1) t = t.slice(sep + 1);
  const sub = t.indexOf(subcommand);
  return sub === -1 ? [] : t.slice(sub + 1);
}

interface DocCommand {
  subcommand: "run" | "report";
  args: string[];
  raw: string;
}

/** A placeholder token stands in for a value the reader supplies. */
const isPlaceholder = (tok: string | undefined): boolean =>
  tok === undefined || tok === "..." || /^<.+>$/.test(tok);

/**
 * A runnable command has no placeholder in a slot parseBenchArgs *validates*
 * (--arms, --runs). Lines like `--arms ... --model ...` are syntax
 * illustrations, not copy-paste-runnable invocations, and are excluded from
 * the parse assertions. (A `<model-id>` value is fine — model isn't validated.)
 */
function isRunnable(args: string[]): boolean {
  for (const flag of ["--arms", "--runs"]) {
    const i = args.indexOf(flag);
    if (i !== -1 && isPlaceholder(args[i + 1])) return false;
  }
  return true;
}

/** Every runnable logical line across every fenced block invoking bench run/report. */
function benchCommands(markdown: string): DocCommand[] {
  const cmds: DocCommand[] = [];
  for (const block of fencedBlocks(markdown)) {
    for (const line of logicalLines(block)) {
      const tokens = tokenize(line);
      // Only lines that actually invoke the bench harness via npm run bench.
      if (!tokens.some((tok) => tok === "bench" || tok === "run" || tok === "report")) continue;
      if (!/npm run bench(\b|:)/.test(line)) continue;
      if (tokens.includes("run") && line.includes("bench -- run")) {
        const args = harnessArgsAfter("run", tokens);
        if (!isRunnable(args)) continue; // skip syntax-illustration lines
        cmds.push({ subcommand: "run", args, raw: line });
      } else if (tokens.includes("report") && line.includes("bench -- report")) {
        cmds.push({ subcommand: "report", args: harnessArgsAfter("report", tokens), raw: line });
      }
    }
  }
  return cmds;
}

describe("SK-Q14 — README demonstration/protocol commands parse", () => {
  const markdown = readFileSync(README, "utf8");
  const commands = benchCommands(markdown);

  it("extracts bench run and bench report commands from the fenced blocks", () => {
    const runs = commands.filter((c) => c.subcommand === "run");
    const reports = commands.filter((c) => c.subcommand === "report");
    // The demonstration protocol alone has two `bench run` blocks + one report;
    // Quick start / Use sections add more. Guard against extraction silently
    // matching nothing (which would make every assertion below vacuous).
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(reports.length).toBeGreaterThanOrEqual(1);
  });

  it("has the demonstration protocol run commands (all, runs 4, pinned models)", () => {
    const protocolRuns = commands.filter(
      (c) =>
        c.subcommand === "run" &&
        c.args.includes("all") &&
        c.args[c.args.indexOf("--runs") + 1] === "4",
    );
    // Two protocol arms: claude (claude-opus-4-8) and codex (gpt-5.5).
    const models = protocolRuns.map((c) => c.args[c.args.indexOf("--model") + 1]);
    expect(models).toContain("claude-opus-4-8");
    expect(models).toContain("gpt-5.5");
  });

  describe.each(
    benchCommands(readFileSync(README, "utf8"))
      .filter((c) => c.subcommand === "run")
      .map((c) => [c.raw, c] as const),
  )("bench run: %s", (_raw, cmd) => {
    it("parses via parseBenchArgs without throwing", () => {
      expect(() => parseBenchArgs(cmd.args)).not.toThrow();
    });

    it("names all valid arms, numeric --runs, and --model present", () => {
      // --model present in the documented command (parseBenchArgs itself
      // defaults model to "" without throwing; presence is a doc requirement).
      expect(cmd.args).toContain("--model");
      const model = cmd.args[cmd.args.indexOf("--model") + 1];
      expect(model && model.length > 0).toBe(true);

      const parsed = parseBenchArgs(cmd.args);
      // parseBenchArgs already threw on any unknown arm; assert arms non-empty.
      expect(parsed.arms.length).toBeGreaterThan(0);
      expect(Number.isInteger(parsed.runs)).toBe(true);
      expect(parsed.runs).toBeGreaterThanOrEqual(1);
    });
  });

  // No exported `bench report` arg parser (benchReport is private in run.ts), so
  // assert the report command's flags against the documented parser surface:
  // --name / --date / --results, each with a value, no unknown flags.
  describe.each(
    benchCommands(readFileSync(README, "utf8"))
      .filter((c) => c.subcommand === "report")
      .map((c) => [c.raw, c] as const),
  )("bench report: %s", (_raw, cmd) => {
    const REPORT_FLAGS = new Set(["--name", "--date", "--results"]);

    it("uses only documented report flags, each with a value", () => {
      for (let i = 0; i < cmd.args.length; i++) {
        const tok = cmd.args[i];
        if (tok.startsWith("--")) {
          expect(REPORT_FLAGS.has(tok)).toBe(true);
          expect(cmd.args[i + 1]).toBeDefined();
          expect(cmd.args[i + 1].startsWith("--")).toBe(false);
          i++; // consume the value
        }
      }
    });
  });
});

describe("SK-Q14 — pointer files reference an existing docs/skills/ path", () => {
  const pointerFiles = [
    resolve(REPO_ROOT, "docs/agent-skills.md"),
    resolve(REPO_ROOT, "integrations/README.md"),
  ];

  it.each(pointerFiles)("%s references docs/skills/", (file) => {
    const text = readFileSync(file, "utf8");
    // Markdown links to docs/skills/ are written relative to the file's dir
    // (e.g. `skills/` from docs/, `../docs/skills/` from integrations/).
    const linkTargets = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    const skillLinks = linkTargets.filter((t) => /(^|\/)skills\//.test(t) || /docs\/skills/.test(t));
    expect(skillLinks.length).toBeGreaterThan(0);

    // The referenced path must resolve to something that exists on disk.
    const resolvedExists = skillLinks.some((link) => {
      const clean = link.split("#")[0].replace(/\/$/, "");
      return existsSync(resolve(dirname(file), clean));
    });
    expect(resolvedExists).toBe(true);
  });

  it("docs/skills/ directory exists and holds the referenced docs", () => {
    const dir = resolve(REPO_ROOT, "docs/skills");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(resolve(dir, "prd.md"))).toBe(true);
    expect(existsSync(resolve(dir, "tasks.md"))).toBe(true);
  });
});
