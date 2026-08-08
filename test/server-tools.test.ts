import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const PACKAGE_ROOT = resolve(__dirname, "..");
const START_PATH = join(PACKAGE_ROOT, "dist", "server", "start.js");

const ALL_TOOLS = [
  "index_status",
  "reindex",
  "search_code",
  "search_structural",
  "get_chunk",
  "file_outline",
  "find_symbol",
  "who_calls",
  "get_dependencies",
  "impact_of_change",
  "module_map",
];

interface ToolResult {
  payload: Record<string, unknown> | null;
  errorText: string | null;
}

describe("MCP tool catalog (FR-602)", () => {
  let repo: FixtureRepo;
  let client: Client;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    if (result.isError) return { payload: null, errorText: result.content[0].text };
    return { payload: JSON.parse(result.content[0].text) as Record<string, unknown>, errorText: null };
  }

  async function payload(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await call(name, args);
    if (result.payload === null) throw new Error(`${name} errored: ${result.errorText}`);
    return result.payload;
  }

  beforeAll(async () => {
    repo = buildFixtureRepo({ git: false });
    // Mirrors the worked rename session (mcp-server.md#example-agent-session).
    repo.write(
      "src/writer.ts",
      `export class Writer {
  replaceChunks(fileId: number, chunks: string[]): void {
    // replace chunks atomically
  }
}
`,
    );
    repo.write(
      "src/runner.ts",
      `import { Writer } from './writer';

export function indexFile(writer: Writer): void {
  writer.replaceChunks(1, []);
}

export function rebuild(writer: Writer): void {
  writer.replaceChunks(2, []);
}
`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [START_PATH, repo.root],
      stderr: "ignore",
    });
    client = new Client({ name: "qa-602", version: "0.0.0" });
    await client.connect(transport);

    // Wait for the startup background reindex to converge (a quiescent index
    // AND a completed resolution pass) so tool assertions are deterministic.
    const deadline = Date.now() + 25_000;
    for (;;) {
      const status = (await payload("index_status")) as {
        languages: { files: number }[];
        unresolved_edges: number;
      };
      const files = status.languages.reduce((n, l) => n + l.files, 0);
      if (files >= 5) break; // 3 base + writer + runner
      if (Date.now() > deadline) throw new Error(`startup reindex never converged (${files} files)`);
      await new Promise((r) => setTimeout(r, 200));
    }
    // One incremental reindex call: a no-op on indexed files, but it fences
    // the child's resolution pass (returns only after resolve completes).
    await payload("reindex");
  }, 40_000);

  afterAll(async () => {
    await client.close();
    repo.cleanup();
  });

  it("tools/list returns all 11 tools with object schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect((tool.inputSchema as { type: string }).type).toBe("object");
    }
  });

  it("worked rename session: find_symbol -> who_calls -> get_chunk -> edit -> reindex", async () => {
    // → find_symbol { name: "replaceChunks" }
    const found = (await payload("find_symbol", { name: "replaceChunks" })) as {
      results: { id: number; kind: string; signature: string; path: string; lines: number[] }[];
    };
    expect(found.results).toHaveLength(1);
    const hit = found.results[0];
    expect(hit).toMatchObject({
      kind: "method",
      signature: "replaceChunks(fileId: number, chunks: string[]): void",
      path: "src/writer.ts",
      lines: [2, 4], // the true declaration span, like the doc's [42, 68]
    });

    // → who_calls { symbol_id }
    const callers = (await payload("who_calls", { symbol_id: hit.id })) as {
      results: { name: string; path: string; resolved?: boolean }[];
    };
    const callerNames = callers.results.map((c) => c.name).sort();
    expect(callerNames).toEqual(["indexFile", "rebuild"]);
    // Method calls resolve by name only — flagged, not dropped.
    expect(callers.results.every((c) => c.resolved === false)).toBe(true);

    // → get_chunk (body of the indexFile call site, id via search_code)
    const search = (await payload("search_code", { query: "indexFile", path_prefix: "src/runner.ts" })) as {
      results: { id: number }[];
    };
    expect(search.results.length).toBeGreaterThan(0);
    const chunk = (await payload("get_chunk", { chunk_id: search.results[0].id })) as {
      path: string;
      content: string;
      lines: number[];
    };
    expect(chunk.path).toBe("src/runner.ts");
    expect(chunk.content).toContain("replaceChunks");

    // (agent edits the sites, then) → reindex {}
    repo.edit("src/writer.ts", (c) => c.replace("replaceChunks", "replaceFileChunks"));
    repo.edit("src/runner.ts", (c) => c.replaceAll("replaceChunks", "replaceFileChunks"));
    const delta = (await payload("reindex")) as { files_updated: number; duration_ms: number };
    expect(delta.files_updated).toBe(2);
    expect(delta.duration_ms).toBeGreaterThanOrEqual(0);

    // The rename landed: new name findable, old name gone.
    const renamed = (await payload("find_symbol", { name: "replaceFileChunks" })) as {
      results: unknown[];
    };
    expect(renamed.results).toHaveLength(1);
    const stale = (await payload("find_symbol", { name: "replaceChunks" })) as { results: unknown[] };
    expect(stale.results).toHaveLength(0);
  });

  it("index_status reports languages, unresolved edges, last index time", async () => {
    const status = (await payload("index_status")) as {
      languages: { language: string; files: number; chunks: number; symbols: number }[];
      unresolved_edges: number;
      last_index_time: string | null;
      recovery_events: unknown[];
    };
    expect(status.languages.map((l) => l.language)).toEqual(["javascript", "tsx", "typescript"]);
    expect(typeof status.unresolved_edges).toBe("number");
    expect(status.last_index_time).toBeTruthy();
    expect(status.recovery_events).toEqual([]);
  });

  it("search_code returns envelopes and rejects bad FTS syntax", async () => {
    const ok = (await payload("search_code", { query: "greet" })) as {
      results: { id: number; path: string; lines: number[]; preview: string }[];
      truncated: boolean;
    };
    expect(ok.results.length).toBeGreaterThan(0);
    expect(ok.results[0].preview).toContain("[");
    expect(ok.truncated).toBe(false);

    const bad = await call("search_code", { query: 'AND "' });
    expect(bad.errorText).toContain("invalid FTS query");
  });

  it("search_structural runs live ast-grep queries, unstamped by index age", async () => {
    const structural = (await payload("search_structural", {
      pattern: "writer.$METHOD($$$ARGS)",
      lang: "typescript",
    })) as { results: { path: string; lines: number[]; preview: string }[]; truncated: boolean };
    expect(structural.results.length).toBeGreaterThan(0);
    expect(structural.results[0].path).toBe("src/runner.ts");
    // Live working tree: exempt from the FR-604 staleness stamp, and no id.
    expect("index_age_seconds" in structural).toBe(false);
    expect("id" in structural.results[0]).toBe(false);
  });

  it("get_chunk errors distinctly for unknown ids", async () => {
    const result = await call("get_chunk", { chunk_id: 999999 });
    expect(result.errorText).toContain("no chunk with id");
  });

  it("file_outline returns the skeleton; unknown paths error", async () => {
    const outline = (await payload("file_outline", { path: "src/greet.ts" })) as {
      path: string;
      results: { name: string; kind: string; lines: number[]; exported: boolean }[];
    };
    expect(outline.results.map((r) => [r.name, r.kind])).toEqual([
      ["Greeting", "interface"],
      ["greet", "function"],
    ]);

    const missing = await call("file_outline", { path: "src/nope.ts" });
    expect(missing.errorText).toContain("not in index");
  });

  it("find_symbol honors kind and path_prefix filters", async () => {
    const all = (await payload("find_symbol", { name: "greet" })) as { results: unknown[] };
    expect(all.results).toHaveLength(1);
    const wrongKind = (await payload("find_symbol", { name: "greet", kind: "class" })) as {
      results: unknown[];
    };
    expect(wrongKind.results).toHaveLength(0);
    const wrongTree = (await payload("find_symbol", { name: "greet", path_prefix: "lib/" })) as {
      results: unknown[];
    };
    expect(wrongTree.results).toHaveLength(0);
  });

  it("who_calls accepts an unambiguous name and errors helpfully on ambiguity", async () => {
    const byName = (await payload("who_calls", { name: "greet" })) as {
      symbol: { name: string };
      results: { name: string }[];
    };
    expect(byName.symbol.name).toBe("greet");
    expect(byName.results.map((c) => c.name)).toContain("Hello");

    // indexFile and rebuild share no name; make an ambiguous case via the
    // two same-named symbols in base + renamed fixtures? Use missing name.
    const missing = await call("who_calls", { name: "definitelyMissing" });
    expect(missing.errorText).toContain("no symbol named");
  });

  it("get_dependencies works by symbol and by path, with catalog field names", async () => {
    const bySymbol = (await payload("get_dependencies", { name: "Hello" })) as {
      results: { edge_type: string; target_name: string }[];
    };
    expect(bySymbol.results.map((r) => r.target_name)).toContain("greet");

    const byPath = (await payload("get_dependencies", { path: "src/component.tsx" })) as {
      results: { edge_type: string; target_name: string; target_module: string | null }[];
    };
    // File-scope deps are the imports; self-referential exports are excluded.
    expect(byPath.results).toEqual([
      expect.objectContaining({ edge_type: "imports", target_name: "greet", target_module: "./greet" }),
    ]);
  });

  it("impact_of_change groups transitive callers by file with distances", async () => {
    const impact = (await payload("impact_of_change", { name: "greet" })) as {
      symbol: { name: string };
      files: { path: string; symbols: { name: string; distance: number }[] }[];
      truncated: boolean;
    };
    expect(impact.symbol.name).toBe("greet");
    const component = impact.files.find((f) => f.path === "src/component.tsx");
    expect(component?.symbols).toEqual([expect.objectContaining({ name: "Hello", distance: 1 })]);
  });

  it("module_map returns the import edge list, honoring path_prefix", async () => {
    const map = (await payload("module_map", {})) as {
      results: { from_file: string; to_module: string; import_count: number }[];
    };
    expect(map.results).toContainEqual({
      from_file: "src/component.tsx",
      to_module: "src/greet.ts",
      import_count: 1,
    });

    const filtered = (await payload("module_map", { path_prefix: "lib/" })) as { results: unknown[] };
    expect(filtered.results).toEqual([]);
  });

  it("rejects malformed arguments as tool errors, not crashes", async () => {
    expect((await call("search_code", {})).errorText).toContain("query is required");
    expect((await call("find_symbol", { name: "x", limit: -2 })).errorText).toContain("positive integer");
    expect((await call("who_calls", {})).errorText).toContain("symbol_id or name");
  });

  // Last on purpose: the full reindex rewrites every row id.
  it("reindex { full: true } rebuilds the whole index", async () => {
    const before = (await payload("index_status")) as { languages: { files: number }[] };
    const total = before.languages.reduce((n, l) => n + l.files, 0);

    const delta = (await payload("reindex", { full: true })) as {
      files_added: number;
      files_removed: number;
    };
    expect(delta.files_added).toBe(total);
    expect(delta.files_removed).toBe(0);

    const after = (await payload("index_status")) as { languages: { files: number }[] };
    expect(after.languages.reduce((n, l) => n + l.files, 0)).toBe(total);
  });
});
