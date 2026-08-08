import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const PACKAGE_ROOT = resolve(__dirname, "..");
const BIN_PATH = join(PACKAGE_ROOT, "dist", "cli.js");

describe("code-index serve (FR-704)", () => {
  let repo: FixtureRepo;
  let client: Client | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
    repo.cleanup();
  });

  it("the registration command shape works: bin + `serve .` completes an MCP handshake", async () => {
    repo = buildFixtureRepo({ git: true });
    // Exactly the registration example's shape (npx code-index serve .):
    // the bin entry point, the serve command, "." resolved against cwd.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN_PATH, "serve", "."],
      cwd: repo.root,
      stderr: "ignore",
    });
    client = new Client({ name: "qa-704", version: "0.0.0" });
    await client.connect(transport);

    expect(client.getServerVersion()?.name).toBe("code-index");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);

    // The server is genuinely wired to this repo: a tool call answers.
    const result = (await client.callTool({ name: "index_status", arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError ?? false).toBe(false);
    const status = JSON.parse(result.content[0].text) as { index_age_seconds: number | null };
    expect("index_age_seconds" in status).toBe(true);

    // "." resolved against cwd: the index lands in the repo, not vitest's cwd.
    expect(existsSync(join(repo.root, ".code-index", "index.db"))).toBe(true);
  });

  it("serve with an explicit path argument targets that repo", async () => {
    repo = buildFixtureRepo({ git: false });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN_PATH, "serve", repo.root],
      stderr: "ignore",
    });
    client = new Client({ name: "qa-704b", version: "0.0.0" });
    await client.connect(transport);

    // The index lands inside the target repo, proving root resolution.
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(repo.root, ".code-index", "index.db")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(join(repo.root, ".code-index", "index.db"))).toBe(true);
  });
});
