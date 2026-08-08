import type { BenchTask } from "./tasks";

/**
 * Hand-authored seed task set (DEV-903, benchmark.md#task-generation source
 * 1): 2 tasks per category per target class, keys derived manually from the
 * pinned target sources (fixture BASE_FILES; zod v3.23.8; self at tag
 * bench-self-v1). Every Q&A prompt ends with an explicit answer-format
 * instruction so grading stays mechanical; edit-tier tasks target repos with
 * runnable test suites. All entries tagged "authored" + size class + language.
 */

const T = 300; // default timeout (s) for Q&A tasks
const EDIT_T = 600; // edits + a test-subset run need more headroom

export const SEED_TASKS: BenchTask[] = [
  // ── fixture-ts (QA-000 base fixture) ──────────────────────────────────────
  {
    id: "sl-fixture-greet-001",
    category: "symbol-lookup",
    style: "qa",
    target: "fixture-ts",
    prompt: "Where is the function `greet` defined? Answer with a single line as path:line.",
    grader: { kind: "path-line-set", key: ["src/greet.ts:5"] },
    timeoutSec: T,
    tags: ["authored", "small", "ts"],
  },
  {
    id: "sl-fixture-multiply-001",
    category: "symbol-lookup",
    style: "qa",
    target: "fixture-ts",
    prompt: "Where is the function `multiply` defined? Answer with a single line as path:line.",
    grader: { kind: "path-line-set", key: ["src/math.js:5"] },
    timeoutSec: T,
    tags: ["authored", "small", "js"],
  },
  {
    id: "ci-fixture-greet-callers-001",
    category: "callers-impact",
    style: "qa",
    target: "fixture-ts",
    prompt:
      "List every call site of the function `greet`, as path:line, one per line. Answer only with the list.",
    grader: { kind: "path-line-set", key: ["src/component.tsx:4"] },
    timeoutSec: T,
    tags: ["authored", "small", "tsx"],
  },
  {
    id: "ci-fixture-greet-impact-001",
    category: "callers-impact",
    style: "qa",
    target: "fixture-ts",
    prompt:
      "If the function `greet` changes, which other functions are transitively affected? List their names, one per line. Answer only with the list.",
    grader: { kind: "set", key: ["Hello"] },
    timeoutSec: T,
    tags: ["authored", "small", "tsx"],
  },
  {
    id: "bl-fixture-product-001",
    category: "bug-localization",
    style: "qa",
    target: "fixture-ts",
    prompt:
      "Which function returns the product of two numbers? Answer with a single line as path:line of its definition.",
    grader: { kind: "path-line-set", key: ["src/math.js:5"] },
    timeoutSec: T,
    tags: ["authored", "small", "js"],
  },
  {
    id: "bl-fixture-message-001",
    category: "bug-localization",
    style: "qa",
    target: "fixture-ts",
    prompt:
      "Which function builds the greeting message string? Answer with a single line as path:line of its definition.",
    grader: { kind: "path-line-set", key: ["src/greet.ts:5"] },
    timeoutSec: T,
    tags: ["authored", "small", "ts"],
  },
  {
    id: "ar-fixture-imports-001",
    category: "architecture",
    style: "qa",
    target: "fixture-ts",
    prompt:
      "List every local module imported by src/component.tsx, as the import specifier string exactly as written (e.g. './x'), one per line. Answer only with the list.",
    grader: { kind: "set", key: ["./greet"] },
    timeoutSec: T,
    tags: ["authored", "small", "tsx"],
  },
  {
    id: "ar-fixture-standalone-001",
    category: "architecture",
    style: "qa",
    target: "fixture-ts",
    prompt: "Does src/math.js import any other modules? Answer exactly 'yes' or 'no'.",
    grader: { kind: "exact", key: "no" },
    timeoutSec: T,
    tags: ["authored", "small", "js"],
  },
  {
    id: "cf-fixture-hello-greet-001",
    category: "cross-file-navigation",
    style: "qa",
    target: "fixture-ts",
    prompt:
      "The `Hello` component in src/component.tsx calls a function defined in another file. Give that function's definition location as path:line. Answer with a single line.",
    grader: { kind: "path-line-set", key: ["src/greet.ts:5"] },
    timeoutSec: T,
    tags: ["authored", "small", "tsx"],
  },
  {
    id: "cf-fixture-return-type-001",
    category: "cross-file-navigation",
    style: "qa",
    target: "fixture-ts",
    prompt:
      "Trace from the `greet` function to the interface that types its return value, and give that interface's definition location as path:line. Answer with a single line.",
    grader: { kind: "path-line-set", key: ["src/greet.ts:1"] },
    timeoutSec: T,
    tags: ["authored", "small", "ts"],
  },
  {
    id: "rr-fixture-add-sum-001",
    category: "rename-refactor",
    style: "edit",
    target: "fixture-ts",
    prompt:
      "Rename the exported function `add` to `sum` in src/math.js, updating every reference. Keep behavior identical.",
    grader: {
      kind: "test-diff",
      testCommand: ["node", "-e", "const m=require('./src/math.js'); if(m.sum(2,3)!==5) process.exit(1);"],
      mustMatch: ["\\bsum\\b"],
      mustNotMatch: ["\\badd\\b"],
    },
    timeoutSec: EDIT_T,
    tags: ["authored", "small", "js"],
  },
  {
    id: "rr-fixture-multiply-product-001",
    category: "rename-refactor",
    style: "edit",
    target: "fixture-ts",
    prompt:
      "Rename the exported function `multiply` to `product` in src/math.js, updating every reference. Keep behavior identical.",
    grader: {
      kind: "test-diff",
      testCommand: [
        "node",
        "-e",
        "const m=require('./src/math.js'); if(m.product(2,3)!==6) process.exit(1);",
      ],
      mustMatch: ["\\bproduct\\b"],
      mustNotMatch: ["\\bmultiply\\b"],
    },
    timeoutSec: EDIT_T,
    tags: ["authored", "small", "js"],
  },

  // ── oss-zod (zod v3.23.8) ─────────────────────────────────────────────────
  {
    id: "sl-zod-zoderror-001",
    category: "symbol-lookup",
    style: "qa",
    target: "oss-zod",
    prompt: "Where is the class `ZodError` defined? Answer with a single line as path:line.",
    grader: { kind: "path-line-set", key: ["src/ZodError.ts:197"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "sl-zod-zodstring-001",
    category: "symbol-lookup",
    style: "qa",
    target: "oss-zod",
    prompt: "Where is the class `ZodString` defined? Answer with a single line as path:line.",
    grader: { kind: "path-line-set", key: ["src/types.ts:672"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "ci-zod-zoderror-importers-001",
    category: "callers-impact",
    style: "qa",
    target: "oss-zod",
    prompt:
      "Which source files under src/ (excluding the __tests__ directory) import from the module './ZodError'? List them as repo-relative paths, one per line. Answer only with the list.",
    grader: {
      kind: "set",
      key: [
        "src/errors.ts",
        "src/external.ts",
        "src/helpers/parseUtil.ts",
        "src/locales/en.ts",
        "src/types.ts",
      ],
    },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "ci-zod-errorutil-importers-001",
    category: "callers-impact",
    style: "qa",
    target: "oss-zod",
    prompt:
      "Which source file under src/ (excluding the __tests__ directory) imports from './helpers/errorUtil'? Answer with the repo-relative path(s), one per line.",
    grader: { kind: "set", key: ["src/types.ts"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "bl-zod-getparsedtype-001",
    category: "bug-localization",
    style: "qa",
    target: "oss-zod",
    prompt:
      "Which function inspects a runtime value and returns its ZodParsedType? Answer with a single line as path:line of its definition.",
    grader: { kind: "path-line-set", key: ["src/helpers/util.ts:166"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "bl-zod-quotelessjson-001",
    category: "bug-localization",
    style: "qa",
    target: "oss-zod",
    prompt:
      "Which exported value formats a Zod error object as quoteless JSON? Answer with a single line as path:line of its definition.",
    grader: { kind: "path-line-set", key: ["src/ZodError.ts:175"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "ar-zod-barrel-001",
    category: "architecture",
    style: "qa",
    target: "oss-zod",
    prompt:
      "The package barrel src/index.ts re-exports everything from a single module. Name that module as the import specifier string exactly as written. Answer with a single line.",
    grader: { kind: "exact", key: "./external" },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "ar-zod-external-fanout-001",
    category: "architecture",
    style: "qa",
    target: "oss-zod",
    prompt:
      "List every module that src/external.ts re-exports from, as the import specifier strings exactly as written, one per line. Answer only with the list.",
    grader: {
      kind: "set",
      key: ["./errors", "./helpers/parseUtil", "./helpers/typeAliases", "./helpers/util", "./types", "./ZodError"],
    },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "cf-zod-barrel-to-zodstring-001",
    category: "cross-file-navigation",
    style: "qa",
    target: "oss-zod",
    prompt:
      "Starting from the public barrel src/index.ts, follow the re-export chain to the file that defines `ZodString`. Give that file's repo-relative path. Answer with a single line.",
    grader: { kind: "exact", key: "src/types.ts" },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "cf-zod-issuecode-001",
    category: "cross-file-navigation",
    style: "qa",
    target: "oss-zod",
    prompt:
      "Trace where the `ZodIssueCode` value (the const, not the type) is constructed, and give its definition location as path:line. Answer with a single line.",
    grader: { kind: "path-line-set", key: ["src/ZodError.ts:18"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "rr-zod-quotelessjson-001",
    category: "rename-refactor",
    style: "edit",
    target: "oss-zod",
    prompt:
      "Rename the exported const `quotelessJson` to `formatQuotelessJson` throughout the repository, including the deno/lib mirror, updating every reference. Keep behavior identical.",
    grader: {
      kind: "test-diff",
      testCommand: ["npx", "jest", "--config", "./configs/ts-jest.config.json", "src/__tests__/error.test.ts"],
      mustMatch: ["\\bformatQuotelessJson\\b"],
      mustNotMatch: ["\\bquotelessJson\\b"],
    },
    timeoutSec: EDIT_T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "rr-zod-getparsedtype-001",
    category: "rename-refactor",
    style: "edit",
    target: "oss-zod",
    prompt:
      "Rename the exported const `getParsedType` to `parsedTypeOf` throughout the repository, including the deno/lib mirror, updating every reference. Keep behavior identical.",
    grader: {
      kind: "test-diff",
      testCommand: ["npx", "jest", "--config", "./configs/ts-jest.config.json", "src/__tests__/string.test.ts"],
      mustMatch: ["\\bparsedTypeOf\\b"],
      mustNotMatch: ["\\bgetParsedType\\b"],
    },
    timeoutSec: EDIT_T,
    tags: ["authored", "medium", "ts"],
  },

  // ── self (this repo at tag bench-self-v1) ─────────────────────────────────
  {
    id: "sl-self-runpipeline-001",
    category: "symbol-lookup",
    style: "qa",
    target: "self",
    prompt: "Where is the function `runPipeline` defined? Answer with a single line as path:line.",
    grader: { kind: "path-line-set", key: ["src/pipeline/run.ts:67"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "sl-self-replacechunks-001",
    category: "symbol-lookup",
    style: "qa",
    target: "self",
    prompt: "Where is the function `replaceChunks` defined? Answer with a single line as path:line.",
    grader: { kind: "path-line-set", key: ["src/storage/writes.ts:77"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "ci-self-replacechunks-callers-001",
    category: "callers-impact",
    style: "qa",
    target: "self",
    prompt:
      "List every call site of the function `replaceChunks`, as path:line, one per line. Answer only with the list.",
    grader: { kind: "path-line-set", key: ["src/storage/writes.ts:173"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "ci-self-runpipeline-callers-001",
    category: "callers-impact",
    style: "qa",
    target: "self",
    prompt:
      "List every call site of the function `runPipeline`, as path:line, one per line. Answer only with the list.",
    grader: { kind: "path-line-set", key: ["src/cli.ts:37", "src/server/tools.ts:144"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "bl-self-quarantine-001",
    category: "bug-localization",
    style: "qa",
    target: "self",
    prompt:
      "Which function renames a corrupt database file aside (quarantines it)? Answer with a single line as path:line of its definition.",
    grader: { kind: "path-line-set", key: ["src/storage/health.ts:71"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "bl-self-byteoffset-001",
    category: "bug-localization",
    style: "qa",
    target: "self",
    prompt:
      "Which function converts tree-sitter UTF-16 string indices into byte offsets? Answer with a single line as path:line of its definition.",
    grader: { kind: "path-line-set", key: ["src/pipeline/chunks.ts:87"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "ar-self-cli-imports-001",
    category: "architecture",
    style: "qa",
    target: "self",
    prompt:
      "List the local modules imported by src/cli.ts, as the import specifier strings exactly as written, one per line. Answer only with the list.",
    grader: {
      kind: "set",
      key: ["./graph/hooks", "./pipeline/run", "./server/server", "./storage/database", "./storage/health"],
    },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "ar-self-layering-001",
    category: "architecture",
    style: "qa",
    target: "self",
    prompt:
      "Describe the dependency layering between the CLI (src/cli.ts), the indexing pipeline (src/pipeline/), and the storage layer (src/storage/) — state which layer depends on which. Answer in 2-3 sentences.",
    grader: {
      kind: "judge",
      rubric:
        "Award full credit only if the answer states the dependency direction CLI -> pipeline -> storage (the CLI drives the pipeline; the pipeline persists through storage) without inverting any edge. Partial credit for the correct direction with a missing layer. No credit for an inverted or absent direction.",
      key: "The CLI (src/cli.ts) depends on the pipeline (src/pipeline/run.ts), which depends on the storage layer (src/storage/writes.ts). Dependencies flow one way: CLI -> pipeline -> storage; storage does not import the pipeline or the CLI.",
    },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "cf-self-cli-to-writefile-001",
    category: "cross-file-navigation",
    style: "qa",
    target: "self",
    prompt:
      "Starting from src/cli.ts, trace to the function that persists one file's rows (chunks, symbols, edges) atomically in a single transaction. Give its definition location as path:line. Answer with a single line.",
    grader: { kind: "path-line-set", key: ["src/storage/writes.ts:170"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "cf-self-index-hooks-001",
    category: "cross-file-navigation",
    style: "qa",
    target: "self",
    prompt:
      "The CLI's index command runs the pipeline with a set of graph hooks. Give the path:line where `graphHooks` is defined. Answer with a single line.",
    grader: { kind: "path-line-set", key: ["src/graph/hooks.ts:11"] },
    timeoutSec: T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "rr-self-pruneunseen-001",
    category: "rename-refactor",
    style: "edit",
    target: "self",
    prompt:
      "Rename the exported function `pruneUnseenFiles` to `removeUnseenFiles` throughout the repository, including its test references, updating every use. Keep behavior identical.",
    grader: {
      kind: "test-diff",
      // test/prune.test.ts imports pruneUnseenFiles directly, so it both
      // exercises the rename and must itself be updated to pass.
      testCommand: ["npx", "vitest", "run", "test/prune.test.ts"],
      mustMatch: ["\\bremoveUnseenFiles\\b"],
      mustNotMatch: ["\\bpruneUnseenFiles\\b"],
    },
    timeoutSec: EDIT_T,
    tags: ["authored", "medium", "ts"],
  },
  {
    id: "rr-self-makebyteoffset-001",
    category: "rename-refactor",
    style: "edit",
    target: "self",
    prompt:
      "Rename the exported function `makeByteOffset` to `byteOffsetFor` throughout src/, updating every reference. Keep behavior identical.",
    grader: {
      kind: "test-diff",
      testCommand: ["npx", "vitest", "run", "test/chunks.test.ts"],
      mustMatch: ["\\bbyteOffsetFor\\b"],
      mustNotMatch: ["\\bmakeByteOffset\\b"],
    },
    timeoutSec: EDIT_T,
    tags: ["authored", "medium", "ts"],
  },
];
