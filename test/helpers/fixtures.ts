import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Shared fixture-repo builders (QA-000). Every later QA task reuses these —
 * extend the base file set here rather than building ad-hoc fixtures per test,
 * so golden rows stay consistent across suites.
 */

export interface FixtureRepo {
  root: string;
  /** Create or overwrite a file (parent dirs created as needed). */
  write(relPath: string, content: string): void;
  /** Transform an existing file's content. */
  edit(relPath: string, mutate: (content: string) => string): void;
  /** Delete a file. */
  remove(relPath: string): void;
  read(relPath: string): string;
  cleanup(): void;
}

/**
 * Base file set: at least one JS, one TS, and one TSX source file, plus a
 * non-source file and a .gitignore whose entries (ignored.txt, .code-index/)
 * matter for discovery tests.
 */
export const BASE_FILES: Record<string, string> = {
  "src/math.js": `function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`,
  "src/greet.ts": `export interface Greeting {
  message: string;
}

export function greet(name: string): Greeting {
  return { message: \`Hello, \${name}!\` };
}
`,
  "src/component.tsx": `import { greet } from "./greet";

export function Hello(props: { name: string }) {
  return <div className="hello">{greet(props.name).message}</div>;
}
`,
  "README.md": `# fixture-repo

A tiny repo used by the code-index test suite.
`,
  ".gitignore": `ignored.txt
.code-index/
`,
};

function writeInto(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

/**
 * Build a fixture repo in a fresh temp dir. With `git: true` the base files
 * are committed; with `git: false` the same tree is left as a plain directory.
 */
export function buildFixtureRepo(opts: { git: boolean }): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "code-index-fixture-"));
  for (const [relPath, content] of Object.entries(BASE_FILES)) {
    writeInto(root, relPath, content);
  }
  if (opts.git) {
    git(root, "init", "-q");
    git(root, "config", "user.email", "fixture@test.invalid");
    git(root, "config", "user.name", "Fixture");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "fixture base");
  }
  return {
    root,
    write: (relPath, content) => writeInto(root, relPath, content),
    edit: (relPath, mutate) => {
      const abs = join(root, relPath);
      writeFileSync(abs, mutate(readFileSync(abs, "utf8")));
    },
    remove: (relPath) => unlinkSync(join(root, relPath)),
    read: (relPath) => readFileSync(join(root, relPath), "utf8"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
