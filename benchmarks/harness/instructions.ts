/**
 * Instruction injection (benchmark-measurement.md#instruction-injection,
 * architecture.md layer table). Split pure/impure:
 *
 *   planInstructions(arm)                  APPLICATION — pure truth table, no fs.
 *   installInstructions(workspaceDir, arm) ADAPTER    — fs copy + content transform.
 *
 * The benchmark measures the SHIPPED artifacts verbatim: install copies the files
 * under `integrations/` into a run's workspace for the two `*-with-skill` arms.
 * `planInstructions` stays pure by returning `integrations/`-relative source
 * descriptors — the caller (composition root, defaultDeps in run.ts) resolves them
 * to disk. No imports from run.ts/report.ts; no `integrations/...` absolute path
 * literals in the pure plan.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hasSkill } from "./adapters/types";
import type { Arm } from "./adapters/types";

/**
 * A planned artifact injection. `source` is an `integrations/`-RELATIVE path (a
 * descriptor, not an absolute path) — kept relative so `planInstructions` is pure
 * and the composition root owns disk resolution (FR-505). `destRelPath` is
 * relative to the run workspace root.
 */
export interface InstructionPlan {
  source: string;
  destRelPath: string;
}

/**
 * Result of an install. `hash` is `sha256[..12]` of the POST-transform injected
 * content (what the agent actually sees), stable across runs; null for non-skill
 * arms (nothing written). `flags` carries install-time signals for the caller to
 * stamp on the record — currently `agents_md_appended` (FR-503). Shape lets SK-D04
 * consume both a hash and flags.
 */
export interface InstallResult {
  hash: string | null;
  flags: string[];
}

/**
 * Pure truth table (FR-501). Each `*-with-skill` arm injects its one shipped
 * artifact; the other four arms inject nothing. Sources are `integrations/`-relative.
 */
export function planInstructions(arm: Arm): InstructionPlan[] {
  switch (arm) {
    case "claude-with-skill":
      return [
        {
          source: "claude/skills/code-index/SKILL.md",
          destRelPath: ".claude/skills/code-index/SKILL.md",
        },
      ];
    case "codex-with-skill":
      return [{ source: "codex/AGENTS.md", destRelPath: "AGENTS.md" }];
    default:
      return [];
  }
}

/**
 * The `integrations/` root on disk, resolved relative to THIS module's location
 * (benchmarks/harness/ → repo-root/integrations), mirroring how run.ts resolves
 * `dist`/`results` off `__dirname`. Exposed as a parameter default so SK-D04's
 * defaultDeps() can inject the real root (the layer that owns artifact paths)
 * while unit tests can point at a fixture root.
 */
const DEFAULT_INTEGRATIONS_ROOT = resolve(__dirname, "..", "..", "integrations");

/**
 * Impure install (FR-502/503/504). Resolves each planned source against
 * `integrationsRoot`, applies the sole content transform (strip the codex HTML
 * template-comment header), writes into `workspaceDir`, and returns the
 * post-transform content hash + flags. Returns `{ hash: null, flags: [] }` and
 * writes nothing for non-skill arms.
 *
 * Rules:
 *  - Claude: throw if the workspace already contains a `.claude/` directory
 *    (isolation violation — no target ships one).
 *  - Codex: if the workspace already has an `AGENTS.md`, append this section after
 *    a separator and report `agents_md_appended`; the header is stripped either way.
 */
export function installInstructions(
  workspaceDir: string,
  arm: Arm,
  integrationsRoot: string = DEFAULT_INTEGRATIONS_ROOT,
): InstallResult {
  if (!hasSkill(arm)) return { hash: null, flags: [] };

  const [plan] = planInstructions(arm);
  const source = join(integrationsRoot, plan.source);
  const dest = join(workspaceDir, plan.destRelPath);
  const flags: string[] = [];

  const raw = readFileSync(source, "utf8");

  let injected: string;
  if (arm === "claude-with-skill") {
    // Isolation guard: this repo's own .claude/ is never touched, and no bench
    // target ships one — a pre-existing dir means the workspace is contaminated.
    if (existsSync(join(workspaceDir, ".claude"))) {
      throw new Error(
        `installInstructions: workspace already contains .claude/ (isolation violation): ${workspaceDir}`,
      );
    }
    injected = raw;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, injected, "utf8");
  } else {
    // codex-with-skill: strip the HTML template-comment header (packaging
    // metadata, not instructions) — the SOLE content transform.
    const section = stripTemplateHeader(raw);
    if (existsSync(dest)) {
      // Append after a separator so the target's own AGENTS.md is preserved.
      const existing = readFileSync(dest, "utf8");
      injected = section;
      writeFileSync(dest, `${existing.trimEnd()}\n\n---\n\n${section}`, "utf8");
      flags.push("agents_md_appended");
    } else {
      injected = section;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, injected, "utf8");
    }
  }

  // Hash is over the post-transform injected content (what the agent sees), NOT
  // the on-disk file (which may include a pre-existing AGENTS.md before the
  // separator) — so the same shipped artifact hashes identically across runs.
  const hash = createHash("sha256").update(injected).digest("hex").slice(0, 12);
  return { hash, flags };
}

/**
 * Strip a leading HTML template-comment header (`<!-- ... -->`) and the blank
 * lines after it, leaving the instruction body. Only a header at the very start
 * is removed; comments elsewhere are left intact.
 */
function stripTemplateHeader(content: string): string {
  const trimmed = content.replace(/^﻿/, "");
  if (!trimmed.startsWith("<!--")) return trimmed;
  const end = trimmed.indexOf("-->");
  if (end === -1) return trimmed;
  return trimmed.slice(end + 3).replace(/^\s*\n/, "");
}
