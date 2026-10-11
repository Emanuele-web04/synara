// FILE: claudeAgentSdk.ts
// Purpose: Single memoized loader for the Claude Agent SDK runtime values.
// Layer: Provider shared helper
// Exports: ClaudeAgentSdkModule, loadClaudeAgentSdk

import { lazyModule } from "../lazyModule.ts";

export type ClaudeAgentSdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

/**
 * Loads `@anthropic-ai/claude-agent-sdk` on first use. Importing it eagerly
 * costs ~26ms on every server boot, including boots that never touch a Claude
 * session, so every consumer (adapter, health probe, thread import) shares this
 * one loader instead of a top-level import.
 *
 * Types must keep using `import type` — they are erased and cost nothing.
 */
export const loadClaudeAgentSdk: () => Promise<ClaudeAgentSdkModule> = lazyModule(
  () => import("@anthropic-ai/claude-agent-sdk"),
);
