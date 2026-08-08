import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * SK-Q13 — proves SK-D13's four `.dependency-cruiser.cjs` boundary rules each FIRE on
 * their violation class, that the grandfathered `benchmarks -> src/storage/meta` seam
 * still PASSES, and that a clean control passes.
 *
 * The shipped rules are path-anchored (`^src`, `^benchmarks`), so a violating fixture
 * must live at a matching path to be caught by the SHIPPED config. Fixtures are therefore
 * written INTO the repo tree (under src/, benchmarks/, benchmarks/harness/adapters/) with
 * distinctive random basenames, and are ALWAYS removed in afterEach — even on assertion
 * failure or process error — because a leftover violating file would break every
 * subsequent `pretest` (`npm run boundaries`).
 *
 * depcruise is invoked scoped narrowly to just the fixture file(s) so only the intended
 * rule is exercised, against the real repo-root `.dependency-cruiser.cjs`.
 */

const REPO_ROOT = join(__dirname, "..");
const DEPCRUISE_BIN = join(REPO_ROOT, "node_modules", ".bin", "depcruise");
const CONFIG = ".dependency-cruiser.cjs";

// Repo-relative fixture paths, registered for guaranteed cleanup.
const fixtures: string[] = [];

function fixture(relPath: string, contents: string): string {
  const abs = join(REPO_ROOT, relPath);
  fixtures.push(abs);
  writeFileSync(abs, contents);
  return relPath;
}

/** Distinctive, collision-resistant basename so a leftover is obvious and grep-able. */
function tag(): string {
  return `__boundary_fixture_${randomBytes(6).toString("hex")}`;
}

afterEach(() => {
  while (fixtures.length) {
    rmSync(fixtures.pop()!, { force: true });
  }
});

/** Run the shipped depcruise config scoped to `targets` (repo-relative paths). */
function cruise(targets: string[]): { status: number; output: string } {
  const res = spawnSync(DEPCRUISE_BIN, [...targets, "--config", CONFIG], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, output: `${res.stdout}\n${res.stderr}` };
}

describe("SK-Q13 — dependency-cruiser boundary rules fire on their violation class", () => {
  it("src-isolated: src -> benchmarks import fails", () => {
    const f = fixture(
      `src/${tag()}.ts`,
      `import { TASKS } from "../benchmarks/tasks";\nexport const x = TASKS;\n`,
    );
    const { status, output } = cruise([f]);
    expect(status).not.toBe(0);
    expect(output).toContain("src-isolated");
  });

  it("adapters-innermost: adapter -> run.ts import fails", () => {
    const f = fixture(
      `benchmarks/harness/adapters/${tag()}.ts`,
      `import { HARNESS_VERSION } from "../run";\nexport const x = HARNESS_VERSION;\n`,
    );
    const { status, output } = cruise([f]);
    expect(status).not.toBe(0);
    expect(output).toContain("adapters-innermost");
  });

  it("bench-src-seam: benchmarks -> src (not storage/meta) fails", () => {
    const f = fixture(
      `benchmarks/${tag()}.ts`,
      `import { toolVersion } from "../src/cli";\nexport const x = toolVersion;\n`,
    );
    const { status, output } = cruise([f]);
    expect(status).not.toBe(0);
    expect(output).toContain("bench-src-seam");
  });

  it("bench-src-seam: grandfathered benchmarks -> src/storage/meta PASSES", () => {
    const f = fixture(
      `benchmarks/${tag()}.ts`,
      `import { toolVersion } from "../src/storage/meta";\nexport const x = toolVersion;\n`,
    );
    const { status, output } = cruise([f]);
    expect(status).toBe(0);
    expect(output).not.toContain("bench-src-seam");
  });

  it("no-circular: a circular pair fails", () => {
    const base = tag();
    const a = fixture(
      `benchmarks/${base}_a.ts`,
      `import { b } from "./${base}_b";\nexport const a = 1;\nexport { b };\n`,
    );
    const b = fixture(
      `benchmarks/${base}_b.ts`,
      `import { a } from "./${base}_a";\nexport const b = 2;\nexport { a };\n`,
    );
    const { status, output } = cruise([a, b]);
    expect(status).not.toBe(0);
    expect(output).toContain("no-circular");
  });

  it("clean control: a conforming fixture passes with no violations", () => {
    // benchmarks importing another benchmarks module — allowed by every rule.
    const f = fixture(
      `benchmarks/${tag()}.ts`,
      `import { TASKS } from "./tasks";\nexport const x = TASKS;\n`,
    );
    const { status, output } = cruise([f]);
    expect(status).toBe(0);
    expect(output).toContain("no dependency violations");
  });
});
