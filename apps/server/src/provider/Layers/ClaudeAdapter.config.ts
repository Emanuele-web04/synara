// Purpose: Static adapter constants for the Claude Agent provider.
// Layer: pure constants — no Effect, no runtime state.
// Exports: PROVIDER tag, supported image mime types, setting sources, embedded system-prompt append.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";

export const PROVIDER = "claudeAgent" as const;

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

export const EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND = [
  "You are running inside Synara, a coding app that embeds the Claude Agent SDK.",
  "Do not present the host app as Claude Code unless the user is explicitly asking about Claude Code.",
  "Treat the current working directory as the active workspace for the task.",
  "When the user asks about the current project, codebase, or repository, proactively inspect files in the current working directory before asking the user where to look.",
].join("\n");
