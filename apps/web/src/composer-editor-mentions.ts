import { isBuiltInComposerSlashCommand } from "./composerSlashCommands";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import {
  createComposerMentionTokenRegex,
  extractComposerMentionPath,
} from "./lib/composerMentions";
import { resolveAgentAlias } from "@t3tools/contracts";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
    }
  | {
      type: "skill";
      name: string;
      prefix?: string;
    }
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    }
  | {
      /** Agent mention: @alias - chip for subagent reference (parens are plain text) */
      type: "agent-mention";
      alias: string;
      color: string;
    };

const SKILL_TOKEN_REGEX = /(^|\s)([$/])([a-zA-Z][a-zA-Z0-9_:-]*)(?=\s)/g;
const DISPLAY_SKILL_TOKEN_REGEX = /(^|\s)([$/])([a-zA-Z][a-zA-Z0-9_:-]*)(?=\s|$)/g;

// Agent mention chip: @alias(
// Keep plain @alias text editable while typing so the picker can stay open.
const AGENT_MENTION_TOKEN_REGEX = /(^|\s)@([a-zA-Z0-9._-]+)(?=\()/g;

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

type InlineTokenMatch =
  | {
      kind: "mention" | "skill";
      value: string;
      skillPrefix?: string;
      start: number;
      end: number;
    }
  | {
      kind: "agent-mention";
      alias: string;
      color: string;
      start: number;
      end: number;
    };

function collectInlineTokenMatches(
  text: string,
  options: {
    includeTrailingTokenAtEnd: boolean;
  },
): InlineTokenMatch[] {
  const matches: InlineTokenMatch[] = [];
  const mentionRegex = createComposerMentionTokenRegex({
    includeTrailingTokenAtEnd: options.includeTrailingTokenAtEnd,
  });
  const skillRegex = options.includeTrailingTokenAtEnd
    ? DISPLAY_SKILL_TOKEN_REGEX
    : SKILL_TOKEN_REGEX;

  // Track positions covered by agent mentions to avoid double-matching
  const agentMentionRanges: Array<{ start: number; end: number }> = [];

  // First, match agent mentions: @alias (just the alias, parens are plain text)
  for (const match of text.matchAll(AGENT_MENTION_TOKEN_REGEX)) {
    const whitespace = match[1] ?? "";
    const alias = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const start = matchIndex + whitespace.length;
    const end = start + 1 + alias.length; // @alias

    // Try to resolve the alias
    const resolved = resolveAgentAlias(alias);
    if (!resolved) {
      // Not a valid agent alias, skip - will be handled as regular mention
      continue;
    }

    agentMentionRanges.push({ start, end });

    matches.push({
      kind: "agent-mention",
      alias,
      color: resolved.color,
      start,
      end,
    });
  }

  // Helper to check if a position is inside an agent mention
  const isInsideAgentMention = (pos: number): boolean =>
    agentMentionRanges.some((range) => pos >= range.start && pos < range.end);

  for (const match of text.matchAll(mentionRegex)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const path = extractComposerMentionPath(match);
    const matchIndex = match.index ?? 0;
    const start = matchIndex + prefix.length;
    const end = start + fullMatch.length - prefix.length;

    // Skip if this overlaps with an agent mention
    if (isInsideAgentMention(start)) continue;

    if (path.length > 0) {
      matches.push({ kind: "mention", value: path, start, end });
    }
  }

  for (const match of text.matchAll(skillRegex)) {
    const fullMatch = match[0];
    const whitespace = match[1] ?? "";
    const skillPrefix = match[2] ?? "$";
    const name = match[3] ?? "";
    const matchIndex = match.index ?? 0;
    const start = matchIndex + whitespace.length;
    const end = start + fullMatch.length - whitespace.length;

    // Skip if this overlaps with an agent mention
    if (isInsideAgentMention(start)) continue;

    // Skip built-in slash commands so `/clear`, `/plan` etc. stay as plain text.
    if (name.length > 0 && !(skillPrefix === "/" && isBuiltInComposerSlashCommand(name))) {
      matches.push({ kind: "skill", value: name, skillPrefix, start, end });
    }
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function splitTextIntoPromptSegments(
  text: string,
  options: {
    includeTrailingTokenAtEnd: boolean;
  },
): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  const matches = collectInlineTokenMatches(text, options);
  let cursor = 0;

  for (const match of matches) {
    if (match.start < cursor) continue;

    if (match.start > cursor) {
      pushTextSegment(segments, text.slice(cursor, match.start));
    }

    if (match.kind === "agent-mention") {
      segments.push({
        type: "agent-mention",
        alias: match.alias,
        color: match.color,
      });
    } else if (match.kind === "mention") {
      segments.push({ type: "mention", path: match.value });
    } else {
      const skillSegment: ComposerPromptSegment = match.skillPrefix
        ? { type: "skill", name: match.value, prefix: match.skillPrefix }
        : { type: "skill", name: match.value };
      segments.push(skillSegment);
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function splitPromptIntoDisplaySegments(prompt: string): ComposerPromptSegment[] {
  return splitTextIntoPromptSegments(prompt, {
    includeTrailingTokenAtEnd: true,
  });
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const segments: ComposerPromptSegment[] = [];
  let textCursor = 0;
  let terminalContextIndex = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (index > textCursor) {
      segments.push(
        ...splitTextIntoPromptSegments(prompt.slice(textCursor, index), {
          includeTrailingTokenAtEnd: false,
        }),
      );
    }
    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextIndex] ?? null,
    });
    terminalContextIndex += 1;
    textCursor = index + 1;
  }

  if (textCursor < prompt.length) {
    segments.push(
      ...splitTextIntoPromptSegments(prompt.slice(textCursor), {
        includeTrailingTokenAtEnd: false,
      }),
    );
  }

  return segments;
}
