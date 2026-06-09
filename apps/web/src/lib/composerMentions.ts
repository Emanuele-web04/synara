// FILE: composerMentions.ts
// Purpose: Share parsing/formatting helpers for `@...` composer mentions, including quoted paths.
// Layer: Web composer helper
// Exports: mention token formatters plus regex helpers used by composer parsing and prompt sync.

import type { ProviderMentionReference, ProviderSkillReference } from "@t3tools/contracts";

export function createComposerMentionTokenRegex(options: {
  includeTrailingTokenAtEnd: boolean;
  global?: boolean;
}): RegExp {
  const suffix = options.includeTrailingTokenAtEnd ? "(?=\\s|$)" : "(?=\\s)";
  return new RegExp(
    `(^|\\s)@(?:"([^"]+)"|([^\\s@]+))${suffix}`,
    options.global === false ? "" : "g",
  );
}

export function extractComposerMentionPath(match: RegExpExecArray | RegExpMatchArray): string {
  return (match[2] ?? match[3] ?? "").trim();
}

export function formatComposerMentionToken(path: string): string {
  const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
  return /\s/.test(normalizedPath) ? `@"${normalizedPath}"` : `@${normalizedPath}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function promptIncludesSkillMention(
  prompt: string,
  skillName: string,
  provider: string,
): boolean {
  const escapedSkillName = escapeRegExp(skillName);
  const prefixes = provider === "pi" ? ["/skill:"] : ["/", "$"];
  return prefixes.some((prefix) => {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(prefix)}${escapedSkillName}(?=\\s|$)`, "i");
    return pattern.test(prompt);
  });
}

export function filterPromptSkillReferences(
  prompt: string,
  skills: ReadonlyArray<ProviderSkillReference>,
  provider: string,
): ProviderSkillReference[] {
  return skills.filter((skill) => promptIncludesSkillMention(prompt, skill.name, provider));
}

function normalizeMentionNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function collectProviderMentionTokenKeys(mention: ProviderMentionReference): Set<string> {
  const keys = new Set<string>();
  const normalizedName = normalizeMentionNameKey(mention.name);
  if (normalizedName.length > 0) {
    keys.add(normalizedName);
  }

  const normalizedPath = normalizeMentionNameKey(mention.path);
  if (normalizedPath.length > 0) {
    keys.add(normalizedPath);
  }

  if (normalizedPath.startsWith("plugin://")) {
    const pluginSpecifier = normalizedPath.slice("plugin://".length);
    if (pluginSpecifier.length > 0) {
      keys.add(pluginSpecifier);
      const pluginName = pluginSpecifier.split("@")[0] ?? "";
      if (pluginName.length > 0) {
        keys.add(pluginName);
      }
    }
  }

  return keys;
}

export function providerMentionMatchesToken(
  mention: ProviderMentionReference,
  token: string,
): boolean {
  const normalizedToken = normalizeMentionNameKey(token);
  return (
    normalizedToken.length > 0 && collectProviderMentionTokenKeys(mention).has(normalizedToken)
  );
}

export type MentionChipKind = "path" | "plugin";

export function isPluginProviderMentionReference(mention: ProviderMentionReference): boolean {
  return mention.path.startsWith("plugin://");
}

export function resolveMentionChipKind(
  path: string,
  options?: {
    kind?: MentionChipKind;
    mentionReferences?: ReadonlyArray<ProviderMentionReference>;
  },
): MentionChipKind {
  if (options?.kind === "plugin" || path.startsWith("plugin://")) {
    return "plugin";
  }
  if (
    options?.mentionReferences?.some(
      (mention) =>
        isPluginProviderMentionReference(mention) &&
        providerMentionMatchesToken(mention, path),
    )
  ) {
    return "plugin";
  }
  return "path";
}

const PROMPT_MENTION_NAME_REGEX = createComposerMentionTokenRegex({
  includeTrailingTokenAtEnd: true,
});

function collectPromptMentionNameKeys(prompt: string): Set<string> {
  const names = new Set<string>();
  for (const match of prompt.matchAll(PROMPT_MENTION_NAME_REGEX)) {
    const mentionName = extractComposerMentionPath(match);
    if (mentionName.length > 0) {
      names.add(normalizeMentionNameKey(mentionName));
    }
  }
  return names;
}

export function filterPromptProviderMentionReferences(
  prompt: string,
  mentions: ReadonlyArray<ProviderMentionReference>,
): ProviderMentionReference[] {
  const promptMentionNames = collectPromptMentionNameKeys(prompt);
  if (promptMentionNames.size === 0) {
    return [];
  }

  const seenPaths = new Set<string>();
  const matchedMentions: ProviderMentionReference[] = [];
  for (const mention of mentions) {
    const mentionKeys = collectProviderMentionTokenKeys(mention);
    if (!Array.from(mentionKeys).some((key) => promptMentionNames.has(key))) {
      continue;
    }
    if (seenPaths.has(mention.path)) {
      continue;
    }
    seenPaths.add(mention.path);
    matchedMentions.push(mention);
  }
  return matchedMentions;
}
