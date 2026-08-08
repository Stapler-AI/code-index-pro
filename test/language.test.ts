import { describe, expect, it } from "vitest";
import { detectLanguage } from "../src/pipeline/language";

describe("language detection (FR-202)", () => {
  it.each([
    ["src/a.js", "javascript"],
    ["src/a.mjs", "javascript"],
    ["src/a.cjs", "javascript"],
    ["src/Component.jsx", "javascript"],
    ["src/a.ts", "typescript"],
    ["src/a.mts", "typescript"],
    ["src/a.cts", "typescript"],
    ["src/Component.tsx", "tsx"],
  ] as const)("maps %s -> %s", (path, language) => {
    expect(detectLanguage(path)).toBe(language);
  });

  it.each([
    "package.json", // staged language, not v1
    "script.py", // staged language, not v1
    "README.md",
    "Makefile", // no extension
    ".gitignore", // dotfile without a real extension
    "styles.css", // staged language, not v1
    "run.sh", // staged language, not v1
    "src/archive.tar.gz",
  ])("skips %s entirely", (path) => {
    expect(detectLanguage(path)).toBeNull();
  });

  it("is case-insensitive on the extension", () => {
    expect(detectLanguage("src/A.TS")).toBe("typescript");
    expect(detectLanguage("src/A.JsX")).toBe("javascript");
  });
});
