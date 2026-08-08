/**
 * Language detection by extension (FR-202, indexing.md#language-detection).
 * v1 ships javascript, typescript, and tsx; staged languages (json, python,
 * c, html, bash, css, swift) stay out until their grammars and queries land.
 * Files with unrecognized extensions are skipped entirely.
 */

export type Language = "javascript" | "typescript" | "tsx";

const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
};

/** Detect the v1 language for a path, or null when the file should be skipped. */
export function detectLanguage(path: string): Language | null {
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  const dot = lastSegment.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or dotfile like .gitignore
  const extension = lastSegment.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[extension] ?? null;
}
