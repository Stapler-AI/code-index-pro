import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Change detection (FR-203, indexing.md#change-detection). Decides, per
 * discovered file, whether it needs (re-)indexing.
 */

export const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB

export type ChangeDecision =
  | { action: "skip"; reason: "too_large" | "binary" | "unchanged" }
  | { action: "index"; content: string; fileHash: string };

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Evaluate one discovered file: skip > 1 MB, skip non-UTF-8 (decode failure
 * = binary), SHA-256 the raw bytes, skip when an indexed_files row already
 * matches (relative_path, file_hash). Otherwise return the decoded content
 * and hash for the parse stage.
 */
export function evaluateFile(db: Database, repoRoot: string, relativePath: string): ChangeDecision {
  const absPath = join(repoRoot, relativePath);

  if (statSync(absPath).size > MAX_FILE_SIZE_BYTES) {
    return { action: "skip", reason: "too_large" };
  }

  const bytes = readFileSync(absPath);
  let content: string;
  try {
    content = utf8.decode(bytes);
  } catch {
    return { action: "skip", reason: "binary" };
  }

  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const row = db
    .prepare("SELECT file_hash FROM indexed_files WHERE relative_path = ?")
    .get(relativePath) as { file_hash: string } | undefined;
  if (row?.file_hash === fileHash) {
    return { action: "skip", reason: "unchanged" };
  }

  return { action: "index", content, fileHash };
}
