import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CODE_INDEX_DIR } from "../storage/database";

/**
 * File discovery (FR-201, indexing.md#file-discovery). Returns repo-relative
 * paths with forward slashes. Paths under .code-index/ are always excluded.
 */

function isGitRepo(repoRoot: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    return out.toString().trim() === "true";
  } catch {
    return false;
  }
}

/**
 * `git ls-files --cached --others --exclude-standard` from the repo root:
 * tracked + untracked-but-not-ignored, .gitignore handling for free.
 * Tracked-but-deleted files are dropped (a file that is gone from disk is not
 * discoverable — stale pruning relies on this).
 */
function discoverGit(repoRoot: string): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  return out
    .toString()
    .split("\n")
    .filter((p) => p.length > 0)
    .filter((p) => existsSync(join(repoRoot, p)));
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", CODE_INDEX_DIR]);

/** Non-git fallback: recursive walk skipping node_modules, .git, hidden dirs, .code-index. */
function discoverWalk(repoRoot: string, prefix = ""): string[] {
  const results: string[] = [];
  const entries = readdirSync(join(repoRoot, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      results.push(...discoverWalk(repoRoot, relPath));
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
  return results;
}

/** Discover indexable files under repoRoot. Sorted for deterministic runs. */
export function discoverFiles(repoRoot: string): string[] {
  const paths = isGitRepo(repoRoot) ? discoverGit(repoRoot) : discoverWalk(repoRoot);
  return paths
    .filter((p) => p !== CODE_INDEX_DIR && !p.startsWith(`${CODE_INDEX_DIR}/`))
    .sort();
}
