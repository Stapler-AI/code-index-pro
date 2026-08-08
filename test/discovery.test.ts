import { afterEach, describe, expect, it } from "vitest";
import { discoverFiles } from "../src/pipeline/discovery";
import { BASE_FILES, buildFixtureRepo, FixtureRepo } from "./helpers/fixtures";

const BASE_PATHS = Object.keys(BASE_FILES).sort();

describe("file discovery (FR-201 / FR-200)", () => {
  let repo: FixtureRepo;
  afterEach(() => repo?.cleanup());

  describe("git repo", () => {
    it("lists tracked and untracked files but not gitignored ones or .code-index/", () => {
      repo = buildFixtureRepo({ git: true });
      repo.write("src/untracked.ts", "export const fresh = true;\n");
      repo.write("ignored.txt", "listed in .gitignore\n");
      repo.write(".code-index/index.db", "not a real db\n");

      const found = discoverFiles(repo.root);

      for (const p of BASE_PATHS) expect(found, p).toContain(p);
      expect(found).toContain("src/untracked.ts"); // untracked but not ignored
      expect(found).not.toContain("ignored.txt"); // gitignored
      expect(found.some((p) => p.startsWith(".code-index"))).toBe(false);
    });

    it("does not list tracked files that were deleted from disk", () => {
      repo = buildFixtureRepo({ git: true });
      repo.remove("src/math.js");

      const found = discoverFiles(repo.root);
      expect(found).not.toContain("src/math.js");
    });
  });

  describe("non-git fallback walk", () => {
    it("indexes a plain directory, skipping node_modules, hidden dirs, .git and .code-index", () => {
      repo = buildFixtureRepo({ git: false });
      repo.write("node_modules/pkg/index.js", "module.exports = {};\n");
      repo.write(".hidden-dir/secret.ts", "export const hidden = true;\n");
      repo.write(".git/config", "[core]\n");
      repo.write(".code-index/index.db", "not a real db\n");
      repo.write("src/nested/deep.ts", "export const deep = 1;\n");

      const found = discoverFiles(repo.root);

      for (const p of BASE_PATHS) expect(found, p).toContain(p);
      expect(found).toContain("src/nested/deep.ts");
      expect(found.some((p) => p.startsWith("node_modules"))).toBe(false);
      expect(found.some((p) => p.startsWith(".hidden-dir"))).toBe(false);
      expect(found.some((p) => p.startsWith(".git/"))).toBe(false);
      expect(found.some((p) => p.startsWith(".code-index"))).toBe(false);
    });
  });

  it("returns sorted repo-relative paths with forward slashes in both modes", () => {
    for (const git of [true, false]) {
      const r = buildFixtureRepo({ git });
      try {
        const found = discoverFiles(r.root);
        expect(found).toEqual([...found].sort());
        for (const p of found) {
          expect(p).not.toMatch(/\\/);
          expect(p.startsWith("/")).toBe(false);
        }
      } finally {
        r.cleanup();
      }
    }
  });
});
