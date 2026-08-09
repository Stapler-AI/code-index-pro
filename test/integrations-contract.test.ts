import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SEED_TASKS } from "../benchmarks/seed-tasks";
import { TARGETS } from "../benchmarks/targets";
import type { BenchTask, GraderRef } from "../benchmarks/tasks";
import { TOOL_CATALOG } from "../src/server/tools";

/**
 * SK-D09 — content guardrails & contract test (skills PRD FR-301/302/303).
 *
 * Enforces, for BOTH shipped instruction artifacts, that they name every catalog
 * tool and no more, leak no benchmark-task strings, and are the single source of
 * the skill body. Every guardrail is a pure helper so the mutation cases can fire
 * it against in-test fixture COPIES (never the real shipped files).
 */

const PACKAGE_ROOT = resolve(__dirname, "..");

const ARTIFACTS = {
  skill: {
    label: "SKILL.md",
    path: join(PACKAGE_ROOT, "integrations", "claude", "skills", "code-index", "SKILL.md"),
  },
  agents: {
    label: "AGENTS.md",
    path: join(PACKAGE_ROOT, "integrations", "codex", "AGENTS.md"),
  },
} as const;

function readArtifact(path: string): string {
  return readFileSync(path, "utf8");
}

// ── Canonical tool list ──────────────────────────────────────────────────────
// Source of truth is the live server registration (TOOL_CATALOG), not a
// hand-copied array — so a tool added/removed there flips this test in both
// directions. docs/mcp-server.md is cross-checked to equal it (the doc catalog
// and the code catalog cannot silently diverge).

function catalogToolNames(): string[] {
  return TOOL_CATALOG.map((t) => t.name);
}

function docCatalogToolNames(): string[] {
  const doc = readFileSync(join(PACKAGE_ROOT, "docs", "mcp-server.md"), "utf8");
  const start = doc.indexOf("## Tool catalog");
  const end = doc.indexOf("\n## ", start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);
  const names = new Set<string>();
  // Table rows lead with `| `tool_name` | …`.
  for (const m of section.matchAll(/^\|\s*`([a-z][a-z0-9_]+)`\s*\|/gm)) names.add(m[1]);
  return [...names];
}

/**
 * Snake_case identifiers documented as tool PARAMETERS / RESPONSE FIELDS (not
 * tools). The "no tool-like name outside the catalog" check must not flag these.
 */
const KNOWN_NON_TOOL_IDENTIFIERS = new Set([
  "chunk_id",
  "symbol_id",
  "max_depth",
  "path_prefix",
  "index_age_seconds",
  "unresolved_edges",
]);

const SNAKE_CASE_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** Every catalog tool the artifact fails to name (completeness). */
function missingCatalogTools(text: string, catalog: string[]): string[] {
  return catalog.filter((tool) => !new RegExp(`\\b${tool}\\b`).test(text));
}

/** Snake_case tool-like tokens present that are neither catalog nor a known field. */
function unknownToolLikeTokens(text: string, catalog: string[]): string[] {
  const allowed = new Set([...catalog, ...KNOWN_NON_TOOL_IDENTIFIERS]);
  const found = new Set<string>();
  for (const m of text.matchAll(SNAKE_CASE_TOKEN)) {
    if (!allowed.has(m[0])) found.add(m[0]);
  }
  return [...found];
}

// ── Forbidden benchmark strings (leakage) ────────────────────────────────────
// Derived programmatically from the registry's id / target / grader-key fields.
// Only DISTINCTIVE tokens are kept — identifiers that can't be confused with
// ordinary prose (camelCase, PascalCase, digit-bearing, or slug/path shaped).
// Common single words (`errors`, `types`, `greet`, `add`) are deliberately not
// matched: the task's word-boundary rule accepts that they can't be told apart
// from prose, and matching them would false-positive on the artifacts.

function graderKeyStrings(grader: GraderRef): string[] {
  switch (grader.kind) {
    case "exact":
    case "judge":
      return [grader.key];
    case "set":
    case "path-line-set":
      return grader.key;
    case "test-diff":
      return [];
  }
}

function rawRegistryStrings(tasks: BenchTask[], targetNames: string[]): Set<string> {
  const raw = new Set<string>();
  for (const t of tasks) {
    raw.add(t.id);
    raw.add(t.target);
    for (const k of graderKeyStrings(t.grader)) raw.add(k);
  }
  for (const name of targetNames) raw.add(name);
  raw.add("zod"); // the oss-zod library's bare name (FR-302 target-name example)
  return raw;
}

function isDistinctiveToken(tok: string): boolean {
  if (tok.length < 4) return false;
  if (/[0-9]/.test(tok)) return true; // digit-bearing (task-id suffixes)
  if (/[a-z][A-Z]/.test(tok)) return true; // camelCase internal case change
  if (/^[A-Z][a-z]+[A-Z]/.test(tok)) return true; // PascalCase multi-word (ZodError)
  return false;
}

/** The forbidden-string set: distinctive identifier tokens + slug/path wholes. */
function forbiddenStrings(tasks: BenchTask[], targetNames: string[]): string[] {
  const raw = rawRegistryStrings(tasks, targetNames);
  const forbidden = new Set<string>();
  for (const s of raw) {
    // slug / path wholes (contain a separator) are matched as literal substrings
    if (/[-/:]/.test(s)) forbidden.add(s);
    for (const tok of s.split(/[^A-Za-z0-9_]+/)) {
      if (tok && isDistinctiveToken(tok)) forbidden.add(tok);
    }
  }
  return [...forbidden];
}

/** Which forbidden strings leak into the text (word-boundary for identifiers). */
function leakedStrings(text: string, forbidden: string[]): string[] {
  const hits: string[] = [];
  for (const s of forbidden) {
    if (/[^A-Za-z0-9_]/.test(s)) {
      if (text.includes(s)) hits.push(s); // path/slug -> literal substring
    } else {
      const re = new RegExp(`\\b${s}\\b`, "i"); // identifier -> word boundary
      if (re.test(text)) hits.push(s);
    }
  }
  return hits;
}

// ── Single source ────────────────────────────────────────────────────────────

/** Body with frontmatter and the codex HTML header stripped, for sampling. */
function artifactBody(text: string): string {
  let body = text;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end !== -1) body = body.slice(body.indexOf("\n", end + 4) + 1);
  }
  body = body.replace(/<!--[\s\S]*?-->/g, "");
  return body;
}

/**
 * A distinctive multi-word run sampled VERBATIM from the body — a fingerprint
 * that must appear character-for-character in a duplicated copy. Sampling a run
 * of plain prose words (no backticks, pipes, or newlines) keeps it long enough
 * to be unique while guaranteeing it exists literally in the artifact.
 */
function distinctiveSentence(text: string): string {
  const body = artifactBody(text);
  const runs = body
    // split on anything that would not survive verbatim in prose
    .split(/[`|\n]+/)
    .map((s) => s.replace(/[ \t]+/g, " ").trim())
    .filter((s) => s.split(" ").filter(Boolean).length >= 7);
  runs.sort((a, b) => b.length - a.length);
  if (runs.length === 0) throw new Error("no distinctive sentence found");
  return runs[0];
}

/**
 * Tracked files under `pathspec` (relative to PACKAGE_ROOT) containing
 * `sentence`. `git grep` scopes to tracked files, so the gitignored
 * `benchmarks/fixtures/` clone cache is never walked (fast, and it isn't part
 * of the shipped body).
 */
function trackedFilesContaining(pathspec: string, sentence: string): string[] {
  try {
    const out = execFileSync("git", ["grep", "-lF", "-e", sentence, "--", pathspec], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return []; // git grep exits 1 on no match
    throw err;
  }
}

/** Files under an arbitrary (possibly untracked) `dir` containing `sentence`. */
function filesContaining(dir: string, sentence: string): string[] {
  try {
    const out = execFileSync("grep", ["-rlF", "-e", sentence, dir], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
}

const CATALOG = catalogToolNames();
const TARGET_NAMES = Object.keys(TARGETS);
const FORBIDDEN = forbiddenStrings(SEED_TASKS, TARGET_NAMES);

describe("integrations contract guardrails (SK-D09 / FR-300)", () => {
  it("sources exactly 11 catalog tools, and the code and doc catalogs agree", () => {
    expect(CATALOG).toHaveLength(11);
    expect([...CATALOG].sort()).toEqual([...docCatalogToolNames()].sort());
  });

  describe.each(Object.values(ARTIFACTS))("$label", ({ path }) => {
    const text = readArtifact(path);

    it("names every catalog tool (completeness & freshness)", () => {
      expect(missingCatalogTools(text, CATALOG)).toEqual([]);
    });

    it("has no snake_case tool-like name outside the catalog", () => {
      expect(unknownToolLikeTokens(text, CATALOG)).toEqual([]);
    });

    it("leaks no benchmark-task id / target / key string", () => {
      expect(leakedStrings(text, FORBIDDEN)).toEqual([]);
    });

    it("is the single source of its body (not duplicated under benchmarks/)", () => {
      const sentence = distinctiveSentence(text);
      expect(trackedFilesContaining("benchmarks", sentence)).toEqual([]);
    });
  });
});

// ── Mutation self-verification ───────────────────────────────────────────────
// Each guardrail must FIRE on a mutated fixture copy. These assert against
// in-memory / temp copies; the real shipped files are never mutated.

describe("guardrail mutation self-verification (FR-300 acceptance)", () => {
  const skill = readArtifact(ARTIFACTS.skill.path);
  const agents = readArtifact(ARTIFACTS.agents.path);

  it("completeness: passes clean, fails when a tool name is removed", () => {
    // control
    expect(missingCatalogTools(skill, CATALOG)).toEqual([]);
    // mutation: strip every mention of one catalog tool from a copy
    const victim = CATALOG[0]; // "index_status"
    const mutated = skill.replace(new RegExp(victim, "g"), "index_stat");
    expect(missingCatalogTools(mutated, CATALOG)).toEqual([victim]);
  });

  it("freshness: fails when a fake 12th tool name is added", () => {
    // control
    expect(unknownToolLikeTokens(agents, CATALOG)).toEqual([]);
    // mutation: inject a snake_case tool-like name not in the catalog
    const mutated = `${agents}\nUse \`turbo_search { q }\` for fuzzy lookups.\n`;
    expect(unknownToolLikeTokens(mutated, CATALOG)).toContain("turbo_search");
  });

  it("leakage: passes clean, fails when a task id is inserted", () => {
    // control
    expect(leakedStrings(skill, FORBIDDEN)).toEqual([]);
    // mutation: paste a real benchmark task id into a copy
    const taskId = SEED_TASKS[0].id; // "sl-fixture-greet-001"
    expect(FORBIDDEN).toContain(taskId);
    const mutated = `${skill}\nSee example task ${taskId}.\n`;
    expect(leakedStrings(mutated, FORBIDDEN)).toContain(taskId);
  });

  it("leakage: fails when a seed-task symbol name is inserted", () => {
    // a distinctive PascalCase symbol from a grader key
    expect(FORBIDDEN).toContain("ZodError");
    const mutated = `${agents}\nExample: trace where ZodError is thrown.\n`;
    expect(leakedStrings(mutated, FORBIDDEN)).toContain("ZodError");
  });

  it("single-source: passes clean, fails when the body is duplicated under a benchmarks/ shadow", () => {
    const sentence = distinctiveSentence(skill);
    const shadow = mkdtempSync(join(tmpdir(), "sk-d09-benchmarks-"));
    try {
      // control: nothing there yet
      expect(filesContaining(shadow, sentence)).toEqual([]);
      // mutation: duplicate the skill body into a shadow benchmarks/ tree
      const dup = join(shadow, "copied-skill.md");
      writeFileSync(dup, skill);
      expect(filesContaining(shadow, sentence)).toEqual([dup]);
    } finally {
      rmSync(shadow, { recursive: true, force: true });
    }
  });
});

// ── SK-Q07 — SKILL.md budget & structure (FR-100 mechanical acceptance) ──────
// Owned by SK-Q07 (separate from SK-D09's guardrail blocks above). Enforces the
// mechanically-checkable FR-100 acceptance for the Claude SKILL.md artifact:
// line budget, trigger surface, the seven turn-budgeted recipes, the five
// prohibitions, and rules-before-recipes order. These assertions target recipe /
// turn-budget / prohibition *content* (not just line count) so they would fail
// on the pre-change skeleton that lacked turn budgets and several recipes.

describe("SKILL.md budget & structure", () => {
  const raw = readArtifact(ARTIFACTS.skill.path);

  // Parse & strip the `---`…`---` YAML frontmatter block, keeping both halves.
  function splitFrontmatter(text: string): { frontmatter: string; body: string } {
    expect(text.startsWith("---\n")).toBe(true);
    const end = text.indexOf("\n---", 4);
    expect(end).toBeGreaterThan(-1);
    const frontmatter = text.slice(4, end);
    const body = text.slice(text.indexOf("\n", end + 4) + 1);
    return { frontmatter, body };
  }

  const { frontmatter, body } = splitFrontmatter(raw);

  it("body is ≤ 150 lines excluding the frontmatter block", () => {
    // Ignore trailing blank lines so a stray newline at EOF is not "content".
    const lineCount = body.replace(/\s+$/, "").split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(150);
  });

  it("frontmatter declares name: code-index", () => {
    expect(frontmatter).toMatch(/^name:\s*code-index\s*$/m);
  });

  it("description fires on the trigger situations (FR-101)", () => {
    // The description spans folded YAML lines; assert against the whole
    // frontmatter, lower-cased, for the situation keywords FR-101 enumerates.
    const fm = frontmatter.toLowerCase();
    expect(fm).toContain("description");
    for (const situation of ["orient", "defined", "calls", "blast radius", "search", "rename"]) {
      expect(fm).toContain(situation);
    }
  });

  it("contains all seven recipe headings (FR-103)", () => {
    const recipes = [
      "Orientation",
      "Symbol lookup",
      "Callers / impact",
      "Concept localization",
      "Cross-file trace",
      "Rename / refactor",
      "Shape queries",
    ];
    for (const recipe of recipes) {
      // Recipe headings are bolded runs: **<name> (<turn budget>).**
      expect(body).toMatch(new RegExp(`\\*\\*${recipe}\\s*\\(`));
    }
    // Every recipe carries an explicit turn budget in its heading parenthesis.
    const budgeted = [...body.matchAll(/\*\*[^*]*?\((?:[^)]*turns?|edit-count[^)]*)\)/g)];
    expect(budgeted.length).toBeGreaterThanOrEqual(7);
  });

  it("states each of the five hard prohibitions (FR-104)", () => {
    // Keyword-level assertions that the required device appears in its rule.
    expect(body).toMatch(/No full-file `?Read`?/); // drill down, not whole-file Read
    expect(body).toContain("get_chunk"); // the drill-down substitute
    expect(body).toMatch(/No file content through Bash/);
    expect(body).toMatch(/`?cat`?/); // the Bash content-read verbs
    expect(body).toMatch(/No Grep for an?.*symbol/); // no Grep for index-resolvable symbol
    expect(body).toMatch(/Batch independent index calls/);
    expect(body).toMatch(/Answer when answered/); // no verification lap
  });

  it("names the after-edit reindex & corroboration correctness devices (FR-103)", () => {
    // Rename recipe: reindex then re-query the OLD name to prove zero stragglers.
    expect(body).toContain("reindex");
    expect(body).toMatch(/\bold\b/);
    // Callers recipe: high unresolved_edges → widen with search_code.
    expect(body).toContain("unresolved_edges");
    expect(body).toContain("search_code");
  });

  it("places the hard budget RULES section before the RECIPES section (FR-102)", () => {
    const rulesIdx = body.indexOf("## Hard budget rules");
    const recipesIdx = body.indexOf("## Recipes");
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(recipesIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeLessThan(recipesIdx);
  });
});

// ── SK-Q08 — AGENTS.md budget & structure (FR-200 mechanical acceptance) ──────
// Owned by SK-Q08 (separate from SK-D09's guardrail blocks and SK-Q07's SKILL.md
// block above). Enforces the mechanically-checkable FR-201/202/203/204 acceptance
// for the always-loaded Codex artifact: it carries an HTML template-comment
// header retained at the top, and its BODY (everything after that header) must
// stay within the ≤ 40-line per-session tax while still containing the "Not"
// routing table, the five prohibitions, and both named chains.

describe("AGENTS.md budget & structure", () => {
  const raw = readArtifact(ARTIFACTS.agents.path);

  // Strip a single leading `<!-- … -->` header block, returning the header and
  // the body that follows it (the body is what the ≤ 40-line budget bounds).
  // Deliberately strips ONLY the leading header — an inline comment later in the
  // file would still count against the body budget, matching FR-204 (a single
  // provenance header retained at the top).
  function splitHeader(text: string): { header: string; body: string } {
    const m = /^\s*<!--[\s\S]*?-->/.exec(text);
    expect(m).not.toBeNull();
    const header = (m as RegExpExecArray)[0];
    const body = text.slice((m as RegExpExecArray).index + header.length);
    return { header, body };
  }

  // Count body lines the same way the budget assertion does: ignore leading and
  // trailing blank lines so the header/body boundary newline and a stray EOF
  // newline are not counted as content.
  function bodyLineCount(body: string): number {
    return body.replace(/^\s+/, "").replace(/\s+$/, "").split("\n").length;
  }

  it("fixture: splitHeader excludes the header, leaving exactly the body lines", () => {
    // Pin the header-exclusion so the ≤ 40 line-count below is proven to strip
    // the header rather than accidentally passing. Known header (3 lines) + a
    // known body of exactly 4 content lines.
    const fixture = [
      "<!-- Template: line one",
      "     line two",
      "     line three -->",
      "",
      "## Heading",
      "body line a",
      "body line b",
      "tail line c",
      "",
    ].join("\n");
    const { header, body } = splitHeader(fixture);
    expect(header).toContain("Template: line one");
    expect(header).toContain("line three -->");
    // The header text must NOT survive into the counted body.
    expect(body).not.toContain("Template: line one");
    expect(body).not.toContain("line three -->");
    expect(bodyLineCount(body)).toBe(4);
  });

  const { header, body } = splitHeader(raw);

  it("retains a well-formed HTML comment header before the content (FR-204)", () => {
    // Header opens the file and is a complete `<!-- … -->` block.
    expect(raw.trimStart().startsWith("<!--")).toBe(true);
    expect(header).toMatch(/^\s*<!--[\s\S]*-->$/);
    // The routing/contract content begins only AFTER the header.
    expect(raw.indexOf("-->")).toBeLessThan(raw.indexOf("## Code navigation"));
  });

  it("body is ≤ 40 lines excluding the HTML comment header (FR-203)", () => {
    expect(bodyLineCount(body)).toBeLessThanOrEqual(40);
  });

  it("states each of the five hard prohibitions (FR-201)", () => {
    // Keyword-level: each of the five numbered rules names its device.
    expect(body).toMatch(/Never follow an index hit with a full-file Read/);
    expect(body).toContain("get_chunk"); // the drill-down substitute
    expect(body).toMatch(/Never route file content through Bash/);
    expect(body).toMatch(/`?cat`?/); // the Bash content-read verbs
    expect(body).toMatch(/Never Grep for a symbol name/);
    expect(body).toMatch(/Batch independent index calls/);
    // "answer — no confirmation re-reads" (no verification lap).
    expect(body).toMatch(/answer — no confirmation re-reads/);
  });

  it("contains both the callers/impact and rename chains (FR-202)", () => {
    // A single "chain, don't wander" line introduces the two named chains.
    expect(body).toMatch(/Chain, don't wander/);
    // Callers / impact chain.
    expect(body).toMatch(/who_calls.*impact_of_change/);
    // Rename chain: grep the OLD name end-to-end; a final zero-hit grep proves it
    // (SK-D19). `reindex` is matched from the body's conditional after-edit line,
    // not from the rename chain (which now forbids it).
    expect(body).toMatch(/\bRename:/);
    expect(body).toContain("reindex");
    expect(body).toMatch(/\bold\b/);
  });

  it("carries the routing table with a merged \"Not\" column (FR-201)", () => {
    // Table header row names the three columns; the "Not" column is present.
    expect(body).toMatch(/\|\s*Your question\s*\|\s*Use\s*\|\s*Not\s*\|/);
    // At least one routing row demotes a baseline tool in the Not column.
    expect(body).toMatch(/\|\s*Grep\s*\|/);
  });
});

// ── SK-Q09 — mutation-coverage audit & extensions (FR-301/302/303) ────────────
// SK-Q09 validates the VALIDATOR. SK-D09 already gives every guardrail a red+green
// pair:
//   completeness  — red: tool name stripped from a copy; green: clean control.
//   freshness     — red: fake 12th tool `turbo_search` injected; green: clean control.
//   leakage       — red: task id + red: `ZodError` symbol inserted; green: clean control.
//   single-source — red: body duplicated under a temp benchmarks/ shadow; green: empty dir.
// This block APPENDS the two mutation classes SK-Q09 calls out as thin/absent:
//   1. Symbol-name leakage via a *camelCase* seed symbol (a distinct forbidden
//      code path from SK-D09's PascalCase `ZodError`).
//   2. Catalog list-source drift with a DIRECTION-FLIP assertion, mutating an
//      in-test COPY of the catalog only (never src/server/tools.ts or mcp-server.md).
// It reuses SK-D09's exported-in-module helpers so it fires the real guardrail code.

describe("SK-Q09 — mutation-coverage extensions (FR-301/302/303)", () => {
  const skill = readArtifact(ARTIFACTS.skill.path);
  const agents = readArtifact(ARTIFACTS.agents.path);

  // FR-302 — leakage via a seed-task SYMBOL NAME, camelCase path. SK-D09 exercises
  // the PascalCase branch (`ZodError`, matched by isDistinctiveToken's
  // /^[A-Z][a-z]+[A-Z]/ rule). `parseUtil` — a real seed symbol, tokenised out of
  // the `./helpers/parseUtil` set-grader key of ci-zod-errorutil / ar-zod-external
  // — is forbidden via the OTHER distinctive-token rule (/[a-z][A-Z]/, camelCase),
  // and is matched as an identifier under the word-boundary path, not as a slug.
  it("leakage: fails on a camelCase seed-symbol name (distinct from ZodError's path)", () => {
    // The token is genuinely a camelCase identifier, so it proves the
    // /[a-z][A-Z]/ branch of the forbidden-set derivation, not the PascalCase one.
    expect(/[a-z][A-Z]/.test("parseUtil")).toBe(true);
    expect(FORBIDDEN).toContain("parseUtil");
    // control: both shipped artifacts are clean of it
    expect(leakedStrings(skill, FORBIDDEN)).not.toContain("parseUtil");
    expect(leakedStrings(agents, FORBIDDEN)).not.toContain("parseUtil");
    // mutation: paste the symbol into a copy — word-boundary identifier match fires
    const mutated = `${agents}\nExample: import the helper from parseUtil.\n`;
    expect(leakedStrings(mutated, FORBIDDEN)).toContain("parseUtil");
  });

  // FR-301 — catalog list-source drift. SK-D09's completeness/freshness cases
  // mutate the ARTIFACT against the real catalog. Here we instead mutate a COPY of
  // the canonical catalog and assert the completeness check FLIPS DIRECTION:
  //   • a tool PRESENT in the artifact but ABSENT from the catalog is caught, and
  //   • a tool PRESENT in the catalog but ABSENT from the artifact is caught.
  // The real src/server/tools.ts / docs/mcp-server.md are never touched.
  it("source-drift: unmutated catalog copy passes both directions (green control)", () => {
    const copy = [...CATALOG];
    expect(missingCatalogTools(skill, copy)).toEqual([]);
    expect(unknownToolLikeTokens(skill, copy)).toEqual([]);
  });

  it("source-drift: a tool REMOVED from the catalog copy is caught as artifact-present/catalog-absent", () => {
    // Drop a real tool from a COPY of the canonical list. The artifact still names
    // it (correctly), so the "no tool-like name outside the catalog" check must now
    // flag it — the opposite direction from SK-D09's completeness mutation.
    const victim = CATALOG[0]; // "index_status"
    const drifted = CATALOG.filter((t) => t !== victim);
    // completeness does NOT fire (the catalog no longer expects it)…
    expect(missingCatalogTools(skill, drifted)).toEqual([]);
    // …but freshness DOES: the artifact names a tool the (drifted) catalog omits.
    expect(unknownToolLikeTokens(skill, drifted)).toContain(victim);
  });

  it("source-drift: a tool ADDED to the catalog copy is caught as catalog-present/artifact-absent", () => {
    // Add a phantom tool to a COPY of the canonical list. No artifact names it, so
    // completeness must report it missing (catalog grew, artifact did not).
    const phantom = "phantom_tool";
    expect(CATALOG).not.toContain(phantom);
    const drifted = [...CATALOG, phantom];
    expect(missingCatalogTools(skill, drifted)).toEqual([phantom]);
    expect(missingCatalogTools(agents, drifted)).toEqual([phantom]);
  });
});

// ── SK-Q17 — AGENTS.md anti-wander guidance lock (SK-D17 regression guard) ────
// Owned by SK-Q17 (separate from the SK-D09/SK-Q07/SK-Q08/SK-Q09 blocks above).
// SK-D17 shipped four anti-wander edits to the always-loaded Codex AGENTS.md that
// the existing SK-Q08 budget assertions match only through loose regexes — so a
// silent revert of the NEW content would leave SK-Q08 green. These KEYWORD-level
// assertions pin the specific anti-wander guidance: they tolerate minor rewording
// but fail if any of the four devices is removed. Reuses SK-Q08's header-split so
// they read the same ≤ 40-line body, not the provenance header.

describe("AGENTS.md anti-wander guidance (SK-Q17 / SK-D17 lock)", () => {
  const raw = readArtifact(ARTIFACTS.agents.path);

  // Same leading-header strip as SK-Q08: assertions target the routing/contract
  // BODY, never the provenance comment header at the top of the file.
  function splitHeader(text: string): { header: string; body: string } {
    const m = /^\s*<!--[\s\S]*?-->/.exec(text);
    expect(m).not.toBeNull();
    const header = (m as RegExpExecArray)[0];
    const body = text.slice((m as RegExpExecArray).index + header.length);
    return { header, body };
  }

  const { body } = splitHeader(raw);

  it("makes the callers chain TERMINAL: answer from who_calls, don't re-verify (edit 1)", () => {
    // The callers/impact chain must instruct answering FROM who_calls' result and
    // NOT re-verifying with another tool. Keyword: an "answer … don't re-verify"
    // instruction anchored on who_calls being the caller set itself.
    expect(body).toMatch(/who_calls`?\s+IS\s+the\s+caller\s+set/i);
    expect(body).toMatch(/don't\s+re-verify|don't\s+re-run|answer\s+from\s+it/i);
    // The forbidden re-verification devices are named so removing the prohibition
    // (not just the phrasing) fails: a second who_calls / search_code / grep.
    expect(body).toMatch(/second\s+`?who_calls`?/i);
    expect(body).toMatch(/search_code/);
    expect(body).toMatch(/\bgrep\b/i);
  });

  it("keeps the unresolved_edges carve-out alongside the anti-wander rule (edit 1)", () => {
    // The corroboration device must COEXIST with the terminal-answer rule: answer
    // directly UNLESS unresolved_edges is high (then widen once). If SK-D17's edit
    // dropped the carve-out, the tool would over-trust an incomplete graph.
    expect(body).toContain("unresolved_edges");
    // The carve-out is a conditional widen ("unless … high", "then widen"),
    // not an unconditional stop.
    expect(body).toMatch(/unless[\s\S]{0,40}unresolved_edges[\s\S]{0,40}high|unresolved_edges[\s\S]{0,20}high/i);
    expect(body).toMatch(/widen/i);
  });

  it("Rule 5 forbids a repeat/bigger search_code with the uncached-token cost (edit 2)", () => {
    // Rule 5 was widened to forbid re-issuing a repeat OR bigger search_code (and a
    // second who_calls / grep "to be sure"). Pin both the repeat/bigger keyword and
    // that it is search_code being demoted.
    expect(body).toMatch(/repeat\/bigger|repeat or bigger|bigger `?search_code`?/i);
    expect(body).toMatch(/repeat[^\n]*`?search_code`?|`?search_code`?[^\n]*bigger/i);
    // The cost reason: an extra call re-sends context as FRESH / UNCACHED tokens.
    expect(body).toMatch(/uncached/i);
    expect(body).toMatch(/fresh[\s\S]{0,20}tokens|re-sends[\s\S]{0,60}tokens/i);
  });

  it("search_code routing warns against raw FTS punctuation (edit 3)", () => {
    // The search_code routing row carries an FTS5 punctuation warning so callers
    // don't feed it query syntax that errors. Keyword: FTS5 + "no raw" + the parens
    // / colon that error.
    expect(body).toMatch(/FTS5?/);
    expect(body).toMatch(/no raw/i);
    // The specific characters that error must be called out.
    expect(body).toContain("(");
    expect(body).toContain(")");
    expect(body).toContain(":");
    expect(body).toMatch(/error/i);
  });

  it("index_status opener is SCOPED — skippable for a single known-symbol lookup (edit 4)", () => {
    // The opener no longer mandates index_status unconditionally: it may be skipped
    // to go straight to find_symbol for one known-symbol lookup. Keyword: a "skip"
    // escape hatch tied to a single find_symbol lookup.
    expect(body).toMatch(/skip it|skip `?index_status`?/i);
    expect(body).toMatch(/go straight to `?find_symbol`?/i);
    expect(body).toMatch(/single[\s\S]{0,30}lookup|single known-symbol/i);
  });
});

// ── SK-Q19 — AGENTS.md cost-gate & grep-rename lock (SK-D19 regression guard) ─
// Owned by SK-Q19 (separate from the blocks above). SK-D19's tier-2 rewrite added
// a cost gate to the intro, re-scoped Rule 3, made the rename chain grep-centric
// (no reindex step), and made reindex conditional. SK-Q08/SK-Q17's loose regexes
// would stay green if any of these silently reverted to the tier-1 phrasing —
// e.g. SK-Q08's `toContain("reindex")` passes on both the old chain-step reindex
// and the new conditional line. These keyword pins tolerate minor rewording but
// fail on removal, and the final case proves each pin dies on the committed
// tier-1 phrasing (in-memory fixture only — the shipped file is never touched).

describe("AGENTS.md cost-gate & grep-rename (SK-Q19 / SK-D19 lock)", () => {
  const raw = readArtifact(ARTIFACTS.agents.path);

  // Same leading-header strip as SK-Q08/SK-Q17: assertions target the body,
  // never the provenance comment header at the top of the file.
  function splitHeader(text: string): { header: string; body: string } {
    const m = /^\s*<!--[\s\S]*?-->/.exec(text);
    expect(m).not.toBeNull();
    const header = (m as RegExpExecArray)[0];
    const body = text.slice((m as RegExpExecArray).index + header.length);
    return { header, body };
  }

  const { body } = splitHeader(raw);

  // The Rename bullet, from its bold label to end-of-body (it closes the file).
  // Scoping the rename pins to the bullet keeps the no-reindex negative from
  // false-firing on reindex mentions elsewhere in the body.
  function renameBullet(text: string): string {
    const m = /\*\*Rename:\*\*[\s\S]*$/.exec(text);
    expect(m).not.toBeNull();
    return (m as RegExpExecArray)[0];
  }

  it("intro carries the cost gate: fewest-total-calls plan, index-vs-direct, gate decides", () => {
    // Every-call-recosts framing resolved into a plan rule: fewest total calls.
    expect(body).toMatch(/fewest total calls/i);
    // Index earns its call by replacing many greps/reads…
    expect(body).toMatch(/replaces many greps/i);
    // …and the direct path stays open when one Grep / ranged Read settles it.
    expect(body).toMatch(/do that\s+directly/i);
    // The intro's closing contract: the table matches shapes, the GATE decides.
    expect(body).toMatch(/gate decides/i);
  });

  it("Rule 3 is scoped to symbols the index ALREADY resolved, not a blanket Grep ban", () => {
    // Tier-1 read "Never Grep for a symbol name — find_symbol/who_calls already
    // resolve it" (a blanket ban that outlaws the grep-centric rename chain).
    // Tier-2 scopes the ban to re-buying an answer the index already returned.
    expect(body).toMatch(/Never Grep for a symbol name[\s\S]{0,40}the index already resolved/i);
  });

  it("rename chain is grep-centric: grep old name → edit → zero-hit grep, NO reindex step", () => {
    const bullet = renameBullet(body);
    // Grep drives the chain: enumerate sites by grepping the old name…
    expect(bullet).toMatch(/grep the old name/i);
    // …and a final zero-hit grep is the proof of completion.
    expect(bullet).toMatch(/zero[\s\S]{0,5}hits/i);
    // The chain explicitly disclaims reindex ("no `reindex`").
    expect(bullet).toMatch(/no\s+\*{0,2}`?reindex/i);
    // And reindex must not reappear as a chain STEP (tier-1's "→ `reindex {}`").
    expect(bullet).not.toMatch(/→\s*\*{0,2}`?reindex/);
  });

  it("reindex is conditional — only if querying continues, never a closing step", () => {
    // Tier-1's unconditional "call `reindex {}` before trusting graph answers"
    // became a conditional: only if you will keep querying the graph.
    expect(body).toMatch(/reindex[^\n]*only if/i);
    expect(body).toMatch(/never as a closing step/i);
  });

  it("mutation: every pin above fails on the committed tier-1 phrasing (revert detector)", () => {
    // The four regions SK-D19 rewrote, reconstructed VERBATIM from the committed
    // tier-1 file (`git show HEAD:integrations/codex/AGENTS.md`). In-memory
    // fixture only.
    const tier1 = [
      "The `code-index` MCP tools answer structural questions in tens of tokens instead",
      "of the thousands that grep-and-read costs. Prefer them over Grep/Read whenever the",
      "question below matches; the baseline tools stay available for everything else.",
      "3. Never Grep for a symbol name — `find_symbol`/`who_calls` already resolve it.",
      "After editing files, call `reindex {}` before trusting graph answers.",
      "- **Rename:** `find_symbol` → `impact_of_change` → edit every site → `reindex {}` →",
      "  re-run `who_calls`/`search_code` on the old name to prove zero stragglers.",
    ].join("\n");
    // Cost-gate pins die (tier-1 intro has no gate).
    expect(tier1).not.toMatch(/fewest total calls/i);
    expect(tier1).not.toMatch(/replaces many greps/i);
    expect(tier1).not.toMatch(/do that\s+directly/i);
    expect(tier1).not.toMatch(/gate decides/i);
    // Rule-3 scope pin dies (tier-1 rule is the blanket ban).
    expect(tier1).not.toMatch(/Never Grep for a symbol name[\s\S]{0,40}the index already resolved/i);
    // Rename pins die: the tier-1 bullet exists but is index/reindex-centric.
    const bullet = renameBullet(tier1);
    expect(bullet).not.toMatch(/grep the old name/i);
    expect(bullet).not.toMatch(/no\s+\*{0,2}`?reindex/i);
    // …and the reindex-as-chain-step NEGATIVE fires (arrow into reindex present).
    expect(bullet).toMatch(/→\s*\*{0,2}`?reindex/);
    // Conditional-reindex pins die (tier-1 form is unconditional).
    expect(tier1).not.toMatch(/reindex[^\n]*only if/i);
    expect(tier1).not.toMatch(/never as a closing step/i);
  });
});
