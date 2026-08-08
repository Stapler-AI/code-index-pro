import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFixtureRepo } from "../test/helpers/fixtures";

/**
 * Named benchmark targets (benchmark.md#targets--fixtures) — three classes:
 * QA-000 fixture builders (git variant), pinned OSS repos cloned once into
 * benchmarks/fixtures/ (path overridable via BENCH_FIXTURES), and this repo
 * at a tagged commit. Every materialization is a fresh temp-dir copy with a
 * .git so edit-tier diff assertions work.
 */

export interface Materialized {
  dir: string;
  cleanup(): void;
}

export interface BenchTarget {
  name: string;
  class: "fixture" | "oss" | "self";
  description: string;
  /** True when the target carries a runnable test suite (edit-tier gate). */
  testRunnable: boolean;
  /**
   * Prepare the shared cache (network allowed HERE only — a one-time clone).
   * No-op for targets that need none.
   */
  ensureCache(): void;
  /** Fresh, isolated working copy in a new temp dir. */
  materialize(): Materialized;
}

const PACKAGE_ROOT = resolve(__dirname, "..");

/** Pinned self version: `git tag bench-self-v1 <commit>` (GATE-M7 state). */
export const SELF_TAG = "bench-self-v1";

/** Pinned OSS target: zod v3.23.8. Mid-size, single-package TypeScript. */
export const ZOD_REPO = "https://github.com/colinhacks/zod";
export const ZOD_COMMIT = "ca42965df46b2f7e2747db29c40a26bcb32a51d5";

/** Clone cache root; BENCH_FIXTURES overrides (benchmark.md). */
export function fixturesDir(): string {
  return process.env.BENCH_FIXTURES ?? join(PACKAGE_ROOT, "benchmarks", "fixtures");
}

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

const fixtureTs: BenchTarget = {
  name: "fixture-ts",
  class: "fixture",
  description: "QA-000 fixture repo (git variant): small JS/TS/TSX with controlled ground truth.",
  // Fixtures always qualify for edit tasks (benchmark.md): tasks seed their
  // own runnable checks in the workspace.
  testRunnable: true,
  ensureCache: () => {},
  materialize: () => {
    const repo = buildFixtureRepo({ git: true });
    return { dir: repo.root, cleanup: repo.cleanup };
  },
};

const ossZod: BenchTarget = {
  name: "oss-zod",
  class: "oss",
  description: `zod at v3.23.8 (${ZOD_COMMIT.slice(0, 12)}): realistic mid-size TypeScript.`,
  testRunnable: true,
  ensureCache: () => {
    const cache = join(fixturesDir(), "zod");
    // Probe a content marker, not bare existence — a clone interrupted
    // mid-fetch must retry, not short-circuit into a broken cache.
    if (existsSync(join(cache, "package.json"))) return;
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    try {
      // Shallow fetch of exactly the pinned commit — no full history.
      git(cache, "init", "-q");
      git(cache, "remote", "add", "origin", ZOD_REPO);
      git(cache, "fetch", "--depth", "1", "-q", "origin", ZOD_COMMIT);
      git(cache, "checkout", "-q", ZOD_COMMIT);
    } catch (error) {
      rmSync(cache, { recursive: true, force: true });
      throw error;
    }
  },
  materialize: () => {
    const cache = join(fixturesDir(), "zod");
    if (!existsSync(cache)) {
      throw new Error(
        `oss-zod cache missing at ${cache} — run ensureCache() once (network) or point BENCH_FIXTURES at a prepared cache`,
      );
    }
    const dir = tempDir("bench-oss-zod-");
    cpSync(cache, dir, { recursive: true });
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  },
};

const self: BenchTarget = {
  name: "self",
  class: "self",
  description: `This repository at tag ${SELF_TAG} — the DEV-803 dogfood, as real agent sessions.`,
  testRunnable: true,
  ensureCache: () => {},
  materialize: () => {
    try {
      git(PACKAGE_ROOT, "rev-parse", "--verify", "-q", `refs/tags/${SELF_TAG}`);
    } catch {
      throw new Error(`self target requires tag ${SELF_TAG} — create it with: git tag ${SELF_TAG} <commit>`);
    }
    const dir = tempDir("bench-self-");
    // Local clone (no network), then pin the checkout to the tag.
    execFileSync("git", ["clone", "-q", "--no-hardlinks", PACKAGE_ROOT, dir], { stdio: "pipe" });
    git(dir, "checkout", "-q", SELF_TAG);
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  },
};

export const TARGETS: Record<string, BenchTarget> = {
  [fixtureTs.name]: fixtureTs,
  [ossZod.name]: ossZod,
  [self.name]: self,
};
