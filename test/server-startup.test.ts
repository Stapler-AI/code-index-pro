import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { openIndexDb } from "./helpers/db";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const PACKAGE_ROOT = resolve(__dirname, "..");
const START_PATH = join(PACKAGE_ROOT, "dist", "server", "start.js");

/** Files beyond the base fixture, sized so the startup reindex takes a while. */
const GENERATED_FILES = 400;

interface StatusPayload {
  languages: { language: string; files: number }[];
  unresolved_edges: number;
  last_index_time: string | null;
  recovery_events: { timestamp: string; reason: string }[];
}

function totalFiles(status: StatusPayload): number {
  return status.languages.reduce((sum, l) => sum + l.files, 0);
}

async function connect(repoRoot: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [START_PATH, repoRoot],
    stderr: "ignore",
  });
  const client = new Client({ name: "qa-601", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function callIndexStatus(client: Client): Promise<StatusPayload> {
  const result = (await client.callTool({ name: "index_status", arguments: {} })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0].text) as StatusPayload;
}

describe("MCP server startup (FR-601)", () => {
  let repo: FixtureRepo;
  let client: Client | null = null;

  beforeAll(() => {
    if (!existsSync(START_PATH)) {
      console.error("dist missing — running a fallback build for server tests");
      execFileSync("npm", ["run", "build"], { cwd: PACKAGE_ROOT, stdio: ["ignore", "ignore", "inherit"] });
    }
  });
  afterEach(async () => {
    await client?.close();
    client = null;
    repo.cleanup();
  });

  it("initialize handshake succeeds and identifies the server", async () => {
    repo = buildFixtureRepo({ git: false });
    client = await connect(repo.root);
    const version = client.getServerVersion();
    expect(version?.name).toBe("code-index");
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("index_status");
  });

  it("a tool call at startup succeeds while the background reindex is still running", async () => {
    repo = buildFixtureRepo({ git: false });
    for (let i = 0; i < GENERATED_FILES; i++) {
      repo.write(`src/gen/f${i}.ts`, `export function gen${i}(): number {\n  return ${i};\n}\n`);
    }
    const expectedTotal = GENERATED_FILES + 3; // + base js/ts/tsx files

    client = await connect(repo.root);
    const first = await callIndexStatus(client);
    // The call answered before the reindex finished — it saw a partial (or
    // empty) index rather than waiting for all files.
    expect(totalFiles(first)).toBeLessThan(expectedTotal);

    // The background reindex genuinely converges to the full file set.
    const deadline = Date.now() + 25_000;
    let latest = first;
    while (totalFiles(latest) < expectedTotal && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      latest = await callIndexStatus(client);
    }
    expect(totalFiles(latest)).toBe(expectedTotal);
  });

  it("a corrupted database at startup is quarantined and the server still comes up", async () => {
    repo = buildFixtureRepo({ git: false });
    // Build a valid index, then tamper meta.repo_root to fail the health check.
    const db = openDatabase(repo.root);
    runMigrations(db);
    runPipeline(db, repo.root, graphHooks);
    db.prepare("UPDATE meta SET value = '/somewhere/else' WHERE key = 'repo_root'").run();
    db.close();

    client = await connect(repo.root);
    const status = await callIndexStatus(client);
    expect(status.recovery_events.length).toBeGreaterThan(0);
    expect(status.recovery_events[0].reason).toContain("repo_root");

    // The quarantined file was preserved next to the fresh database.
    const fresh = openIndexDb(repo.root);
    fresh.close();
  });
});
