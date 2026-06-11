/**
 * GeminiAdapter.config - Module-scope constants for the Gemini provider adapter.
 *
 * Purpose: provider id, ACP timeouts, Gemini temp/settings directory paths, and
 * thinking level/budget option lists. No runtime logic.
 *
 * @module GeminiAdapter.config
 */
import os from "node:os";
import path from "node:path";

import type { GeminiThinkingBudget, GeminiThinkingLevel } from "@t3tools/contracts";

export const PROVIDER = "gemini" as const;
export const GEMINI_ACP_REQUEST_TIMEOUT_MS = 60_000;
export const GEMINI_ACP_PROMPT_TIMEOUT_MS = 30 * 60_000;
export const GEMINI_TMP_DIR = path.join(os.homedir(), ".gemini", "tmp");
export const GEMINI_CHAT_DIR_NAME = "chats";
export const GEMINI_SESSION_FILE_PREFIX = "session-";
export const SYNARA_GEMINI_SETTINGS_DIR = path.join(os.tmpdir(), "synara", "gemini");
export const GEMINI_3_THINKING_LEVELS: ReadonlyArray<GeminiThinkingLevel> = ["HIGH", "LOW"];
export const GEMINI_2_5_THINKING_BUDGETS: ReadonlyArray<GeminiThinkingBudget> = [-1, 512, 0];
