import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const PACKAGE_ROOT = resolve(__dirname, "..");
const BIN_PATH = join(PACKAGE_ROOT, "dist", "cli.js");

function runBin(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [BIN_PATH, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("packaged bin (FR-705)", () => {
  let repo: FixtureRepo;

  beforeAll(() => {
    // CI-style invocation builds before testing; fall back to building here.
    if (!existsSync(BIN_PATH)) {
      console.error("dist/cli.js missing — running a fallback build for bin tests");
      execFileSync("npm", ["run", "build"], { cwd: PACKAGE_ROOT, stdio: ["ignore", "ignore", "inherit"] });
    }
  });
  afterEach(() => repo?.cleanup());

  it("package.json wires the code-index bin to a built, shebang'd entry point", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
      files: string[];
    };
    expect(pkg.bin["code-index"]).toBe("dist/cli.js");
    // dist/ is gitignored, so npm pack needs an explicit files entry.
    expect(pkg.files).toContain("dist");
    expect(readFileSync(BIN_PATH, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("runs index, stats, clear end-to-end against a fixture repo", () => {
    repo = buildFixtureRepo({ git: true });

    const indexOut = runBin(repo.root, "index");
    expect(indexOut).toMatch(/3 added, 0 updated, 0 removed in \d+ ms/);
    expect(existsSync(join(repo.root, ".code-index", "index.db"))).toBe(true);

    const statsOut = runBin(repo.root, "stats");
    expect(statsOut).toMatch(/javascript: 1 files, \d+ chunks, 0 symbols/);
    expect(statsOut).toMatch(/typescript: 1 files, \d+ chunks, 0 symbols/);
    expect(statsOut).toMatch(/tsx: 1 files, \d+ chunks, 0 symbols/);
    expect(statsOut).toMatch(/unresolved edges: 0/);

    const clearOut = runBin(repo.root, "clear");
    expect(clearOut).toContain("Removed");
    expect(existsSync(join(repo.root, ".code-index"))).toBe(false);
  });

  it("exits with status 1 for unknown commands", () => {
    repo = buildFixtureRepo({ git: false });
    try {
      runBin(repo.root, "bogus");
      expect.unreachable("bogus command should exit non-zero");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(1);
    }
  });
});
