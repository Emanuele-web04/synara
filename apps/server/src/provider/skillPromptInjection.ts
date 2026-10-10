import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { ProviderKind, ProviderSkillReference } from "@synara/contracts";

// Per-skill cap keeps a single oversized SKILL.md from eating the turn budget.
const MAX_INLINE_SKILL_CONTENT_CHARS = 24_000;

const INLINE_SKILLS_HEADER =
  "The user invoked the following agent skill(s) for this request. Follow each " +
  "skill's instructions. File paths referenced inside a skill are relative to its " +
  '"dir" attribute.';

const CROSS_PROVIDER_SKILL_DIR_NAMES = [
  ".synara",
  ".codex",
  ".cursor",
  ".claude",
  ".agents",
] as const;

function pathSegments(path: string): Set<string> {
  return new Set(
    nodePath
      .normalize(path)
      .split(/[\\/]+/)
      .map((segment) => segment.toLowerCase()),
  );
}

export function shouldInlineSkillForProvider(provider: ProviderKind, skillPath: string): boolean {
  const segments = pathSegments(skillPath);
  switch (provider) {
    case "antigravity":
      return true;
    case "codex":
      // Codex loads .codex/.agents and ~/.synara/skills natively — only foreign provider roots need inlined instructions
      return [".claude", ".cursor"].some((dir) => segments.has(dir));
    case "cursor":
      // cursor-agent natively scans .cursor/.agents/.claude/.codex skill roots; only Synara-owned paths need inlining.
      return segments.has(".synara");
    case "claudeAgent":
      // Claude Code only loads skills from .claude/skills folders.
      return !segments.has(".claude");
    case "devin":
      return !(
        [".agents", ".claude", ".codeium", ".cognition", ".devin", ".windsurf"].some((dir) =>
          segments.has(dir),
        ) ||
        ((segments.has(".config") || (segments.has("appdata") && segments.has("roaming"))) &&
          (segments.has("devin") || segments.has("cognition")))
      );
    case "pi":
      return CROSS_PROVIDER_SKILL_DIR_NAMES.some((dir) => segments.has(dir));
    default:
      // Antigravity/Grok/Droid/OpenCode have no native skill support.
      return true;
  }
}

export async function buildInlineSkillInstructions(input: {
  readonly provider: ProviderKind;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly maxChars: number;
}): Promise<string> {
  const inlineSkills = input.skills.filter((skill) =>
    shouldInlineSkillForProvider(input.provider, skill.path),
  );
  if (inlineSkills.length === 0 || input.maxChars <= 0) {
    return "";
  }

  let text = "";
  for (const skill of inlineSkills) {
    let content: string;
    try {
      content = await fs.readFile(skill.path, "utf8");
    } catch {
      continue;
    }
    let trimmed = content.trim();
    if (trimmed.length > MAX_INLINE_SKILL_CONTENT_CHARS) {
      trimmed = `${trimmed.slice(0, MAX_INLINE_SKILL_CONTENT_CHARS)}\n[skill content truncated]`;
    }
    const block = `<skill name=${JSON.stringify(skill.name)} dir=${JSON.stringify(
      nodePath.dirname(skill.path),
    )}>\n${trimmed}\n</skill>`;
    const candidate =
      text.length === 0 ? `${INLINE_SKILLS_HEADER}\n\n${block}` : `${text}\n\n${block}`;
    if (candidate.length > input.maxChars) {
      // Keep whatever already fits instead of overflowing the provider turn budget.
      break;
    }
    text = candidate;
  }
  return text;
}
