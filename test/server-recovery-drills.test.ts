import { existsSync, openSync, readdirSync, writeSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { graphHooks } from "../src/graph/hooks";
import { runPipeline } from "../src/pipeline/run";
import { openDatabase } from "../src/storage/database";
import { runMigrations } from "../src/storage/migrations";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const PACKAGE_ROOT = resolve(__dirname, "..");
const START_PATH = join(PACKAGE_ROOT, "dist", "server", "start.js");
const BASE_FILE_COUNT = 3; // js + ts + tsx in the base fixture

/**
 * DEV-801: the three recovery drills from schema.md#health-check-and-recovery,
 * run as full-system exercises through the spawned MCP server (QA-107 covered
 * the unit level). Each drill must end with: server up, quarantine file on
 * disk, rebuilt healthy index, and the event surfaced via index_status.
 */

interface StatusPayload {
  languages: { language: string; files: number }[];
  unresolved_edges: number;
  recovery_events: { timestamp: string; reason: string; quarantinePath: string }[];
}

function totalFiles(status: StatusPayload): number {
  return status.languages.reduce((sum, l) => sum + l.files, 0);
}

function quarantineFiles(repoRoot: string): string[] {
  const dir = join(repoRoot, ".code-index");
  return readdirSync(dir).filter((f) => f.includes(".quarantine-"));
}

/** Build a valid populated index, then hand it to a sabotage function. */
function buildThenSabotage(repo: FixtureRepo, sabotage: (dbPath: string, repo: FixtureRepo) => void): void {
  const db = openDatabase(repo.root);
  runMigrations(db);
  runPipeline(db, repo.root, graphHooks);
  db.close(); // checkpoints the WAL so sabotage hits the real file
  sabotage(join(repo.root, ".code-index", "index.db"), repo);
}

describe("end-to-end recovery drills (PRD §4 robustness)", () => {
  let repo: FixtureRepo;
  let client: Client | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
    repo.cleanup();
  });

  async function connect(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [START_PATH, repo.root],
      stderr: "ignore",
    });
    const c = new Client({ name: "qa-801", version: "0.0.0" });
    await c.connect(transport);
    return c;
  }

  async function indexStatus(c: Client): Promise<StatusPayload> {
    const result = (await c.callTool({ name: "index_status", arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError ?? false).toBe(false);
    return JSON.parse(result.content[0].text) as StatusPayload;
  }

  async function drill(expectedReason: RegExp): Promise<void> {
    client = await connect(); // the server came up — it never crashed

    // The event surfaces via index_status, pointing at a real quarantine file.
    const status = await indexStatus(client);
    expect(status.recovery_events.length).toBeGreaterThanOrEqual(1);
    const event = status.recovery_events[status.recovery_events.length - 1];
    expect(event.reason).toMatch(expectedReason);
    expect(quarantineFiles(repo.root).length).toBeGreaterThanOrEqual(1);
    // The surfaced event points at the actual on-disk quarantine file.
    expect(existsSync(event.quarantinePath)).toBe(true);

    // The background rebuild converges to a healthy, fully re-indexed state.
    const deadline = Date.now() + 25_000;
    let latest = status;
    while (totalFiles(latest) < BASE_FILE_COUNT) {
      if (Date.now() > deadline) throw new Error(`rebuild never converged (${totalFiles(latest)} files)`);
      await new Promise((r) => setTimeout(r, 250));
      latest = await indexStatus(client);
    }
    expect(totalFiles(latest)).toBe(BASE_FILE_COUNT);
    expect(latest.unresolved_edges).toBe(0); // base fixture fully resolves
  }

  it("drill 1: file corruption discovered at server startup", async () => {
    repo = buildFixtureRepo({ git: false });
    buildThenSabotage(repo, (dbPath) => {
      // Trash the SQLite header and the first pages.
      const fd = openSync(dbPath, "r+");
      writeSync(fd, Buffer.alloc(512, 0xde), 0, 512, 0);
      closeSync(fd);
    });
    await drill(/quick_check|malformed|not a database/i);
  });

  it("drill 2: foreign (newer) user_version", async () => {
    repo = buildFixtureRepo({ git: false });
    buildThenSabotage(repo, () => {
      const db = openDatabase(repo.root);
      db.pragma("user_version = 9999");
      db.close();
    });
    await drill(/user_version|foreign|newer/i);
  });

  it("drill 3: copied database (wrong repo_root)", async () => {
    repo = buildFixtureRepo({ git: false });
    buildThenSabotage(repo, () => {
      const db = openDatabase(repo.root);
      db.prepare("UPDATE meta SET value = '/somewhere/else' WHERE key = 'repo_root'").run();
      db.close();
    });
    await drill(/repo_root/);
  });
});
