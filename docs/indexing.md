# Indexing Pipeline

How the working tree becomes rows in the [database](schema.md). The discovery, hashing, and chunking stages are ported from the Swift reference implementation (`CodeIndexService.swift`, `TreeSitterService.swift`); symbol/edge extraction and resolution are new.

## Pipeline overview

```
discover → filter → hash/diff → parse → chunk → extract symbols & edges → resolve edges → persist → prune stale
```

Each changed file flows through parse→persist independently (one transaction per file); edge resolution runs once per indexing run, after all changed files are written.

## File discovery

```
git ls-files --cached --others --exclude-standard
```

run from the repo root. This lists tracked + untracked-but-not-ignored files, so `.gitignore` handling comes for free. Paths under `.code-index/` are excluded explicitly.

**Non-git fallback:** if the directory is not a git repository, walk it with a glob, skipping `node_modules`, `.git`, hidden directories, and `.code-index`.

## Language detection

By file extension, ported from `SupportedLanguage.from(extension:)` in the Swift reference:

| Extensions | Language | v1 |
|---|---|---|
| `js`, `mjs`, `cjs`, `jsx` | `javascript` | ✅ (grammar already a dependency) |
| `ts`, `mts`, `cts` | `typescript` | ✅ |
| `tsx` | `tsx` | ✅ |
| `json` | `json` | staged |
| `py`, `pyw` | `python` | staged |
| `c`, `h` | `c` | staged |
| `html`, `htm` | `html` | staged |
| `sh`, `bash`, `zsh` | `bash` | staged |
| `css` | `css` | staged |
| `swift` | `swift` | staged (grammar availability on npm to be confirmed) |

**v1 ships JavaScript + TypeScript + TSX** (`tree-sitter-javascript` is already installed; add `tree-sitter-typescript`, which provides both `typescript` and `tsx` grammars). The remaining rows are the roadmap; each added language needs its grammar dependency, a `meaningfulNodeTypes` set, and `.scm` query files.

Files with unrecognized extensions are skipped entirely.

## Change detection

Per discovered file:

1. **Skip files larger than 1 MB** (generated bundles, lockfile-sized JSON).
2. **Skip non-UTF-8 files** (binary detection: decode failure).
3. Compute **SHA-256** of the raw bytes.
4. If a row exists in `indexed_files` with the same `relative_path` and `file_hash`, **skip** — the file is unchanged.

At the end of every run, **prune stale entries**: any `indexed_files` row whose `relative_path` was not seen during discovery is deleted; `ON DELETE CASCADE` removes its chunks, symbols, and edges.

This makes every run incremental by default — a "full" index is just a run against an empty database.

## Chunk extraction

The file is parsed with tree-sitter, and the tree is walked recursively. A node becomes a `code_chunks` row when its type is in the language's **meaningful node types** allowlist (ported from `TreeSitterService.swift`):

**javascript:**
```
function_declaration, class_declaration, method_definition, arrow_function,
variable_declarator, export_statement, import_statement, lexical_declaration,
variable_declaration, generator_function_declaration, field_definition
```

**typescript / tsx** (superset direction — adds type constructs):
```
function_declaration, class_declaration, method_definition, arrow_function,
variable_declarator, export_statement, import_statement, interface_declaration,
type_alias_declaration, enum_declaration, lexical_declaration
```

Per matched node:

- `node_name` — text of the node's `name` field when tree-sitter exposes one (most declarations do).
- `context_path` — the chain of *meaningful* ancestor node types plus the node itself, joined with `" > "` (e.g. `class_declaration > method_definition`). Non-meaningful intermediate nodes don't appear.
- `depth` — count of meaningful ancestors; `0` at top level. The walk only increments depth when passing through a meaningful node.
- `start_line`/`end_line` are 1-indexed; `start_byte`/`end_byte` are raw byte offsets usable to slice the file.
- `content` — the node's source text, **capped at 2000 characters** with `...` appended when truncated.

> **Recorded tradeoff:** the 2000-char cap keeps the database and FTS index bounded, but text beyond the cap is invisible to `search_code`. Byte offsets always allow retrieving the full region from the live file. Revisit the cap if search misses become a real problem.

Note that nested meaningful nodes each get their own chunk — a class produces a chunk *and* each of its methods produces a chunk. Retrieval favors the most specific chunk; `context_path` disambiguates.

## Symbol and edge extraction (new)

During the same parse (no second parse), a set of per-language **tree-sitter query files** (`.scm`) runs against the tree:

```
queries/
  javascript/
    symbols.scm    # declarations → symbols rows
    edges.scm      # calls / imports / exports / extends / references
  typescript/
    symbols.scm
    edges.scm      # includes implements, type references
```

What the queries capture:

- **Declarations** → `symbols` rows: functions, classes, methods, exported consts/lets holding functions or values, interfaces, type aliases, enums. `kind` is mapped from the node type; `signature` is assembled from the parameter list and (in TS) the return type annotation; `exported` is set when the declaration sits under an `export_statement` or is assigned to `module.exports`.
- **`call_expression`** → `calls` edges: callee identifier (or the property name for `obj.method()` — see [limitations](#known-limitations)).
- **`import_statement`** → `imports` edges: one edge per imported specifier, with `target_module` set to the source string (`'./db'`, `'react'`).
- **`export_statement`** → `exports` edges (file → its own symbol).
- **`extends` / `implements` clauses** → `extends` / `implements` edges.
- **Other identifier references** to known symbol names (e.g. a function passed as a callback) → `references` edges.

Each edge records its `source_symbol_id` — the innermost enclosing symbol, or `NULL` at file scope — plus `target_name` (always) and `line`.

## Edge resolution

Extraction writes edges with `target_symbol_id = NULL`. A **resolution pass** runs after all changed files are persisted:

1. **Import-based resolution (preferred).** For an edge inside file F referencing name N: if F imports N from specifier S, resolve S to a repo file using simplified Node resolution (relative path + extension guessing `[.js, .ts, .tsx, /index.*]`; `package.json` `exports` maps and tsconfig path aliases are out of scope for v1). Look up a symbol named N (or the default export) in that file → set `target_symbol_id`.
2. **Same-file resolution.** If N is declared in F itself, link to that symbol.
3. **Unique-name fallback.** If exactly one exported symbol named N exists repo-wide, link to it.
4. **Otherwise leave unresolved** — external package, dynamic construct, or ambiguous name. `target_name`/`target_module` still make the edge useful (e.g. module maps, grep-grade caller lists).

**Incremental invariant.** When file F is re-indexed:

- Edges *from* F are deleted and re-extracted (cascade handles this).
- Edges *elsewhere* whose `target_name` matches any symbol name F **gained or lost** are re-resolved (cheap via `idx_edges_target_name`). This keeps inbound links correct without touching unrelated edges.

## Known limitations

Stated so both agents and developers treat graph answers as best-effort:

- **No type inference.** `obj.method()` resolves by method name only; two classes with a `save()` method are indistinguishable to the resolver (the edge stays unresolved or falls back to unique-name).
- **Dynamic constructs are invisible:** computed property calls, `require(variable)`, dynamic `import()` with non-literal specifiers, dependency-injection patterns.
- **Re-exports (`export * from`)** and **import aliasing** (`import { a as b }`) are followed only one level in v1.
- **Resolution is repo-local.** Edges into `node_modules` stay unresolved by design (`target_module` still identifies the package).

## CLI entry points (planned)

| Command | Does |
|---|---|
| `code-index index [path]` | Incremental index run (full on first run). `--full` clears first. |
| `code-index stats` | Print `index_status` equivalent: files/chunks/symbols per language, unresolved-edge count, last run. |
| `code-index clear` | Delete all rows (or the whole `.code-index/` directory). |
| `code-index watch` | *(future)* fs-events driven incremental re-index. |

The [MCP server](mcp-server.md) invokes the same pipeline in-process (`reindex` tool and on startup).
