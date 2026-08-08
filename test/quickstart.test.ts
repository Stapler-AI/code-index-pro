import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const PACKAGE_ROOT = resolve(__dirname, "..");
const BIN_PATH = join(PACKAGE_ROOT, "dist", "cli.js");
const README = join(PACKAGE_ROOT, "README.md");

/**
 * QA-805 (FR-700): the README quick-start commands, extracted from the doc
 * and executed VERBATIM against a fixture repo. `npm link` is simulated
 * hermetically by placing the built bin on the fixture's node_modules/.bin
 * (exactly what link does globally), so npx resolves `code-index` locally.
 */

function quickstartCommands(): string[][] {
  const readme = readFileSync(README, "utf8");
  const blocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const commands = blocks
    .flatMap((b) => b.split("\n"))
    .filter((line) => line.trim().startsWith("npx code-index"))
    .map((line) => line.trim().split(/\s+/));
  return commands;
}

describe("README quick start runs verbatim (FR-700)", () => {
  let repo: FixtureRepo;
  let client: Client | null = null;

  beforeAll(() => {
    if (!existsSync(BIN_PATH)) {
      console.error("dist missing — running a fallback build for quickstart tests");
      execFileSync("npm", ["run", "build"], { cwd: PACKAGE_ROOT, stdio: ["ignore", "ignore", "inherit"] });
    }
    chmodSync(BIN_PATH, 0o755); // npm sets the bin executable on install; tsc does not
    repo = buildFixtureRepo({ git: true });
    const binDir = join(repo.root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(BIN_PATH, join(binDir, "code-index"));
  });
  afterAll(async () => {
    await client?.close();
    repo.cleanup();
  });

  it("the README documents exactly the three quick-start commands", () => {
    expect(quickstartCommands().map((c) => c.join(" "))).toEqual([
      "npx code-index index .",
      "npx code-index stats",
      "npx code-index serve .",
    ]);
  });

  it("`npx code-index index .` and `npx code-index stats` succeed as documented", () => {
    const [indexCmd, statsCmd] = quickstartCommands();

    const indexOut = execFileSync(indexCmd[0], indexCmd.slice(1), { cwd: repo.root, encoding: "utf8" });
    expect(indexOut).toMatch(/3 added, 0 updated, 0 removed/);
    expect(existsSync(join(repo.root, ".code-index", "index.db"))).toBe(true);

    const statsOut = execFileSync(statsCmd[0], statsCmd.slice(1), { cwd: repo.root, encoding: "utf8" });
    expect(statsOut).toContain("Index stats");
    expect(statsOut).toMatch(/typescript: 1 files/);
  });

  it("`npx code-index serve .` completes an MCP handshake as documented", async () => {
    const serveCmd = quickstartCommands()[2];
    const transport = new StdioClientTransport({
      command: serveCmd[0],
      args: serveCmd.slice(1),
      cwd: repo.root,
      stderr: "ignore",
    });
    client = new Client({ name: "qa-805", version: "0.0.0" });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("code-index");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
  });
});
