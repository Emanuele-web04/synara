// FILE: promptSkillReferences.ts
// Purpose: Resolves the skills a turn references, whether picked from the composer menu
//          or typed as `/name` / `$name`, against the shared skills catalog, so every
//          provider receives the same skill set wherever the skill file lives.
// Layer: Server provider helper
// Exports: extractPromptSkillTokenNames, resolvePromptSkillReferences, leadingSlashTokenName,
//          leadingPromptSkillTokenName

import type { ProviderSkillDescriptor, ProviderSkillReference } from "@synara/contracts";
import { isBuiltInComposerSlashCommandName } from "@synara/shared/composerSlashCommands";

import { skillNameKey } from "./skillsCatalog.ts";

// The composer's skill chip token, also accepted before sentence punctuation
// ("/name, then ...") since typed prose rarely leaves a space there.
const PROMPT_SKILL_TOKEN_REGEX = /(^|\s)([$/])([a-zA-Z][a-zA-Z0-9_:-]*)(?=[\s.,;!?)]|$)/g;
// Claude Code runs a prompt as a command only when `/name` is its first token.
const LEADING_SLASH_TOKEN_REGEX = /^\/([a-zA-Z][a-zA-Z0-9_:-]*)(?=\s|$)/;

function promptSkillTokenName(match: RegExpMatchArray): string | null {
  const name = match[3]?.replace(/[:-]+$/, "");
  if (!name || (match[2] === "/" && isBuiltInComposerSlashCommandName(name))) return null;
  return name;
}

/** Skill names typed as `/name` or `$name`, in order, without Synara's own slash commands. */
export function extractPromptSkillTokenNames(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PROMPT_SKILL_TOKEN_REGEX)) {
    const name = promptSkillTokenName(match);
    if (name === null) continue;
    const key = skillNameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Menu-picked skills first (they name an exact file), then typed tokens that match an
 * enabled skill in `available`. `available` is the active provider's catalog view, so a
 * name shared by several providers resolves to that provider's own copy.
 */
export function resolvePromptSkillReferences(input: {
  readonly text: string;
  readonly attached?: ReadonlyArray<ProviderSkillReference> | undefined;
  readonly available: ReadonlyArray<ProviderSkillDescriptor>;
}): ProviderSkillReference[] {
  const resolved = [...(input.attached ?? [])];
  const seen = new Set(resolved.map((skill) => skillNameKey(skill.name)));
  const availableByName = new Map<string, ProviderSkillDescriptor>();
  for (const skill of input.available) {
    const key = skillNameKey(skill.name);
    if (skill.enabled && !availableByName.has(key)) availableByName.set(key, skill);
  }
  for (const name of extractPromptSkillTokenNames(input.text)) {
    const key = skillNameKey(name);
    const skill = availableByName.get(key);
    if (!skill || seen.has(key)) continue;
    seen.add(key);
    resolved.push({ name: skill.name, path: skill.path });
  }
  return resolved;
}

/** The command name when the text starts with `/name`, as Claude Code's dispatch reads it. */
export function leadingSlashTokenName(text: string): string | null {
  return LEADING_SLASH_TOKEN_REGEX.exec(text.trimStart())?.[1] ?? null;
}

/** The skill name when the text starts with a `/name` skill token, punctuation allowed after it. */
export function leadingPromptSkillTokenName(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = new RegExp(PROMPT_SKILL_TOKEN_REGEX.source).exec(trimmed);
  return match?.index === 0 ? promptSkillTokenName(match) : null;
}
